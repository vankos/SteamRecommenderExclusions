// ==UserScript==
// @name         Steam Recommender — save "Your Playtime" exclusions (min)
// @namespace    steamrec
// @version      2.1.0
// @description  Remembers Exclude/Include choices in "Your Playtime" on the Steam Interactive Recommender and re-applies them after reload.
// @match        https://store.steampowered.com/recommender*
// @include      https://store.steampowered.com/recommender*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[SteamRec]';
  const KEY = 'steamrec.excluded.v1.';
  const DEBUG = /[?&]steamrec_debug=1(?:&|$)/.test(location.search);

  let steamId = null;
  let storageKey = null;
  let saved = new Map(); // appid -> true (excluded) / false (explicitly included)
  let autoClick = false;
  let syncTimer = 0;
  let lastError = null;

  function log(...args) {
    console.log(LOG, ...args);
  }

  function fail(where, error) {
    lastError = where + ': ' + ((error && error.message) || error);
    console.warn(LOG, where, error);
  }

  // ---------------------------------------------------------------------------
  // Account + storage
  // ---------------------------------------------------------------------------

  function detectSteamId() {
    const el = document.getElementById('application_config');
    let config = null;

    if (el) {
      try {
        config = JSON.parse(el.getAttribute('data-config') || '{}') || {};
      } catch (e) {
        fail('parse config', e);
      }
    }

    if (config) {
      const id = config.STEAM_ID || config.steamid || config.steam_id || config.STEAMID;
      if (id) return String(id);
    }

    const pathMatch = location.pathname.match(/\/recommender\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    const query = new URLSearchParams(location.search);
    const id = query.get('steamid') || query.get('steam_id') || query.get('steamid64');

    return id && /^\d+$/.test(id) ? id : null;
  }

  function load() {
    const id = detectSteamId();
    if (!id) {
      log('no SteamID found');
      return false;
    }

    if (steamId === id) return true;

    steamId = id;
    storageKey = KEY + id;
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
    return Array.from(row.classList).some((name) =>
      /(^|_)Ignored(_|$)/.test(name)
    );
  }

  function getToggle(row) {
    return row.querySelector('[class*="IgnoreToggle"]');
  }

  function getList() {
    return document.querySelector('[class*="PlaytimeList"]');
  }

  function getRows(list) {
    return list ? Array.from(list.querySelectorAll('[class*="PlayedGame"]')) : [];
  }

  function sync() {
    if (!load()) {
      renderBadge('SteamRec: no SteamID');
      return;
    }

    const list = getList();
    if (!list) {
      renderBadge('SteamRec: waiting for list…');
      return;
    }

    const rows = getRows(list);
    if (!rows.length) {
      renderBadge('SteamRec: list is empty');
      return;
    }

    // Apply one saved choice per pass. Clicking a toggle re-renders the list,
    // and the MutationObserver calls sync() again for the next one.
    for (const row of rows) {
      const appid = getAppId(row);
      if (!appid || !saved.has(appid)) continue;

      const want = saved.get(appid);
      if (want === isIgnored(row)) continue;

      const toggle = getToggle(row);
      if (!toggle) continue;

      log('auto-click', { appid, want });
      autoClick = true;
      try {
        toggle.click();
      } finally {
        autoClick = false;
      }
      break;
    }

    renderBadge('SteamRec: ' + rows.filter(isIgnored).length + ' excluded');
  }

  function scheduleSync() {
    if (syncTimer) return;

    syncTimer = setTimeout(() => {
      syncTimer = 0;
      sync();
    }, 80);
  }

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

      if (autoClick) return;

      const want = !isIgnored(row);
      log('click', { appid, want });

      saved.set(appid, want);
      persist();
      setTimeout(sync, 0);
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Badge + debug
  // ---------------------------------------------------------------------------

  function renderBadge(text) {
    let badge = document.getElementById('steamrec-badge');

    if (!badge) {
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
      (document.body || document.documentElement).appendChild(badge);
    }

    badge.textContent = text;

    if (DEBUG) {
      let panel = document.getElementById('steamrec-debug');
      if (!panel) {
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
        (document.body || document.documentElement).appendChild(panel);
      }

      const list = getList();
      const rows = getRows(list);
      const report = {
        url: location.href,
        steamId,
        storageKey,
        saved: Object.fromEntries(saved),
        listFound: !!list,
        rows: rows.length,
        ignoredRows: rows.filter(isIgnored).length,
        lastError,
      };

      panel.textContent = JSON.stringify(report, null, 2);
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    log('boot', { url: location.href });

    load();
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
        renderBadge('SteamRec: list not found');
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
