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
 *       3. IP-based geolocation (public service) → country → language. This runs
 *          asynchronously: English is shown immediately, and the page re-renders
 *          in the geo-matched language once the lookup returns (unless the user
 *          has already picked a language manually).
 *       4. Fallback to English.
 *   - Missing keys or a failed fetch gracefully fall back to the inline English.
 *
 * On IP-based detection: the site is static (no backend), so geolocation is done
 * by calling a public, no-key, CORS-enabled IP service from the browser. Several
 * endpoints are tried in order for resilience; any failure or timeout silently
 * falls back to English. No IP or location data is stored — only the resolved
 * language code (and only if the user later confirms via manual switch) persists.
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

      var resolved = resolveLocale();  // localStorage → browser/device language
      applyLocale(resolved);

      // If neither a manual choice nor the browser language matched, English is
      // showing. Try IP-based geolocation as a last resort and re-render if it
      // yields a supported, non-English language. A manual pick always wins, so
      // we skip this entirely when the user has already chosen a language.
      if (resolved === 'en' && !localStorage.getItem(LS_KEY)) {
        resolveByGeo().then(function (geo) {
          if (geo && geo !== 'en' && current === 'en' && !localStorage.getItem(LS_KEY)) {
            applyLocale(geo);
          }
        });
      }
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

  // Last-resort locale resolution via public IP-geolocation services. Returns a
  // Promise resolving to a supported language code, or 'en' on any failure.
  // Endpoints are tried in order; each returns an ISO country code we map to a
  // language. All are keyless, HTTPS, CORS-enabled and free for light use.
  function resolveByGeo() {
    var providers = [
      { url: 'https://ipapi.co/json/',            pick: function (d) { return d && d.country_code; } },
      { url: 'https://ipwho.is/',                 pick: function (d) { return d && d.country_code; } },
      { url: 'https://get.geojs.io/v1/ip/country.json', pick: function (d) { return d && d.country; } }
    ];

    return (function tryNext(i) {
      if (i >= providers.length) return Promise.resolve('en');
      return fetchWithTimeout(providers[i].url, 3500)
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (data) {
          var cc = data && providers[i].pick(data);
          var loc = cc ? countryToLocale(String(cc).toUpperCase()) : null;
          return loc || tryNext(i + 1);
        })
        .catch(function () { return tryNext(i + 1); });
    })(0);
  }

  function fetchWithTimeout(url, ms) {
    if (typeof AbortController === 'undefined') {
      return fetch(url, { cache: 'no-cache' });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, { cache: 'no-cache', signal: ctrl.signal })
      .then(function (r) { clearTimeout(timer); return r; });
  }

  // Map an ISO 3166-1 alpha-2 country code to the best supported language,
  // honouring region-specific Spanish/Portuguese/Chinese variants. Countries not
  // listed fall through to English.
  function countryToLocale(cc) {
    var map = {
      // Chinese
      CN: 'zh-Hans', SG: 'zh-Hans',
      TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant',
      // Tier-1 CJK / Western Europe
      JP: 'ja', KR: 'ko',
      DE: 'de', AT: 'de', CH: 'de', LI: 'de',
      FR: 'fr', BE: 'fr', LU: 'fr',
      IT: 'it', SM: 'it', VA: 'it',
      ES: 'es-ES',
      // Portuguese
      BR: 'pt-BR', PT: 'pt-BR', AO: 'pt-BR', MZ: 'pt-BR',
      // Spanish (Latin America)
      MX: 'es-419', AR: 'es-419', CO: 'es-419', CL: 'es-419', PE: 'es-419',
      VE: 'es-419', EC: 'es-419', GT: 'es-419', CU: 'es-419', BO: 'es-419',
      DO: 'es-419', HN: 'es-419', PY: 'es-419', SV: 'es-419', NI: 'es-419',
      CR: 'es-419', PA: 'es-419', UY: 'es-419', PR: 'es-419',
      // Arabic (RTL)
      SA: 'ar', AE: 'ar', QA: 'ar', KW: 'ar', BH: 'ar', OM: 'ar', JO: 'ar',
      LB: 'ar', IQ: 'ar', EG: 'ar', DZ: 'ar', MA: 'ar', TN: 'ar', LY: 'ar',
      SD: 'ar', YE: 'ar', SY: 'ar', PS: 'ar',
      // SE Asia + high-growth
      ID: 'id', TH: 'th', VN: 'vi', IN: 'hi',
      MY: 'ms', PH: 'fil',
      // Slavic / Turkic
      RU: 'ru', BY: 'ru', KZ: 'ru', KG: 'ru',
      TR: 'tr', UA: 'uk',
      // NW / Central / Northern Europe
      NL: 'nl', PL: 'pl', SE: 'sv', IL: 'he',
      RO: 'ro', MD: 'ro', CZ: 'cs',
      DK: 'da', NO: 'no', FI: 'fi'
    };
    var code = map[cc];
    return (code && SUPPORTED.indexOf(code) !== -1) ? code : null;
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
