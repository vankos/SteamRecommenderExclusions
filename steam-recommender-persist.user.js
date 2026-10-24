// ==UserScript==
// @name         Steam Recommender — persistent "Your Relevant Playtime" exclusions
// @namespace    steamrec
// @version      3.0.0
// @description  Remembers Exclude/Include choices in "Your Relevant Playtime" on the Steam Interactive Recommender and re-applies them after reload.
// @author       Ivan
// @match        https://store.steampowered.com/recommender*
// @include      https://store.steampowered.com/recommender*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[SteamRec]';
  const KEY_PREFIX = 'steamrec.excluded.v2.';
  const DEBUG = /[?&]steamrec_debug=1(?:&|$)/.test(location.search);
  const ACTION_RE = /^(exclude|include|исключить|включить)$/i;

  let accountKey = null;
  let storageKey = null;
  let saved = new Map(); // appid -> true (excluded) / false (explicitly included)
  let programmaticClick = false;
  let lastAutoClick = 0;
  let syncTimer = 0;
  let lastError = null;

  const stats = {
    buttons: 0,
    mapped: 0,
    unmapped: 0,
    excluded: 0,
    clicks: 0,
    autoClicks: 0,
  };

  function log(...args) {
    console.log(LOG, ...args);
  }

  function fail(where, error) {
    lastError = where + ': ' + ((error && error.message) || error);
    console.warn(LOG, where, error);
  }

  // ---------------------------------------------------------------------------
  // Finding the Exclude / Include buttons and their game rows
  // ---------------------------------------------------------------------------

  function isActionButton(el) {
    return (
      el &&
      el.tagName === 'BUTTON' &&
      ACTION_RE.test((el.textContent || '').trim())
    );
  }

  function getActionButtons() {
    return Array.from(document.querySelectorAll('button')).filter(isActionButton);
  }

  function appIdFromHref(href) {
    const match = String(href || '').match(/\/app\/(\d+)/);
    return match ? match[1] : null;
  }

  function appIdFromSrc(src) {
    const match = String(src || '').match(/\/apps\/(\d+)\//);
    return match ? match[1] : null;
  }

  /**
   * Walk up from the button until an ancestor contains exactly one game.
   * The first such ancestor is the row; if we reach an ancestor with several
   * games, we've climbed past the row into the list.
   */
  function findRow(button) {
    let el = button;

    for (let depth = 0; depth < 12 && el; depth++, el = el.parentElement) {
      const ids = new Set();

      for (const link of el.querySelectorAll('a[href*="/app/"]')) {
        const appid = appIdFromHref(link.getAttribute('href'));
        if (appid) ids.add(appid);
      }

      for (const img of el.querySelectorAll('img[src*="/apps/"]')) {
        const appid = appIdFromSrc(img.getAttribute('src'));
        if (appid) ids.add(appid);
      }

      const dataAppid =
        el.getAttribute('data-appid') || el.getAttribute('data-app-id');
      if (dataAppid && /^\d+$/.test(dataAppid)) ids.add(dataAppid);

      // Last resort: the row may use a CSS background-image or a data attribute
      // instead of an <img>/<a>. Look for /apps/<id>/ or /app/<id> in the HTML.
      if (ids.size === 0) {
        const html = el.outerHTML || '';
        const re = /\/(?:apps|app)\/(\d+)(?:\/|["'?])/g;
        let match;
        while ((match = re.exec(html))) ids.add(match[1]);
      }

      if (ids.size === 1) {
        return { row: el, appid: Array.from(ids)[0] };
      }

      if (ids.size > 1) {
        // We've reached the list, not a single row.
        return null;
      }
    }

    return null;
  }

  /** The button label is the action: "Include" means the game is excluded. */
  function buttonExcluded(button) {
    return /^(include|включить)$/i.test((button.textContent || '').trim());
  }

  // ---------------------------------------------------------------------------
  // Account + storage
  // ---------------------------------------------------------------------------

  let cachedAccountKey = null;

  function getAccountKey() {
    if (cachedAccountKey) return cachedAccountKey;

    // Steam's page globals are the most reliable source.
    try {
      if (
        typeof window.g_steamID === 'string' &&
        /^\d{17}$/.test(window.g_steamID)
      ) {
        cachedAccountKey = window.g_steamID;
        return cachedAccountKey;
      }

      if (
        typeof window.g_AccountID === 'number' &&
        window.g_AccountID > 0
      ) {
        cachedAccountKey = 'account' + window.g_AccountID;
        return cachedAccountKey;
      }
    } catch {
      /* ignore */
    }

    for (const link of document.querySelectorAll('a[href*="/profiles/"]')) {
      const match = (link.getAttribute('href') || '').match(/\/profiles\/(\d+)/);
      if (match) {
        cachedAccountKey = match[1];
        return cachedAccountKey;
      }
    }

    for (const link of document.querySelectorAll('a[href*="/id/"]')) {
      const match = (link.getAttribute('href') || '').match(/\/id\/([^/?#]+)/);
      if (match) {
        cachedAccountKey = match[1];
        return cachedAccountKey;
      }
    }

    return 'default';
  }

  function loadSaved() {
    const key = getAccountKey();

    if (accountKey === key && storageKey) return true;

    accountKey = key;
    storageKey = KEY_PREFIX + key;
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

    log('loaded', { accountKey, storageKey, saved: saved.size });
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
  // Applying saved choices
  // ---------------------------------------------------------------------------

  function sync() {
    if (!loadSaved()) return;

    const buttons = getActionButtons();
    stats.buttons = buttons.length;
    stats.mapped = 0;
    stats.unmapped = 0;

    for (const button of buttons) {
      const found = findRow(button);

      if (!found) {
        stats.unmapped++;
        continue;
      }

      stats.mapped++;

      if (!saved.has(found.appid)) continue;

      const want = saved.get(found.appid);
      const current = buttonExcluded(button);
      if (want === current) continue;

      // One click per pass: the page re-renders, then the observer calls sync().
      if (Date.now() - lastAutoClick < 300) continue;
      lastAutoClick = Date.now();
      stats.autoClicks++;

      log('auto-click', { appid: found.appid, want, current });

      programmaticClick = true;
      try {
        button.click();
      } finally {
        programmaticClick = false;
      }

      break;
    }

    stats.excluded = buttons.filter(buttonExcluded).length;
    render();
  }

  function scheduleSync() {
    if (syncTimer) return;

    syncTimer = setTimeout(() => {
      syncTimer = 0;
      sync();
    }, 80);
  }

  // Remember real user clicks.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const button = target.closest('button');
      if (!button || !isActionButton(button)) return;
      if (programmaticClick) return;

      const found = findRow(button);
      if (!found) {
        log('click without appid', {
          button: button.outerHTML.slice(0, 300),
        });
        return;
      }

      const current = buttonExcluded(button);
      const want = !current;

      stats.clicks++;
      saved.set(found.appid, want);
      persist();

      log('click', { appid: found.appid, current, want });

      setTimeout(sync, 0);
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Badge + debug panel
  // ---------------------------------------------------------------------------

  function sampleAncestors(button) {
    const chain = [];
    let el = button;

    for (let depth = 0; depth < 10 && el; depth++, el = el.parentElement) {
      chain.push({
        depth,
        tag: el.tagName,
        id: el.id || '',
        cls: typeof el.className === 'string' ? el.className : '',
        kids: el.children.length,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }

    return chain;
  }

  function getReport() {
    const buttons = getActionButtons();
    const mapped = [];
    let firstUnmapped = null;

    for (const button of buttons) {
      const found = findRow(button);
      if (found) mapped.push({ appid: found.appid, excluded: buttonExcluded(button) });
      else if (!firstUnmapped) firstUnmapped = button;
    }

    return {
      url: location.href,
      accountKey,
      storageKey,
      buttons: buttons.length,
      mapped: mapped.length,
      unmapped: buttons.length - mapped.length,
      excluded: buttons.filter(buttonExcluded).length,
      saved: Object.fromEntries(saved),
      clicks: stats.clicks,
      autoClicks: stats.autoClicks,
      lastError,
      unmappedSample: firstUnmapped ? sampleAncestors(firstUnmapped) : null,
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
    reset.title = 'Forget the exclusions saved by this script';
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
      'width:460px',
      'max-height:50vh',
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

    let label;
    if (stats.buttons === 0) {
      label = 'SteamRec: waiting for buttons…';
    } else if (stats.mapped === 0) {
      label = 'SteamRec: buttons found, no appid';
    } else {
      label = 'SteamRec: ' + stats.excluded + ' excluded';
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
      if (getActionButtons().length === 0) {
        log('no Exclude/Include buttons after 8s');
        render();
      }
    }, 8000);

    new MutationObserver(scheduleSync).observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled'],
    });

    window.addEventListener('storage', (event) => {
      if (storageKey && event.key === storageKey) {
        accountKey = null;
        cachedAccountKey = null;
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
