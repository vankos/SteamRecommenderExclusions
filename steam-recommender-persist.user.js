// ==UserScript==
// @name         Steam Recommender — persistent "Your Relevant Playtime" exclusions
// @namespace    steamrec
// @version      3.2.0
// @description  Remembers Exclude/Include choices in "Your Relevant Playtime" and the tag filters on the Steam Interactive Recommender, and re-applies them after reload.
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
  const TAG_KEY_PREFIX = 'steamrec.tags.v1.';
  const DEBUG = /[?&]steamrec_debug=1(?:&|$)/.test(location.search);
  const ACTION_RE = /^(exclude|include|исключить|включить)$/i;

  let accountKey = null;
  let storageKey = null;
  let saved = new Map(); // appid -> true (excluded) / false (explicitly included)
  let programmaticClick = false;
  let lastAutoClick = 0;
  let syncTimer = 0;
  let lastError = null;

  let tagAccountKey = null;
  let tagStorageKey = null;
  let savedTags = { filters: [], excludes: [] };
  let tagsReady = false;
  let tagsApplying = false;
  let lastChipClickAt = 0;
  let lastTagApplyAt = 0;

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
  // Tag filters (Add Tag Filters / Add Tag Exclusions)
  // ---------------------------------------------------------------------------

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, value);
  }

  function findTagBlocks() {
    let inputs = Array.from(
      document.querySelectorAll('input[placeholder]')
    ).filter((input) => /tag|тег/i.test(input.placeholder || ''));

    if (!inputs.length) {
      inputs = Array.from(
        document.querySelectorAll('input[aria-autocomplete="list"]')
      );
    }

    const blocks = { filters: null, excludes: null };

    for (const input of inputs) {
      const combobox = input.closest('div[role="combobox"]');
      const block = combobox
        ? combobox.parentElement
        : input.parentElement && input.parentElement.parentElement;

      if (!block) continue;

      const text = (block.textContent || '').toLowerCase();

      if (/add tag filters|tag filters|фильтр.*тег|теги.*фильтр/.test(text)) {
        blocks.filters = block;
      } else if (
        /add tag exclusions|tag exclusions|исключ.*тег|теги.*исключ/.test(text)
      ) {
        blocks.excludes = block;
      } else if (!blocks.filters) {
        blocks.filters = block;
      } else if (!blocks.excludes) {
        blocks.excludes = block;
      }
    }

    return blocks;
  }

  function readChips(block) {
    if (!block) return [];

    const names = [];
    for (const button of block.querySelectorAll('button')) {
      const name = (button.textContent || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function findTagBlockForElement(el) {
    if (!el) return null;

    const blocks = findTagBlocks();
    if (blocks.filters && blocks.filters.contains(el)) {
      return { kind: 'filters', block: blocks.filters };
    }
    if (blocks.excludes && blocks.excludes.contains(el)) {
      return { kind: 'excludes', block: blocks.excludes };
    }
    return null;
  }

  function loadTags() {
    const key = getAccountKey();

    if (tagAccountKey === key && tagStorageKey) return true;

    tagAccountKey = key;
    tagStorageKey = TAG_KEY_PREFIX + key;
    savedTags = { filters: [], excludes: [] };

    try {
      const raw = localStorage.getItem(tagStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          savedTags.filters = Array.isArray(parsed.filters)
            ? parsed.filters.map(String)
            : [];
          savedTags.excludes = Array.isArray(parsed.excludes)
            ? parsed.excludes.map(String)
            : [];
        }
      }
    } catch (e) {
      fail('read tag storage', e);
    }

    tagsReady = false;
    log('tags loaded', {
      tagStorageKey,
      filters: savedTags.filters.length,
      excludes: savedTags.excludes.length,
    });
    return true;
  }

  function persistTags() {
    if (!tagStorageKey) return;

    try {
      localStorage.setItem(
        tagStorageKey,
        JSON.stringify({
          filters: savedTags.filters,
          excludes: savedTags.excludes,
        })
      );
      log('tags saved', {
        tagStorageKey,
        filters: savedTags.filters.length,
        excludes: savedTags.excludes.length,
      });
    } catch (e) {
      fail('write tag storage', e);
    }
  }

  async function waitForSuggestion(block, name, timeout) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const options = Array.from(block.querySelectorAll('[role="option"]'));
      const match = options.find(
        (option) =>
          (option.textContent || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (match) return match;
      await wait(50);
    }

    return null;
  }

  async function addTag(block, name) {
    if (!block || !block.isConnected) return false;
    if (readChips(block).includes(name)) return true;

    for (let attempt = 0; attempt < 3; attempt++) {
      const input = block.querySelector('input');
      if (!input) return false;

      try {
        input.focus();
      } catch {
        /* ignore */
      }

      setNativeValue(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(120);

      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      });

      try {
        Object.defineProperty(enter, 'keyCode', { get: () => 13 });
        Object.defineProperty(enter, 'which', { get: () => 13 });
      } catch {
        /* ignore */
      }

      input.dispatchEvent(enter);
      await wait(220);

      if (readChips(block).includes(name)) {
        setNativeValue(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      // Fallback: click the matching autocomplete suggestion.
      const option = await waitForSuggestion(block, name, 600);
      if (option) {
        option.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        );
        option.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true })
        );
        option.click();
        await wait(220);

        if (readChips(block).includes(name)) {
          setNativeValue(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }

      await wait(150);
    }

    log('tag add failed', { name, html: block.outerHTML.slice(0, 500) });
    return false;
  }

  function buildTagNameMap() {
    const map = new Map();

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^LocalizedTagNames2?_/i.test(key)) continue;

      let data;
      try {
        data = JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        continue;
      }
      if (!data) continue;

      if (Array.isArray(data)) {
        for (const item of data) {
          if (!item) continue;
          const id = Number(item.tagid ?? item.id ?? item.tag_id);
          const name = item.name ?? item.tag_name ?? item.label;
          if (Number.isFinite(id) && typeof name === 'string') {
            map.set(name.trim().toLowerCase(), id);
          }
        }
      } else if (typeof data === 'object') {
        for (const [id, name] of Object.entries(data)) {
          const num = Number(id);
          if (Number.isFinite(num) && typeof name === 'string') {
            map.set(name.trim().toLowerCase(), num);
          }
        }
      }
    }

    return map;
  }

  /**
   * Find the React fiber that owns filterTags / excludeTags. The new UI is a
   * React app; setting those arrays directly avoids fighting the autocomplete.
   */
  function findTagControllerFiber(block) {
    if (!block) return null;

    const key = Object.keys(block).find((name) =>
      name.startsWith('__reactFiber$')
    );
    if (!key) return null;

    let fiber = block[key];

    for (let depth = 0; depth < 20 && fiber; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (
        props &&
        (typeof props.onFilterTagsChange === 'function' ||
          typeof props.onExcludeTagsChange === 'function')
      ) {
        return fiber;
      }
    }

    return null;
  }

  async function applyTags(blocks) {
    if (tagsApplying) return;

    tagsApplying = true;
    lastTagApplyAt = Date.now();

    try {
      // Preferred path: update the React state directly.
      const controller =
        findTagControllerFiber(blocks.filters) ||
        findTagControllerFiber(blocks.excludes);
      let usedReact = false;

      if (controller) {
        const props = controller.memoizedProps;
        const nameMap = buildTagNameMap();

        for (const kind of ['filters', 'excludes']) {
          const names = savedTags[kind];
          if (!names.length) continue;

          const currentIds = Array.isArray(
            kind === 'filters' ? props.filterTags : props.excludeTags
          )
            ? kind === 'filters'
              ? props.filterTags
              : props.excludeTags
            : [];

          const ids = [];
          for (const name of names) {
            const id = nameMap.get(name.trim().toLowerCase());
            if (Number.isFinite(id)) ids.push(id);
          }

          const merged = Array.from(new Set([...currentIds, ...ids]));
          if (merged.length === currentIds.length) continue;

          const setter =
            kind === 'filters'
              ? props.onFilterTagsChange
              : props.onExcludeTagsChange;

          if (typeof setter === 'function') {
            setter(merged);
            usedReact = true;
            log('tags set via react', { kind, ids, merged });
          }
        }

        if (usedReact) await wait(250);
      }

      // Verify what actually appeared. Anything still missing is retried via
      // the autocomplete input (or if the fiber path was unavailable).
      for (const kind of ['filters', 'excludes']) {
        const block = findTagBlocks()[kind];
        if (!block) continue;

        const current = readChips(block);
        const missing = savedTags[kind].filter(
          (name) => !current.includes(name)
        );

        for (const name of missing) {
          await addTag(block, name);
          await wait(120);
        }

        const after = readChips(block);
        const added = after.filter(
          (name) => !savedTags[kind].includes(name)
        );
        if (added.length) {
          savedTags[kind] = Array.from(new Set([...savedTags[kind], ...added]));
        }
      }

      persistTags();
      tagsReady = true;

      log('tags applied', {
        filters: savedTags.filters,
        excludes: savedTags.excludes,
      });
    } finally {
      tagsApplying = false;
    }
  }

  function syncTags() {
    if (tagsApplying) return;
    if (!loadTags()) return;

    const blocks = findTagBlocks();
    if (!blocks.filters && !blocks.excludes) return;

    if (!tagsReady) {
      applyTags(blocks);
      return;
    }

    for (const kind of ['filters', 'excludes']) {
      const block = blocks[kind];
      if (!block) continue;

      const current = readChips(block);
      const savedNames = savedTags[kind];

      const added = current.filter((name) => !savedNames.includes(name));
      if (added.length) {
        savedTags[kind] = Array.from(new Set([...savedNames, ...added]));
        persistTags();
      }

      const removed = savedNames.filter((name) => !current.includes(name));
      if (
        removed.length &&
        Date.now() - lastChipClickAt > 1500 &&
        Date.now() - lastTagApplyAt > 2000
      ) {
        // The page re-rendered and dropped the tag state; restore it.
        applyTags(blocks);
        return;
      }
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
    syncTags();
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

      // Click on a selected tag chip removes it. Save the removal before
      // React re-renders so syncTags() doesn't put the tag back.
      const tagBlock = findTagBlockForElement(target);
      if (tagBlock) {
        const chip = target.closest('button');
        if (chip && tagBlock.block.contains(chip)) {
          const name = (chip.textContent || '').trim();
          if (name) {
            lastChipClickAt = Date.now();
            savedTags[tagBlock.kind] = savedTags[tagBlock.kind].filter(
              (tag) => tag !== name
            );
            persistTags();
            log('tag removed', { kind: tagBlock.kind, name });
            return;
          }
        }
      }

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

    const tagBlocks = findTagBlocks();
    const currentTags = {
      filters: tagBlocks.filters ? readChips(tagBlocks.filters) : [],
      excludes: tagBlocks.excludes ? readChips(tagBlocks.excludes) : [],
    };

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
      tags: {
        key: tagStorageKey,
        ready: tagsReady,
        applying: tagsApplying,
        saved: savedTags,
        current: currentTags,
      },
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
    const tagCount = savedTags.filters.length + savedTags.excludes.length;
    const tagSuffix = tagCount ? ' · tags ' + tagCount : '';

    let label;
    if (stats.buttons === 0) {
      label = 'SteamRec: waiting for buttons…' + tagSuffix;
    } else if (stats.mapped === 0) {
      label = 'SteamRec: buttons found, no appid' + tagSuffix;
    } else {
      label = 'SteamRec: ' + stats.excluded + ' excluded' + tagSuffix;
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
    loadTags();
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

      if (tagStorageKey && event.key === tagStorageKey) {
        tagAccountKey = null;
        tagsReady = false;
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
