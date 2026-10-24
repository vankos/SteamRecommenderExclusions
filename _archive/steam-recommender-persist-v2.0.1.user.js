// ==UserScript==
// @name         Steam Recommender — persistent "Your Playtime" exclusions
// @namespace    steamrec
// @version      2.0.1
// @description  Remembers Exclude/Include choices in "Your Playtime" on the Steam Interactive Recommender and re-applies them after reload.
// @author       Ivan
// @match        https://store.steampowered.com/recommender*
// @include      https://store.steampowered.com/recommender*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[SteamRec]';
  const PREFIX = 'steamrec.excluded.v1.';
  const DEBUG = /[?&]steamrec_debug=1(?:&|$)/.test(location.search);

  let steamId = null;
  let storageKey = null;
  let saved = new Map(); // appid -> true (excluded) / false (explicitly included)
  let lastAutoClick = 0;
  let programmaticClick = false;
  let listObserver = null;
  let observedList = null;
  let syncTimer = 0;
  let lastError = null;
  let stats = { listFound: false, rows: 0, ignoredRows: 0, clicks: 0, autoClicks: 0 };

  function log(...args) {
    console.log(LOG, ...args);
  }

  function fail(where, error) {
    lastError = where + ': ' + ((error && error.message) || error);
    console.warn(LOG, where, error);
  }

  // ---------------------------------------------------------------------------
  // Config and storage
  // ---------------------------------------------------------------------------

  function readConfig() {
    const el = document.getElementById('application_config');
    if (!el) return null;

    try {
      return JSON.parse(el.getAttribute('data-config') || '{}') || {};
    } catch (e) {
      fail('parse config', e);
      return null;
    }
  }

  function detectSteamId() {
    const config = readConfig();
    if (config) {
      const id = config.STEAM_ID || config.steamid || config.steam_id || config.STEAMID;
      if (id) return String(id);
    }

    const pathMatch = location.pathname.match(/\/recommender\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    const query = new URLSearchParams(location.search);
    const id = query.get('steamid') || query.get('steam_id') || query.get('steamid64');
    if (id && /^\d+$/.test(id)) return id;

    // Last resort: Steam stores the logged-in SteamID at the start of this cookie.
    try {
      const cookie = document.cookie.match(/(?:^|;\s*)steamLoginSecure=([^;]+)/);
      if (cookie) {
        const value = decodeURIComponent(cookie[1]).split('||')[0];
        if (/^\d+$/.test(value)) return value;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  function loadSaved() {
    const sid = detectSteamId();
    if (!sid) {
      log('no SteamID found');
      return false;
    }

    if (steamId === sid) return true;

    steamId = sid;
    storageKey = PREFIX + sid;
    saved = new Map();

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [appid, value] of Object.entries(parsed)) {
            if (value === true || value === false) saved.set(String(appid), value);
          }
        }
      }
    } catch (e) {
      fail('read storage', e);
    }

    log('loaded', { steamId, storageKey, saved: saved.size });
    return true;
  }

  function persist() {
    if (!storageKey) return;

    const plain = {};
    for (const [appid, value] of saved) plain[appid] = value;

    try {
      localStorage.setItem(storageKey, JSON.stringify(plain));
      log('saved', { storageKey, saved: saved.size });
    } catch (e) {
      fail('write storage', e);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM
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

  function isIgnored(row) {
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
    const toggle = row.querySelector('[class*="IgnoreToggle"]');
    if (toggle) return toggle;

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

  function getList() {
    return document.querySelector('[class*="PlaytimeList"]');
  }

  function getRows(list) {
    return list ? Array.from(list.querySelectorAll('[class*="PlayedGame"]')) : [];
  }

  function attachObserver(list) {
    if (!list || list === observedList) return;

    if (listObserver) listObserver.disconnect();

    observedList = list;
    listObserver = new MutationObserver(scheduleSync);
    listObserver.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function scheduleSync() {
    if (syncTimer) return;

    syncTimer = setTimeout(() => {
      syncTimer = 0;
      sync();
    }, 80);
  }

  function sync() {
    if (!loadSaved()) return;

    const list = getList();
    if (!list) {
      render();
      return;
    }

    attachObserver(list);

    const rows = getRows(list);
    stats.listFound = rows.length > 0;
    stats.rows = rows.length;

    if (!rows.length) {
      render();
      return;
    }

    for (const row of rows) {
      const appid = getAppId(row);
      if (!appid || !saved.has(appid)) continue;

      const want = saved.get(appid);
      const now = isIgnored(row);
      if (want === now) continue;

      const toggle = getToggle(row);
      if (!toggle) continue;

      if (Date.now() - lastAutoClick < 300) continue;
      lastAutoClick = Date.now();
      stats.autoClicks++;

      log('auto-click', { appid, want });
      programmaticClick = true;
      try {
        toggle.click();
      } finally {
        programmaticClick = false;
      }

      // The click re-renders the list; let the observer call sync() again
      // for the next saved game instead of clicking detached rows.
      break;
    }

    render();
  }

  // Remember real user clicks.
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
      const wasIgnored = isIgnored(row);
      const want = !wasIgnored;

      stats.clicks++;
      log('click', { appid, wasIgnored, want, fromScript });

      if (!fromScript) {
        saved.set(appid, want);
        persist();
      }

      setTimeout(() => {
        if (!fromScript) sync();
        else render();
      }, 0);
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Badge and debug panel
  // ---------------------------------------------------------------------------

  function getReport() {
    const list = getList();
    const rows = getRows(list);

    return {
      url: location.href,
      steamId,
      storageKey,
      saved: Object.fromEntries(saved),
      listFound: stats.listFound,
      rows: rows.length,
      ignoredRows: rows.filter(isIgnored).length,
      clicks: stats.clicks,
      autoClicks: stats.autoClicks,
      lastError,
    };
  }

  function ensureBadge() {
    let badge = document.getElementById('steamrec-badge');
    if (badge) return badge;

    badge = document.createElement('div');
    badge.id = 'steamrec-badge';
    badge.style.cssText = [
      'position:fixed',
      'left:14px',
      'bottom:14px',
      'z-index:2147483000',
      'padding:6px 9px',
      'border:1px solid #2a3f5a',
      'border-radius:4px',
      'background:rgba(23,26,33,.94)',
      'color:#c7d5e0',
      'font:12px/1.4 "Motiva Sans",Arial,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.45)',
      'user-select:none',
    ].join(';');

    const text = document.createElement('span');
    text.id = 'steamrec-badge-text';

    const reset = document.createElement('button');
    reset.id = 'steamrec-badge-reset';
    reset.type = 'button';
    reset.textContent = 'reset';
    reset.title = 'Forget the exclusions saved by this script for this Steam account';
    reset.style.cssText =
      'all:unset;cursor:pointer;color:#66c0f4;text-decoration:underline;font:inherit;margin-left:8px;';

    let armedUntil = 0;
    reset.addEventListener('click', () => {
      if (!saved.size) return;

      const now = Date.now();
      if (now > armedUntil) {
        armedUntil = now + 3000;
        reset.textContent = 'sure?';
        setTimeout(() => {
          if (Date.now() >= armedUntil) reset.textContent = 'reset';
        }, 3100);
        return;
      }

      saved.clear();
      persist();
      location.reload();
    });

    badge.appendChild(text);
    badge.appendChild(reset);
    (document.body || document.documentElement).appendChild(badge);
    return badge;
  }

  function ensureDebugPanel() {
    if (!DEBUG) return null;

    let panel = document.getElementById('steamrec-debug');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'steamrec-debug';
    panel.style.cssText = [
      'position:fixed',
      'left:14px',
      'bottom:56px',
      'z-index:2147483001',
      'width:430px',
      'max-height:45vh',
      'overflow:auto',
      'padding:8px',
      'border:1px solid #2a3f5a',
      'border-radius:4px',
      'background:rgba(10,14,20,.96)',
      'color:#c7d5e0',
      'font:11px/1.4 Consolas,monospace',
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
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(pre.textContent || '').then(() => {
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
    rescan.addEventListener('click', () => sync());

    panel.appendChild(pre);
    panel.appendChild(copy);
    panel.appendChild(rescan);
    (document.body || document.documentElement).appendChild(panel);

    return panel;
  }

  function render() {
    const badge = ensureBadge();
    const text = badge.querySelector('#steamrec-badge-text');
    const list = getList();
    const rows = getRows(list);
    const ignored = rows.filter(isIgnored).length;

    let label;
    if (!list) {
      label = 'SteamRec: waiting for list…';
    } else if (!rows.length) {
      label = 'SteamRec: list is empty';
    } else {
      label = 'SteamRec: ' + ignored + ' excluded';
    }

    if (text) text.textContent = label;

    if (DEBUG) {
      const panel = ensureDebugPanel();
      const pre = panel && panel.querySelector('#steamrec-debug-pre');
      if (pre) pre.textContent = JSON.stringify(getReport(), null, 2);
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    log('boot', { url: location.href });

    loadSaved();
    render();
    sync();

    setTimeout(sync, 300);
    setTimeout(sync, 1000);
    setTimeout(sync, 3000);

    setTimeout(() => {
      if (!getList()) {
        log('list not found after 6s', {
          root: !!document.getElementById('recommender_root'),
          lists: document.querySelectorAll('[class*="PlaytimeList"]').length,
        });
        render();
      }
    }, 6000);

    new MutationObserver(scheduleSync).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener('storage', (event) => {
      if (storageKey && event.key === storageKey) {
        steamId = null; // force reload
        sync();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
