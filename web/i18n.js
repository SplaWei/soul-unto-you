(() => {
  const LANG_KEY = 'soul_ui_lang';
  const origTitle = document.title;
  const origText = new Map();
  const origRich = new Map();
  const origPh = new Map();
  const origLabel = new Map();
  const origOpt = new Map();
  const origAttr = new Map();
  const origXray = [];
  const origTpl = [];
  const origStatus = [];
  const origEmbedNodes = [];
  const listeners = new Set();

  function detectInitialLang() {
    try {
      const q = new URLSearchParams(window.location.search).get('lang');
      if (q === 'en' || q === 'zh') return q;
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch {}
    return navigator.language && !/^zh/i.test(navigator.language) ? 'en' : 'zh';
  }

  let currentLang = detectInitialLang();

  function buildRichNodes(parts) {
    return parts.map((p) => {
      if (typeof p === 'string') return document.createTextNode(p);
      const el = document.createElement(p[0]);
      if (p[1]) el.className = p[1];
      if (p[2] !== undefined) el.textContent = p[2];
      return el;
    });
  }

  function findLabelTextNode(id) {
    const inp = document.getElementById(id);
    const lbl = inp?.closest('label');
    if (!lbl) return null;
    for (const node of lbl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node;
    }
    return null;
  }

  function applyStatic(lang) {
    const en = window.SOUL_I18N_EN;
    if (!en) return;
    const isEn = lang === 'en';
    document.title = isEn ? en.title : origTitle;

    for (const [sel, enVal] of Object.entries(en.text || {})) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (!origText.has(sel)) origText.set(sel, el.textContent);
      el.textContent = isEn ? enVal : origText.get(sel);
    }

    const xrayEls = document.querySelectorAll('.pane-xray .xray-block h3');
    xrayEls.forEach((el, i) => {
      if (origXray[i] === undefined) origXray[i] = el.textContent;
      el.textContent = isEn && en.xrayHeaders?.[i] ? en.xrayHeaders[i] : origXray[i];
    });

    const tplEls = document.querySelectorAll('#panel-sockets .tpl-label');
    tplEls.forEach((el, i) => {
      if (origTpl[i] === undefined) origTpl[i] = el.textContent;
      el.textContent = isEn && en.tplLabels?.[i] ? en.tplLabels[i] : origTpl[i];
    });

    const stEls = document.querySelectorAll('#panel-phase2 .status-card strong');
    stEls.forEach((el, i) => {
      if (origStatus[i] === undefined) origStatus[i] = el.textContent;
      el.textContent = isEn && en.statusCardTitles?.[i] ? en.statusCardTitles[i] : origStatus[i];
    });

    for (const [id, enVal] of Object.entries(en.labels || {})) {
      const node = findLabelTextNode(id);
      if (!node) continue;
      if (!origLabel.has(id)) origLabel.set(id, node.textContent);
      node.textContent = isEn ? enVal : origLabel.get(id);
    }

    const embInp = document.getElementById('cfgEmbedEnabled');
    const embLbl = embInp?.closest('label');
    if (embLbl) {
      if (!origEmbedNodes.length) {
        for (const n of embLbl.childNodes) {
          if (n !== embInp) origEmbedNodes.push(n.cloneNode(true));
        }
      }
      const next = isEn ? buildRichNodes(en.embedLabelSuffix || []) : origEmbedNodes.map((n) => n.cloneNode(true));
      embLbl.replaceChildren(embInp, ...next);
    }

    for (const [id, enVal] of Object.entries(en.placeholders || {})) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (!origPh.has(id)) origPh.set(id, el.getAttribute('placeholder') || '');
      el.setAttribute('placeholder', isEn ? enVal : origPh.get(id));
    }

    for (const [id, pair] of Object.entries(en.defaultValues || {})) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (isEn && el.value === pair.zh) el.value = pair.en;
      else if (!isEn && el.value === pair.en) el.value = pair.zh;
    }

    for (const [selId, map] of Object.entries(en.options || {})) {
      const sel = document.getElementById(selId);
      if (!sel) continue;
      for (const opt of sel.options) {
        const key = `${selId}:${opt.value}`;
        if (!origOpt.has(key)) origOpt.set(key, opt.textContent);
        opt.textContent = isEn && map[opt.value] ? map[opt.value] : origOpt.get(key);
      }
    }

    for (const [sel, attrs] of Object.entries(en.attrs || {})) {
      const el = document.querySelector(sel);
      if (!el) continue;
      for (const [attr, val] of Object.entries(attrs)) {
        const key = `${sel}:${attr}`;
        if (!origAttr.has(key)) origAttr.set(key, el.getAttribute(attr) || '');
        el.setAttribute(attr, isEn ? val : origAttr.get(key));
      }
    }

    for (const [sel, parts] of Object.entries(en.rich || {})) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (!origRich.has(sel)) origRich.set(sel, Array.from(el.childNodes).map((n) => n.cloneNode(true)));
      const next = isEn ? buildRichNodes(parts) : origRich.get(sel).map((n) => n.cloneNode(true));
      el.replaceChildren(...next);
    }
  }

  function syncToggleBtn(lang) {
    const btn = document.getElementById('btnToggleLang');
    if (!btn) return;
    btn.textContent = lang === 'en' ? '中文' : 'EN';
    btn.title = lang === 'en' ? '切换至中文界面' : 'Switch to English UI';
  }

  function setLang(next, persist = true) {
    currentLang = next === 'en' ? 'en' : 'zh';
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.lang = currentLang;
    if (persist) {
      try { localStorage.setItem(LANG_KEY, currentLang); } catch {}
    }
    syncToggleBtn(currentLang);
    applyStatic(currentLang);
    for (const fn of listeners) {
      try { fn(currentLang); } catch {}
    }
  }

  function t(key, zhFallback, vars) {
    const raw = currentLang === 'en' && window.SOUL_I18N_EN?.dyn?.[key] !== undefined
      ? window.SOUL_I18N_EN.dyn[key]
      : zhFallback;
    if (!vars) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  }

  document.getElementById('btnToggleLang')?.addEventListener('click', () => {
    setLang(currentLang === 'en' ? 'zh' : 'en', true);
  });

  function trText(str) {
    const raw = String(str ?? '');
    if (currentLang !== 'en') return raw;
    return window.SOUL_I18N_EN?.backendMap?.[raw] ?? raw;
  }

  window.SoulI18n = {
    getLang: () => currentLang,
    isEn: () => currentLang === 'en',
    t,
    trText,
    setLang,
    toggle: () => setLang(currentLang === 'en' ? 'zh' : 'en', true),
    apply: () => applyStatic(currentLang),
    onChange: (fn) => { if (typeof fn === 'function') listeners.add(fn); },
  };

  setLang(currentLang, false);
})();
