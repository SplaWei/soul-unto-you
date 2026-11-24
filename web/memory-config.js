(() => {
  const tr = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);
  const $id = (id) => document.getElementById(id);

  function mkField(labelKey, labelZh, inputId, type = 'text', extra = {}) {
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.dataset.memLabel = labelKey;
    span.dataset.memZh = labelZh;
    span.textContent = tr(labelKey, labelZh);
    const inp = document.createElement('input');
    inp.id = inputId;
    inp.type = type;
    if (extra.step) inp.step = extra.step;
    if (extra.min !== undefined) inp.min = String(extra.min);
    if (extra.max !== undefined) inp.max = String(extra.max);
    if (extra.placeholder) inp.placeholder = extra.placeholder;
    label.append(span, inp);
    return label;
  }

  function refreshLabels() {
    document.querySelectorAll('[data-mem-label]').forEach((el) => {
      el.textContent = tr(el.dataset.memLabel, el.dataset.memZh);
    });
    const probeBtn = $id('btnTestRerank');
    if (probeBtn) probeBtn.textContent = tr('mem.probeRerank', '探测 Rerank 服务');
    const health = $id('rerankHealthBox');
    if (health && !health.dataset.custom) {
      health.textContent = tr('mem.rerankIdle', '未启用或待探测（未配置密钥将自动回退 FTS5）');
    }
  }

  function renderPanel() {
    const host = $id('cfgRerankBox');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';
    host.style.margin = '6px 0 8px';
    host.style.padding = '8px 0';
    host.style.borderTop = '1px dashed var(--rule)';

    const embKeyField = mkField('mem.embedKey', 'Embedding API Key（云端千问/硅基流动选填，保留 **** 不覆盖）', 'cfgEmbedApiKey', 'password');
    const toggleLbl = document.createElement('label');
    const chk = document.createElement('input');
    chk.id = 'cfgRerankEnabled';
    chk.type = 'checkbox';
    const chkTxt = document.createElement('span');
    chkTxt.dataset.memLabel = 'mem.rerankToggle';
    chkTxt.dataset.memZh = ' 启用通用 Rerank 精排（兼容 SiliconFlow / DashScope Qwen3-Reranker）';
    chkTxt.textContent = tr(chkTxt.dataset.memLabel, chkTxt.dataset.memZh);
    toggleLbl.append(chk, chkTxt);

    const grid = document.createElement('div');
    grid.className = 'grid-2';
    grid.append(
      mkField('mem.rerankUrl', 'Rerank 端点 (如 https://api.siliconflow.cn/v1)', 'cfgRerankUrl'),
      mkField('mem.rerankModel', 'Rerank 模型 (如 Qwen/Qwen3-Reranker-0.6B)', 'cfgRerankModel'),
    );

    const grid2 = document.createElement('div');
    grid2.className = 'grid-2';
    grid2.append(
      mkField('mem.rerankKey', 'Rerank API Key（云端选填，保留 **** 不覆盖）', 'cfgRerankApiKey', 'password'),
      mkField('mem.rerankMin', 'Rerank 最低相关度阈值 (0~1)', 'cfgRerankMinScore', 'number', { step: '0.05', min: 0, max: 1 }),
    );

    const row = document.createElement('div');
    row.className = 'row-gap';
    row.style.margin = '6px 0 4px';
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.id = 'btnTestRerank';
    btn.type = 'button';
    btn.textContent = tr('mem.probeRerank', '探测 Rerank 服务');
    const status = document.createElement('span');
    status.className = 'muted';
    status.id = 'rerankHealthBox';
    status.textContent = tr('mem.rerankIdle', '未启用或待探测（未配置密钥将自动回退 FTS5）');
    row.append(btn, status);

    btn.addEventListener('click', async () => {
      status.dataset.custom = '1';
      status.textContent = tr('app.probing', '探测中…');
      const res = await fetch('/api/rerank/health', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...readRerankPatch(), enabled: true }),
      }).then((r) => r.json()).catch((err) => ({ detail: String(err) }));
      status.textContent = res.detail || tr('app.probeDone', '检测完成');
    });

    host.append(embKeyField, toggleLbl, grid, grid2, row);
  }

  function populate(cfg) {
    renderPanel();
    if (!cfg) return;
    if ($id('cfgEmbedApiKey')) $id('cfgEmbedApiKey').value = cfg.embedding?.apiKey || '';
    if ($id('cfgRerankEnabled')) $id('cfgRerankEnabled').checked = Boolean(cfg.rerank?.enabled);
    if ($id('cfgRerankUrl')) $id('cfgRerankUrl').value = cfg.rerank?.endpoint || '';
    if ($id('cfgRerankModel')) $id('cfgRerankModel').value = cfg.rerank?.model || 'Qwen/Qwen3-Reranker-0.6B';
    if ($id('cfgRerankApiKey')) $id('cfgRerankApiKey').value = cfg.rerank?.apiKey || '';
    if ($id('cfgRerankMinScore')) $id('cfgRerankMinScore').value = String(cfg.rerank?.minScore ?? 0.25);
  }

  function readEmbeddingPatch() {
    const keyEl = $id('cfgEmbedApiKey');
    return keyEl ? { apiKey: keyEl.value.trim() } : {};
  }

  function readRerankPatch() {
    return {
      enabled: Boolean($id('cfgRerankEnabled')?.checked),
      endpoint: ($id('cfgRerankUrl')?.value || '').trim(),
      model: ($id('cfgRerankModel')?.value || '').trim(),
      apiKey: ($id('cfgRerankApiKey')?.value || '').trim(),
      minScore: Number($id('cfgRerankMinScore')?.value ?? 0.25),
    };
  }

  window.SoulMemoryConfig = {
    init: () => {
      renderPanel();
      window.SoulI18n?.onChange(refreshLabels);
    },
    populate,
    readEmbeddingPatch,
    readRerankPatch,
  };
})();
