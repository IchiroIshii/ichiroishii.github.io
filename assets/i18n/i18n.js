/*
 * i18n.js — lightweight, dependency-free language-pack runtime for a static site.
 *
 * Design:
 *   - English is the default and is baked directly into the HTML, so the site
 *     works with no JavaScript and fully offline (no fetch needed for English).
 *   - Non-English locales are loaded on demand from ./locales/<code>.json.
 *   - Active locale resolution order:
 *       1. Manual choice persisted in localStorage ("site-lang").
 *       2. Browser / device language (navigator.languages), matched against the
 *          supported set with sensible region fallbacks.
 *       3. Fallback to English.
 *   - Missing keys or a failed fetch gracefully fall back to the inline English.
 */
(function () {
  'use strict';

  // Resolve the directory this script lives in, so locale files load correctly
  // regardless of the page's depth in the site tree.
  var SELF = (document.currentScript && document.currentScript.src) || '';
  var BASE = SELF.replace(/\/[^/]*$/, '');
  var LOCALES_URL = BASE + '/locales/';
  var MANIFEST_URL = BASE + '/languages.json';
  var LS_KEY = 'site-lang';

  // Embedded fallback manifest — used if languages.json cannot be fetched
  // (e.g. opened from file://). Keep in sync with languages.json.
  var FALLBACK_MANIFEST = [
    { code: 'en',      native: 'English' },
    { code: 'zh-Hans', native: '简体中文' },
    { code: 'zh-Hant', native: '繁體中文' },
    { code: 'ja',      native: '日本語' },
    { code: 'ko',      native: '한국어' },
    { code: 'de',      native: 'Deutsch' },
    { code: 'fr',      native: 'Français' },
    { code: 'es-ES',   native: 'Español (España)' },
    { code: 'it',      native: 'Italiano' },
    { code: 'pt-BR',   native: 'Português (Brasil)' },
    { code: 'es-419',  native: 'Español (Latinoamérica)' },
    { code: 'ar',      native: 'العربية', rtl: true },
    { code: 'id',      native: 'Bahasa Indonesia' },
    { code: 'th',      native: 'ไทย' },
    { code: 'vi',      native: 'Tiếng Việt' },
    { code: 'hi',      native: 'हिन्दी' },
    { code: 'ru',      native: 'Русский' },
    { code: 'tr',      native: 'Türkçe' },
    { code: 'nl',      native: 'Nederlands' },
    { code: 'pl',      native: 'Polski' },
    { code: 'sv',      native: 'Svenska' },
    { code: 'he',      native: 'עברית', rtl: true },
    { code: 'ms',      native: 'Bahasa Melayu' },
    { code: 'fil',     native: 'Filipino' },
    { code: 'uk',      native: 'Українська' },
    { code: 'ro',      native: 'Română' },
    { code: 'cs',      native: 'Čeština' },
    { code: 'da',      native: 'Dansk' },
    { code: 'no',      native: 'Norsk' },
    { code: 'fi',      native: 'Suomi' }
  ];

  var MANIFEST = FALLBACK_MANIFEST;
  var SUPPORTED = [];
  var EN = {};       // snapshot of inline English text, keyed by data-i18n key
  var current = 'en';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadManifest().then(function (m) {
      MANIFEST = (m && m.length) ? m : FALLBACK_MANIFEST;
      SUPPORTED = MANIFEST.map(function (x) { return x.code; });
      EN = snapshot();
      buildSwitcher();

      applyLocale(resolveLocale());
    });
  }

  function loadManifest() {
    return fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : FALLBACK_MANIFEST; })
      .catch(function () { return FALLBACK_MANIFEST; });
  }

  // Capture the inline (English) content before any replacement happens.
  // innerHTML is used so inline emphasis (e.g. <b>) in the source is preserved;
  // all content is first-party (no user input), so this is not an XSS vector.
  function snapshot() {
    var map = {};
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      map[el.getAttribute('data-i18n')] = el.innerHTML.trim();
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var kv = pair.split(':');
        var attr = (kv[0] || '').trim();
        var key = (kv[1] || '').trim();
        if (attr && key) map[key] = el.getAttribute(attr);
      });
    });
    return map;
  }

  // Match the browser's preferred languages against the supported set.
  function resolveLocale() {
    var stored = localStorage.getItem(LS_KEY);
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;

    var prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];

    for (var i = 0; i < prefs.length; i++) {
      var hit = matchOne(prefs[i]);
      if (hit) return hit;
    }
    return 'en';
  }

  function has(code) { return SUPPORTED.indexOf(code) !== -1 ? code : null; }

  function matchOne(tag) {
    if (!tag) return null;
    var t = String(tag).toLowerCase();
    var parts = t.split('-');
    var primary = parts[0];
    var region = parts[1];

    // Exact match (case-insensitive) against a supported code.
    for (var i = 0; i < SUPPORTED.length; i++) {
      if (SUPPORTED[i].toLowerCase() === t) return SUPPORTED[i];
    }

    // Language-specific fallbacks.
    if (primary === 'zh') {
      if (region === 'tw' || region === 'hk' || region === 'mo' || region === 'hant') return has('zh-Hant');
      return has('zh-Hans');
    }
    if (primary === 'es') {
      if (region === 'es') return has('es-ES');
      if (region) return has('es-419');   // any other Spanish region → Latin America
      return has('es-ES');
    }
    if (primary === 'pt') return has('pt-BR');
    if (primary === 'nb' || primary === 'nn' || primary === 'no') return has('no');
    if (primary === 'tl' || primary === 'fil') return has('fil');
    if (primary === 'he' || primary === 'iw') return has('he');   // iw = legacy Hebrew tag
    if (primary === 'id' || primary === 'in') return has('id');   // in = legacy Indonesian tag

    // Generic primary-subtag match (e.g. "de-AT" → "de").
    for (var j = 0; j < SUPPORTED.length; j++) {
      if (SUPPORTED[j].toLowerCase() === primary) return SUPPORTED[j];
    }
    return null;
  }

  function applyLocale(code) {
    var entry = find(code) || { code: 'en' };
    document.documentElement.lang = code;
    document.documentElement.dir = entry.rtl ? 'rtl' : 'ltr';
    current = code;

    if (code === 'en') {
      applyDict(EN);
      syncSelect(code);
      return Promise.resolve();
    }

    return fetch(LOCALES_URL + code + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (data) {
        // Locale files are flat { key: value } dictionaries. Overlay them onto
        // the inline English so any missing key stays in English.
        applyDict(Object.assign({}, EN, data || {}));
        syncSelect(code);
      });
  }

  function applyDict(map) {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = map[el.getAttribute('data-i18n')];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var kv = pair.split(':');
        var attr = (kv[0] || '').trim();
        var key = (kv[1] || '').trim();
        if (!attr || !key) return;
        var v = map[key];
        if (v != null) el.setAttribute(attr, v);
      });
    });
    var titleEl = document.querySelector('title');
    if (titleEl) document.title = titleEl.textContent;
  }

  function find(code) {
    for (var i = 0; i < MANIFEST.length; i++) if (MANIFEST[i].code === code) return MANIFEST[i];
    return null;
  }

  function buildSwitcher() {
    if (document.getElementById('i18n-switcher')) return;
    injectStyle();

    var box = document.createElement('div');
    box.id = 'i18n-switcher';

    var globe = document.createElement('span');
    globe.className = 'i18n-globe';
    globe.textContent = '🌐';

    var select = document.createElement('select');
    select.id = 'i18n-select';
    select.setAttribute('aria-label', EN['common.lang.label'] || 'Language');

    MANIFEST.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = m.native;
      select.appendChild(opt);
    });

    select.addEventListener('change', function () {
      localStorage.setItem(LS_KEY, select.value);
      applyLocale(select.value);
    });

    box.appendChild(globe);
    box.appendChild(select);
    document.body.appendChild(box);
  }

  function syncSelect(code) {
    var sel = document.getElementById('i18n-select');
    if (sel) sel.value = code;
  }

  function injectStyle() {
    var css =
      '#i18n-switcher{position:fixed;top:16px;right:16px;z-index:9999;display:flex;' +
      'align-items:center;gap:6px;background:rgba(22,27,34,.85);border:1px solid #30363d;' +
      'border-radius:999px;padding:6px 10px;backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);}' +
      '#i18n-switcher .i18n-globe{font-size:14px;line-height:1;}' +
      '#i18n-select{appearance:none;-webkit-appearance:none;background:transparent;' +
      'border:none;color:#e6edf3;font:inherit;font-size:13px;cursor:pointer;' +
      'padding-right:2px;outline:none;max-width:180px;}' +
      '#i18n-select option{background:#161b22;color:#e6edf3;}' +
      'html[dir="rtl"] #i18n-switcher{right:auto;left:16px;}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Public API for manual switching / debugging.
  window.I18N = {
    set: function (code) {
      if (SUPPORTED.indexOf(code) === -1) return;
      localStorage.setItem(LS_KEY, code);
      applyLocale(code);
    },
    current: function () { return current; },
    supported: function () { return SUPPORTED.slice(); }
  };
})();
