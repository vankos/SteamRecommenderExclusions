// ==UserScript==
// @name         Steam Recommender — persistent "Your Playtime" exclusions
// @namespace    https://store.steampowered.com/recommender/
// @version      1.1.0
// @description  Remembers games you exclude in "Your Playtime" on the Steam Interactive Recommender and re-applies them after a reload. Works entirely in your browser.
// @author       you
// @match        https://store.steampowered.com/recommender/*
// @match        https://store.steampowered.com/recommender
// @include      https://store.steampowered.com/recommender*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How Steam's page works (as of 2026):
 *
 *   GET  /recommender/<steamid>/inputs
 *        -> [ { a: appid, t: title, p: hours, l: lastPlayed, i: ignored, ip: ignoredPending }, ... ]
 *
 *   GET  /recommender/<steamid>/results?...&ignored=1,2,3
 *        -> recommendations; the "ignored" list is built from the inputs array.
 *
 * The Exclude/Include toggle only mutates that in-memory array (`i` / `ip`).
 * There is no autosave, so a reload throws the choices away.
 *
 * This script:
 *   1. Stores appid -> true/false in localStorage (per Steam account).
 *   2. Rewrites the `/inputs` JSON before the page reads it, so the UI renders
 *      the saved exclusions immediately and the page itself sends them in the
 *      `/results` request.
 *   3. Also merges the saved list into the `/results` URL (the page often fires
 *      the first results request before `/inputs` has arrived).
 *   4. Falls back to clicking the real Exclude/Include toggle if the response
 *      was already cached or Steam changed the request shape.
 */

(function () {
  'use strict';

  const LOG = '[SteamRec]';
  const STORAGE_PREFIX = 'steamrec.excluded.v1.';
  const INPUTS_RE = /\/recommender\/(\d+)\/inputs(?:[?#]|$)/i;
  const RESULTS_RE = /\/recommender\/(\d+)\/results(?:[?#]|$)/i;

  /** @type {Map<string, boolean>} appid -> true (excluded) / false (explicitly included) */
  let overrides = new Map();
  /** @type {Set<string>} exclusions already saved in Steam's own account settings */
  let defaultIgnored = new Set();

  let steamId = null;
  let storageKey = null;
  let configCache = null;

  /** True while syncDom() is clicking a toggle on the user's behalf. */
  let programmaticClick = false;

  /** appid -> timestamp of the last programmatic click, to avoid click loops. */
  const lastClickAt = new Map();

  const DEBUG = /[?&]steamrec_debug=1(?:&|$)/.test(location.search);
  const stats = {
    listFound: false,
    rows: 0,
    ignoredRows: 0,
    inputsHooks: 0,
    inputsPatched: 0,
    resultsRewritten: 0,
    clicks: 0,
  };
  let lastError = null;

  function log(...args) {
    console.log(LOG, ...args);
  }

  function noteError(where, error) {
    lastError = where + ': ' + ((error && error.message) || error);
    console.warn(LOG, where, error);
  }

  // ---------------------------------------------------------------------------
  // Config and storage
  // ---------------------------------------------------------------------------

  function readConfig() {
    if (configCache) return configCache;

    const el = document.getElementById('application_config');
    if (!el) return null;

    try {
      configCache = JSON.parse(el.getAttribute('data-config') || '{}') || {};
    } catch (e) {
      console.warn(LOG, 'could not parse #application_config', e);
      configCache = {};
    }

    const saved = configCache.DEFAULT_IGNORED_PLAYED_APPS;
    defaultIgnored = new Set(Array.isArray(saved) ? saved.map(String) : []);

    return configCache;
  }

  function getSteamId(config) {
    if (config) {
      const id = config.STEAM_ID || config.steamid || config.steam_id || config.STEAMID;
      if (id) return String(id);
    }

    const pathMatch = location.pathname.match(/\/recommender\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    const query = new URLSearchParams(location.search);
    const queryId =
      query.get('steamid') || query.get('steam_id') || query.get('steamid64');

    return queryId && /^\d+$/.test(queryId) ? queryId : null;
  }

  function ensureAccount(id) {
    const sid = String(id || '');
    if (!sid) return;
    if (steamId === sid && storageKey) return;

    steamId = sid;
    storageKey = STORAGE_PREFIX + sid;
    overrides = new Map();

    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        log('account', { steamId, storageKey, overrides: 0 });
        return;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      for (const [appid, value] of Object.entries(parsed)) {
        if (value === true || value === false) overrides.set(String(appid), value);
      }

      log('account', { steamId, storageKey, overrides: overrides.size });
    } catch (e) {
      noteError('read storage', e);
    }
  }

  function saveOverrides() {
    if (!storageKey) return;

    const plain = {};
    for (const [appid, value] of overrides) plain[appid] = value;

    try {
      localStorage.setItem(storageKey, JSON.stringify(plain));
      log('saved', { storageKey, overrides: overrides.size });
    } catch (e) {
      noteError('write storage', e);
    }
  }

  /** The state a game should have after applying saved choices. */
  function desiredIgnored(appid, current) {
    const id = String(appid);
    if (overrides.has(id)) return overrides.get(id);
    if (defaultIgnored.has(id)) return true;
    return current;
  }

  /** Merge the page's ignored list with saved choices. */
  function wantedIgnoredSet(existing) {
    const set = new Set(existing ? existing.map(String) : []);

    for (const id of defaultIgnored) set.add(id);

    for (const [id, want] of overrides) {
      if (want) set.add(id);
      else set.delete(id);
    }

    return set;
  }

  // ---------------------------------------------------------------------------
  // XHR response patching
  // ---------------------------------------------------------------------------

  function findDescriptor(proto, prop) {
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc) return desc;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  const XHRProto =
    typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype : null;
  const textDesc = XHRProto ? findDescriptor(XHRProto, 'responseText') : null;
  const responseDesc = XHRProto ? findDescriptor(XHRProto, 'response') : null;

  function isFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  /**
   * Apply saved choices to an `/inputs` payload in place.
   * Returns the same object when something changed, otherwise null.
   */
  function patchInputsObject(data) {
    if (!data) return null;

    let list = null;
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.apps)) list = data.apps;
    if (!list) return null;

    let changed = false;

    for (const app of list) {
      if (!app || typeof app !== 'object') continue;
      if (app.a === undefined || app.a === null) continue;

      const appid = String(app.a);
      const current = isFlag(app.i) || isFlag(app.ip);
      const want = desiredIgnored(appid, current);

      if (want === current) continue;

      if (want) {
        app.i = true;
        app.ip = true;
      } else {
        app.i = false;
        app.ip = false;
      }

      changed = true;
    }

    return changed ? data : null;
  }

  function patchInputsText(raw) {
    if (!raw) return raw;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }

    const patched = patchInputsObject(parsed);
    if (patched) {
      stats.inputsPatched++;
      log('inputs patched', { count: stats.inputsPatched });
      return JSON.stringify(parsed);
    }

    return raw;
  }

  function installInputsHook(xhr, sid) {
    if (xhr.__steamrecInputsHook) return;
    xhr.__steamrecInputsHook = true;

    readConfig();
    ensureAccount(sid);
    stats.inputsHooks++;
    log('inputs hook', { sid, count: stats.inputsHooks });

    // Without the native responseText getter we cannot patch the payload.
    // The DOM fallback in syncDom() still re-applies saved choices.
    if (!textDesc || !textDesc.get) return;

    let lastRaw = null;
    let lastPatched = null;

    function getPatchedText() {
      if (!textDesc || !textDesc.get) return '';

      let raw;
      try {
        raw = textDesc.get.call(xhr);
      } catch {
        return '';
      }

      if (raw === lastRaw) return lastPatched;

      lastRaw = raw;
      lastPatched = patchInputsText(raw);
      return lastPatched;
    }

    if (textDesc && textDesc.get) {
      try {
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          enumerable: true,
          get: getPatchedText,
        });
      } catch (e) {
        console.warn(LOG, 'could not hook responseText', e);
      }
    }

    if (responseDesc && responseDesc.get) {
      try {
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          enumerable: true,
          get() {
            const type = xhr.responseType;

            if (type === '' || type === 'text') return getPatchedText();

            let native;
            try {
              native = responseDesc.get.call(xhr);
            } catch {
              return null;
            }

            if (type === 'json') {
              return patchInputsObject(native) || native;
            }

            return native;
          },
        });
      } catch (e) {
        console.warn(LOG, 'could not hook response', e);
      }
    }
  }

  function rewriteResultsUrl(rawUrl, sid) {
    readConfig();
    ensureAccount(sid);

    if (!overrides.size && !defaultIgnored.size) return rawUrl;

    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return rawUrl;
    }

    const existing = (url.searchParams.get('ignored') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const wanted = wantedIgnoredSet(existing);
    const before = existing.join(',');
    const after = Array.from(wanted).join(',');

    if (before === after) return rawUrl;

    if (wanted.size) {
      url.searchParams.set('ignored', after);
    } else {
      url.searchParams.delete('ignored');
    }

    stats.resultsRewritten++;
    log('results rewritten', { count: stats.resultsRewritten, ignored: after });

    return url.pathname + url.search + url.hash;
  }

  if (XHRProto) {
    const originalOpen = XHRProto.open;

    XHRProto.open = function (method, url) {
      const args = Array.prototype.slice.call(arguments);

      try {
        const rawUrl = String(url);

        const inputsMatch = rawUrl.match(INPUTS_RE);
        if (inputsMatch) {
          installInputsHook(this, inputsMatch[1]);
        } else {
          const resultsMatch = rawUrl.match(RESULTS_RE);
          if (resultsMatch) {
            args[1] = rewriteResultsUrl(rawUrl, resultsMatch[1]);
          }
        }
      } catch (e) {
        noteError('open() hook', e);
      }

      return originalOpen.apply(this, args);
    };
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function getAppId(row) {
    const link = row.querySelector('a[href*="/app/"]');
    if (link) {
      const match = (link.getAttribute('href') || '').match(/\/app\/(\d+)/);
      if (match) return match[1];
    }

    const img = row.querySelector('img[src*="/apps/"]');
    if (img) {
      const match = (img.getAttribute('src') || '').match(/\/apps\/(\d+)\//);
      if (match) return match[1];
    }

    return null;
  }

  function localizedLabel(key) {
    try {
      const manager = window.LocalizationManager;
      if (manager && typeof manager.LocalizeString === 'function') {
        return (manager.LocalizeString(key) || '').trim();
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  function getToggle(row) {
    let toggle = row.querySelector('[class*="IgnoreToggle"]');
    if (toggle) return toggle;

    // Fallback for a renamed CSS module: find the element whose label is
    // Steam's own Exclude/Include string for the current language.
    const labels = new Set(
      [localizedLabel('#PlaytimeList_Ignore'), localizedLabel('#PlaytimeList_UnIgnore')]
        .filter(Boolean)
    );

    if (labels.size) {
      for (const el of row.querySelectorAll('div, span, a, button')) {
        if (labels.has((el.textContent || '').trim())) return el;
      }
    }

    return null;
  }

  function isIgnoredRow(row) {
    const hasIgnoredClass = Array.from(row.classList).some((name) =>
      /(^|_)Ignored(_|$)/.test(name)
    );
    if (hasIgnoredClass) return true;

    // Fallback: the toggle says "Include" only when the game is excluded.
    const toggle = getToggle(row);
    if (!toggle) return false;

    const label = (toggle.textContent || '').trim();
    const unignore = localizedLabel('#PlaytimeList_UnIgnore');

    return !!unignore && label === unignore;
  }

  function findRowByAppId(appid) {
    const list = document.querySelector('[class*="PlaytimeList"]');
    if (!list) return null;

    for (const row of list.querySelectorAll('[class*="PlayedGame"]')) {
      if (getAppId(row) === appid) return row;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Badge
  // ---------------------------------------------------------------------------

  function uiStrings() {
    const config = readConfig();
    const language = (config && config.LANGUAGE) || '';

    if (language === 'russian') {
      return {
        saved: (count) => 'Исключено игр: ' + count,
        waiting: 'SteamRec: ожидание списка…',
        noList: 'SteamRec: список не найден',
        reset: 'сброс',
        sure: 'точно?',
        resetTitle:
          'Нажмите дважды, чтобы удалить исключения, сохранённые этим скриптом для этого аккаунта Steam',
        badgeTitle:
          'Игры, исключённые в «Your Playtime», запоминаются в этом браузере ' +
          'и применяются после перезагрузки страницы.',
      };
    }

    return {
      saved: (count) => 'Saved exclusions: ' + count,
      waiting: 'SteamRec: waiting for list…',
      noList: 'SteamRec: list not found',
      reset: 'reset',
      sure: 'sure?',
      resetTitle:
        'Click twice to forget the exclusions saved by this script for this Steam account',
      badgeTitle:
        'Games excluded in "Your Playtime" are remembered in this browser ' +
        'and re-applied after a reload.',
    };
  }

  function ensureBadge() {
    let badge = document.getElementById('steamrec-badge');
    if (badge) return badge;

    const strings = uiStrings();

    badge = document.createElement('div');
    badge.id = 'steamrec-badge';
    badge.style.cssText = [
      'position:fixed',
      'left:14px',
      'bottom:14px',
      'z-index:2147483000',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:6px 9px',
      'border:1px solid #2a3f5a',
      'border-radius:4px',
      'background:rgba(23,26,33,.94)',
      'color:#c7d5e0',
      'font:12px/1.4 "Motiva Sans",Arial,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.45)',
      'user-select:none',
    ].join(';');

    const label = document.createElement('span');
    label.id = 'steamrec-badge-count';

    const reset = document.createElement('button');
    reset.id = 'steamrec-badge-reset';
    reset.type = 'button';
    reset.textContent = strings.reset;
    reset.title = strings.resetTitle;
    reset.style.cssText =
      'all:unset;cursor:pointer;color:#66c0f4;text-decoration:underline;font:inherit';

    badge.appendChild(label);
    badge.appendChild(reset);

    let resetArmedUntil = 0;

    reset.addEventListener('click', () => {
      if (!overrides.size) return;

      const now = Date.now();
      if (now > resetArmedUntil) {
        resetArmedUntil = now + 3000;
        reset.textContent = strings.sure;
        setTimeout(() => {
          if (Date.now() >= resetArmedUntil) reset.textContent = strings.reset;
        }, 3100);
        return;
      }

      overrides.clear();
      saveOverrides();
      location.reload();
    });

    (document.body || document.documentElement).appendChild(badge);
    return badge;
  }

  function updateBadge(count) {
    const badge = ensureBadge();
    const label = badge.querySelector('#steamrec-badge-count');
    if (!label) return;

    const strings = uiStrings();
    label.textContent = strings.saved(count);
    label.title = strings.badgeTitle;
  }

  function setBadgeText(text) {
    const badge = ensureBadge();
    const label = badge.querySelector('#steamrec-badge-count');
    if (label) label.textContent = text;
  }

  function getReport() {
    const list = document.querySelector('[class*="PlaytimeList"]');
    const rows = list
      ? Array.from(list.querySelectorAll('[class*="PlayedGame"]'))
      : [];

    return {
      url: location.href,
      configFound: !!readConfig(),
      steamId,
      storageKey,
      overrides: Object.fromEntries(overrides),
      defaults: Array.from(defaultIgnored),
      listFound: stats.listFound,
      rows: rows.length,
      ignoredRows: rows.filter(isIgnoredRow).length,
      inputsHooks: stats.inputsHooks,
      inputsPatched: stats.inputsPatched,
      resultsRewritten: stats.resultsRewritten,
      clicks: stats.clicks,
      lastError,
    };
  }

  function renderDebugPanel() {
    if (!DEBUG) return;

    let panel = document.getElementById('steamrec-debug');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'steamrec-debug';
      panel.style.cssText = [
        'position:fixed',
        'left:14px',
        'bottom:70px',
        'z-index:2147483001',
        'width:420px',
        'max-height:45vh',
        'overflow:auto',
        'background:rgba(10,14,20,.96)',
        'border:1px solid #2a3f5a',
        'border-radius:4px',
        'color:#c7d5e0',
        'font:11px/1.4 Consolas,monospace',
        'padding:8px',
      ].join(';');

      const pre = document.createElement('pre');
      pre.id = 'steamrec-debug-pre';
      pre.style.cssText = 'margin:0 0 6px;white-space:pre-wrap;word-break:break-all;';

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'copy report';
      copy.style.cssText =
        'all:unset;cursor:pointer;color:#66c0f4;text-decoration:underline;font:inherit;margin-right:10px;';
      copy.addEventListener('click', () => {
        const text = pre.textContent || '';
        if (!navigator.clipboard || !navigator.clipboard.writeText) return;
        navigator.clipboard.writeText(text).then(() => {
          copy.textContent = 'copied';
          setTimeout(() => {
            copy.textContent = 'copy report';
          }, 1500);
        });
      });

      const rescan = document.createElement('button');
      rescan.type = 'button';
      rescan.textContent = 'rescan';
      rescan.style.cssText = copy.style.cssText;
      rescan.addEventListener('click', () => syncDom());

      panel.appendChild(pre);
      panel.appendChild(copy);
      panel.appendChild(rescan);
      (document.body || document.documentElement).appendChild(panel);
    }

    const pre = panel.querySelector('#steamrec-debug-pre');
    if (pre) pre.textContent = JSON.stringify(getReport(), null, 2);
  }

  // ---------------------------------------------------------------------------
  // Keeping the DOM in sync
  // ---------------------------------------------------------------------------

  let listObserver = null;
  let observedList = null;
  let syncTimer = 0;

  function attachListObserver(list) {
    if (!list || list === observedList) return;

    if (listObserver) listObserver.disconnect();

    observedList = list;
    listObserver = new MutationObserver(scheduleSync);
    listObserver.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
    });
  }

  function scheduleSync() {
    if (syncTimer) return;

    syncTimer = setTimeout(() => {
      syncTimer = 0;
      syncDom();
    }, 80);
  }

  function syncDom() {
    const config = readConfig();
    const sid = getSteamId(config);
    if (sid) ensureAccount(sid);

    const list = document.querySelector('[class*="PlaytimeList"]');
    if (!list) return;

    attachListObserver(list);

    const rows = Array.from(list.querySelectorAll('[class*="PlayedGame"]'));
    if (!rows.length) return;

    if (!stats.listFound || stats.rows !== rows.length) {
      stats.listFound = true;
      stats.rows = rows.length;
      log('list found', { rows: rows.length, overrides: overrides.size });
    }

    ensureBadge();

    for (const row of rows) {
      const appid = getAppId(row);
      if (!appid) continue;

      const current = isIgnoredRow(row);
      const want = desiredIgnored(appid, current);
      if (want === current) continue;

      // Don't hammer the same toggle if Steam ignores the click for some reason.
      const now = Date.now();
      if (now - (lastClickAt.get(appid) || 0) < 600) continue;

      const toggle = getToggle(row);
      if (!toggle) continue;

      lastClickAt.set(appid, now);

      log('auto-click', { appid, want });

      programmaticClick = true;
      try {
        toggle.click();
      } finally {
        programmaticClick = false;
      }
    }

    // Let React flush the state update before counting.
    setTimeout(() => {
      if (!list.isConnected) return;
      const currentRows = Array.from(list.querySelectorAll('[class*="PlayedGame"]'));
      updateBadge(currentRows.filter(isIgnoredRow).length);
      renderDebugPanel();
    }, 30);
  }

  // Remember real user clicks (not the ones syncDom() makes).
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const toggle = target.closest('[class*="IgnoreToggle"]');
      if (!toggle) return;

      const row = toggle.closest('[class*="PlayedGame"]');
      if (!row) return;

      const appid = getAppId(row);
      if (!appid) return;

      const fromScript = programmaticClick;
      const wasIgnored = isIgnoredRow(row);
      const predicted = !wasIgnored;

      stats.clicks++;
      log('click', { appid, wasIgnored, predicted, fromScript });

      // Record the new state immediately: Steam sends its /results request
      // from the same click handler, and rewriteResultsUrl() must already see
      // the new choice. Verify the prediction in the next tick.
      if (!fromScript) {
        overrides.set(appid, predicted);
        saveOverrides();
      }

      setTimeout(() => {
        if (fromScript) return;

        // Steam/React may replace the whole row, so read the fresh node.
        const currentRow = findRowByAppId(appid);
        const actual = currentRow ? isIgnoredRow(currentRow) : predicted;

        if (actual !== predicted) {
          overrides.set(appid, actual);
          saveOverrides();
        }

        syncDom();
      }, 0);
    },
    true
  );

  // Catch the list being replaced by React.
  let bodyObserver = null;

  function startBodyObserver() {
    if (bodyObserver) return;

    bodyObserver = new MutationObserver(scheduleSync);
    bodyObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // Sync choices made in another tab.
  window.addEventListener('storage', (event) => {
    if (!storageKey || event.key !== storageKey) return;

    ensureAccount(steamId);
    syncDom();
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    const config = readConfig();
    const sid = getSteamId(config);
    if (sid) ensureAccount(sid);

    log('boot', {
      url: location.href,
      configFound: !!config,
      steamId: sid,
      storageKey,
      overrides: overrides.size,
      defaults: defaultIgnored.size,
    });

    startBodyObserver();
    setBadgeText(uiStrings().waiting);
    syncDom();
    renderDebugPanel();

    // The page loads its data asynchronously; retry a few times.
    setTimeout(syncDom, 200);
    setTimeout(syncDom, 800);
    setTimeout(syncDom, 2000);

    setTimeout(() => {
      if (!stats.listFound) {
        setBadgeText(uiStrings().noList);
        log('list not found after 6s', {
          root: !!document.getElementById('recommender_root'),
          lists: document.querySelectorAll('[class*="PlaytimeList"]').length,
          rows: document.querySelectorAll('[class*="PlayedGame"]').length,
        });
      }
    }, 6000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
