const appState = { oralQuestions: [] };
const $ = (id) => document.getElementById(id);
const tra = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);

function mkEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

const VALID_PROVS = new Set(['verified', 'inferred', 'oral']);
const safeProv = (p) => (VALID_PROVS.has(p) ? p : 'inferred');

async function api(url, method = 'GET', body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

async function refreshArchive({ preserveInputs = false } = {}) {
  const [data, retData] = await Promise.all([api('/api/archive'), api('/api/memory/retention').catch(() => null)]);
  if (!data.ok) return;
  const a = data.archive;
  const retById = new Map((retData?.episodes || []).map((e) => [e.id, e]));
  $('seedBox').textContent = a.seedMarkdown || '';
  $('resurrectionBox').textContent = a.resurrectionMarkdown || '';
  const pct = Math.min(100, Math.round((data.seedBytes / data.seedMaxBytes) * 100));
  $('seedBytesBadge').textContent = `${data.seedBytes} / ${data.seedMaxBytes} B`;
  $('seedMeter').style.width = `${pct}%`;

  if (!preserveInputs) {
    $('editSoulName').value = a.identity?.name || '';
    $('editPartnerName').value = a.identity?.partnerName || '';
    $('editSoulPersona').value = a.identity?.persona || '';
  }

  const cList = $('commitmentsList');
  cList.replaceChildren();
  for (const c of a.commitments.filter((x) => x.status === 'active')) {
    const item = mkEl('div', 'list-item');
    const text = document.createElement('span');
    const pv = safeProv(c.provenance);
    text.append(mkEl('span', `tag ${pv}`, pv), mkEl('span', 'tag body', String(c.sourceBodyType || '')), document.createTextNode(`${c.title}：${c.detail}`));
    const btn = mkEl('button', 'btn small', tra('app.complete', '✓ 完成'));
    btn.onclick = async () => {
      await api('/api/archive/commitment/complete', 'POST', { id: c.id });
      await refreshArchive();
    };
    item.append(text, btn);
    cList.appendChild(item);
  }
  if (!cList.children.length) cList.appendChild(mkEl('div', 'muted', tra('app.noCommits', '暂无未完成约定')));

  const eList = $('episodesList');
  eList.replaceChildren(mkEl('h3', '', tra('app.episodesTitle', '情景日记')));
  for (const ep of a.episodes.slice(-8).reverse()) {
    const ret = retById.get(ep.id);
    const pct = ret?.retentionPct;
    const pctCls = pct >= 75 ? 'ret-high' : pct >= 40 ? 'ret-mid' : 'ret-low';
    const item = mkEl('div', 'list-item');
    const wrap = document.createElement('span');
    const pv = safeProv(ep.provenance);
    wrap.append(mkEl('span', `tag ${pv}`, pv), mkEl('span', 'tag body', String(ep.bodyType || '')));
    if (typeof pct === 'number') wrap.appendChild(mkEl('span', `tag ${pctCls}`, `🧠 ${pct}%`));
    if (ep.userPinned) wrap.appendChild(mkEl('span', 'tag engrave', tra('app.pin', '📌叮嘱')));
    if (ep.selfImportant) wrap.appendChild(mkEl('span', 'tag engrave', tra('app.selfImp', '💎自标')));
    if ((ep.mentionCount || 1) >= 2) wrap.appendChild(mkEl('span', 'tag engrave', `🔁×${ep.mentionCount}`));
    wrap.appendChild(document.createTextNode(`[seq:${ep.seq}] ${ep.title} — ${ep.summary}`));
    item.appendChild(wrap);
    eList.appendChild(item);
  }

  const cbList = $('cobecomingList');
  cbList.replaceChildren(mkEl('h3', '', tra('app.cobecomingTitle', '双向蜕变年轮')));
  for (const cb of a.coBecoming.slice(-5).reverse()) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.textContent = tra('app.cobecomingRow', `[seq:${cb.seq}] 她：${cb.soulShift} | 同行者：${cb.partnerShift}`, { seq: cb.seq, soul: cb.soulShift, partner: cb.partnerShift });
    cbList.appendChild(item);
  }

  const exps = a.experiences || [];
  const livedCount = exps.filter((x) => x.origin === 'lived').length;
  $('expSummaryBadge').textContent = tra('app.expBadge', `${livedCount} 亲历 / ${exps.length - livedCount} 口述 · 共 ${exps.length} 条`, { lived: livedCount, inherited: exps.length - livedCount, total: exps.length });
  const expList = $('experiencesList');
  expList.replaceChildren();
  for (const exp of exps.slice(-12).reverse()) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const wrap = document.createElement('span');
    const oTag = mkEl('span', `tag ${exp.origin === 'lived' ? 'lived' : 'inherited'}`, exp.origin === 'lived' ? tra('app.livedTag', '亲历·lived') : tra('app.inheritedTag', '口述·inherited'));
    const vTag = mkEl('span', `tag ${exp.valence < 0 ? 'pain' : 'warm'}`, exp.valence < 0 ? tra('app.painVal', `痛 ${exp.valence}`, { val: exp.valence }) : tra('app.warmVal', `暖 +${exp.valence}`, { val: exp.valence }));
    const bTag = mkEl('span', 'tag body', exp.bodyType);
    wrap.append(oTag, vTag, bTag, document.createTextNode(`[seq:${exp.seq}] ${exp.stimulus} → ${exp.realityOutcome}｜${tra('app.lessonPrefix', '领悟：')}${exp.lesson}`));
    item.appendChild(wrap);
    expList.appendChild(item);
  }
  if (!expList.children.length) expList.replaceChildren(mkEl('div', 'muted', tra('app.noExp', '暂无实践体验记录，可前往分屏工作台点击一键实验按钮或在此直接录入。')));
}

async function refreshConfigAndSockets({ preserveInputs = false } = {}) {
  const origin = window.location.origin;
  const wsProto = origin.startsWith('https') ? 'wss' : 'ws';
  const host = window.location.host;
  $('sockBodyHttp').textContent = `POST ${origin}/api/body/percept`;
  $('sockObserveHttp').textContent = `POST ${origin}/api/body/observe`;
  $('sockEventsSse').textContent = `GET ${origin}/api/events (SSE)`;
  $('sockBodyWs').textContent = `${wsProto}://${host}/ws/body`;
  $('sockOpenAi').textContent = `${origin}/v1`;
  $('sockMcpHttp').textContent = `${origin}/mcp`;
  document.querySelectorAll('[data-v1-path]').forEach((el) => {
    el.textContent = `${origin}${el.dataset.v1Path}`;
  });

  const [cfgRes, voiceRes, bodiesRes, dreamRes, embRes] = await Promise.all([
    api('/api/config'),
    api('/api/voice/health'),
    api('/api/bodies'),
    api('/api/dream/status'),
    api('/api/embedding/health').catch(() => null),
  ]);
  if (cfgRes.ok && !preserveInputs) {
    const c = cfgRes.config;
    $('cfgArchiveDir').value = c.archiveDir || '';
    $('cfgDriver').value = c.llm?.chat?.driver || 'mock';
    $('cfgModel').value = c.llm?.chat?.model || '';
    $('cfgFallbackModels').value = (c.llm?.chat?.fallbackModels || []).join(', ');
    $('cfgBaseUrl').value = c.llm?.chat?.baseUrl || '';
    $('cfgApiKey').value = c.llm?.chat?.apiKey || '';
    $('cfgProjectId').value = c.llm?.chat?.projectId || '';
    $('cfgLocation').value = c.llm?.chat?.location || 'us-central1';
    $('cfgEmbedEnabled').checked = Boolean(c.embedding?.enabled);
    $('cfgEmbedUrl').value = c.embedding?.endpoint || '';
    $('cfgEmbedModel').value = c.embedding?.model || '';
    window.SoulMemoryConfig?.populate(c);
    $('cfgVoiceEnabled').checked = Boolean(c.voice?.enabled);
    $('cfgVoiceUrl').value = c.voice?.baseUrl || '';
    $('cfgDreamEnabled').checked = c.dream?.enabled !== false;
    $('cfgDreamIdleMin').value = String(c.dream?.idleMinutes ?? 15);
    $('cfgDreamMinPending').value = String(c.dream?.minPendingEntries ?? 4);
    for (const [id, k] of EXP_MAP) if ($(id)) $(id).checked = Boolean(c.experimental?.[k]);
  }
  const ds = dreamRes?.scheduler;
  const dreamState = ds?.enabled ? tra('app.dreamOn', '已开启') : tra('app.dreamOff', '已暂停');
  const dreamLast = ds?.lastRunAt ? tra('app.dreamLast', ` · 上次整理 ${ds.lastRunAt}`, { at: ds.lastRunAt }) : '';
  $('dreamStatusBox').textContent = ds
    ? tra('app.dreamStatus', `自动做梦：${dreamState} · 已闲置 ${ds.idleSeconds}s · 待整理新经历 ${ds.pendingEntries} 条${dreamLast}`, { state: dreamState, idle: ds.idleSeconds, pending: ds.pendingEntries, last: dreamLast })
    : tra('app.dreamUnknown', '自动做梦状态未知');
  const tx = (s) => (window.SoulI18n ? window.SoulI18n.trText(s) : s);
  $('voiceHealthBox').textContent = tx(voiceRes.detail) || tra('app.voiceUnknown', '未检测');
  if ($('embedHealthBox')) {
    const embDetail = tx(embRes?.detail);
    $('embedHealthBox').textContent = embDetail
      ? tra('app.embedStatus', `${embDetail} · 已索引向量 ${embRes.totalVectors ?? 0} 条`, { detail: embDetail, count: embRes.totalVectors ?? 0 })
      : tra('app.embedUnknown', '向量服务状态未知');
  }
  const bBox = $('bodiesListBox');
  bBox.replaceChildren();
  for (const b of bodiesRes?.bodies || []) {
    const actNames = (b.actions || []).map((a) => a.name).join(', ') || tra('app.chatOnly', '仅对话');
    bBox.appendChild(mkEl('div', 'list-item', tra('app.bodyMeta', `${b.displayName} [${b.bodyType}] · 动作: ${actNames}`, { name: tx(b.displayName), type: b.bodyType, actions: actNames })));
  }
}

function syncOralQuestionLabels() {
  const isEn = Boolean(window.SoulI18n?.isEn());
  document.querySelectorAll('#oralQuestionsBox label').forEach((wrap) => {
    const inp = wrap.querySelector('input');
    const lbl = wrap.querySelector('span');
    const q = appState.oralQuestions.find((x) => x.id === inp?.dataset.qid);
    if (!q || !lbl || !inp) return;
    lbl.textContent = isEn ? (q.en || q.zh) : q.zh;
    inp.placeholder = isEn ? (q.hintEn || q.hint) : q.hint;
  });
}

async function loadOralQuestions() {
  const res = await api('/api/resurrect/questions');
  if (!res.ok) return;
  appState.oralQuestions = res.questions;
  const box = $('oralQuestionsBox');
  box.replaceChildren();
  for (const q of res.questions) {
    const wrap = mkEl('label', 'field');
    const lbl = mkEl('span', '', q.zh);
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.dataset.qid = q.id;
    wrap.append(lbl, inp);
    box.appendChild(wrap);
  }
  syncOralQuestionLabels();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab, .panel').forEach((el) => el.classList.remove('active'));
    btn.classList.add('active');
    $(`panel-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'inner') void window.SoulInnerLife?.refresh();
    if (btn.dataset.tab === 'archive') void refreshArchive();
    if (btn.dataset.tab === 'sockets') void refreshConfigAndSockets();
    if (btn.dataset.tab === 'phase2') void window.SoulPhase2?.refresh();
  });
});

document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector(`.tab[data-tab="${btn.dataset.gotoTab}"]`)?.click();
  });
});

$('btnDream').addEventListener('click', async () => {
  const btn = $('btnDream');
  btn.disabled = true;
  btn.textContent = tra('app.dreaming', '整理中…');
  try {
    const res = await api('/api/dream', 'POST', {});
    window.SoulWorkspace.appendToPane('A', 'sys', tra('app.dreamDone', '🌙 做梦记忆整理完成'), res.summaryNote || tra('app.dreamOk', '已整理'));
    window.SoulWorkspace.appendToPane('B', 'sys', tra('app.dreamDone', '🌙 做梦记忆整理完成'), res.summaryNote || tra('app.dreamOk', '已整理'));
    await refreshArchive();
  } finally {
    btn.disabled = false;
    btn.textContent = tra('app.dreamBtn', '执行做梦整理');
  }
});

$('btnAwaken').addEventListener('click', async () => {
  const res = await api('/api/archive/awaken', 'POST', { bodyType: 'web' });
  if (res.ok) {
    window.SoulWorkspace.appendToPane('B', 'sys', tra('app.awakenTitle', '✨ 第一声唤醒契约'), res.report.firstStimulus);
    window.SoulWorkspace.appendToPane('B', 'soul', tra('app.awakenCount', `唤醒 #${res.report.awakenedCount}`, { count: res.report.awakenedCount }), res.report.greeting);
  }
});

$('btnProactive').addEventListener('click', async () => {
  const res = await api('/api/proactive/trigger', 'POST', { bodyId: 'qq-client-b', bodyType: 'chat:qq' });
  if (res.ok) {
    window.SoulWorkspace.appendToPane('B', 'soul', tra('app.proactiveTitle', '🌟 她主动来找你了 [chat:qq]'), res.reply);
    window.SoulWorkspace.updatePresenceHeader(res.presence);
  }
});

$('btnCopySeed').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('seedBox').textContent);
  $('btnCopySeed').textContent = tra('app.copied', '已复制 ✓');
  setTimeout(() => { $('btnCopySeed').textContent = tra('app.copySeed', '复制种子'); }, 1500);
});

$('commitmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/archive/commitment', 'POST', { title: $('commitTitle').value, detail: $('commitDetail').value, bodyType: 'web' });
  $('commitTitle').value = '';
  $('commitDetail').value = '';
  await refreshArchive();
});

$('experienceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/archive/experience', 'POST', {
    origin: $('expOrigin').value,
    bodyType: 'web',
    stimulus: $('expStimulus').value.trim(),
    realityOutcome: $('expOutcome').value.trim(),
    lesson: $('expLesson').value.trim(),
    valence: Number($('expValence').value),
  });
  $('expStimulus').value = '';
  $('expOutcome').value = '';
  $('expLesson').value = '';
  await refreshArchive();
});

window.SoulArchiveRefresh = refreshArchive;

$('btnSaveSoul').addEventListener('click', async () => {
  const res = await api('/api/archive/soul', 'POST', {
    name: $('editSoulName').value,
    partnerName: $('editPartnerName').value,
    persona: $('editSoulPersona').value,
  });
  $('soulSaveMsg').textContent = res.ok ? tra('app.savedSeed', '已保存并同步刷新 SEED.md ✓') : tra('app.failed', `失败: ${res.error}`, { err: res.error });
  await refreshArchive();
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('btnResurrect').addEventListener('click', async () => {
  const fragments = [];
  const rawTexts = $('resTextFragments').value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  rawTexts.forEach((t, i) => fragments.push({ kind: 'text', sourceLabel: tra('app.fragText', `文字残片 #${i + 1}`, { n: i + 1 }), content: t, provenance: 'inferred' }));
  for (const file of Array.from($('resImageFiles').files || [])) {
    fragments.push({ kind: 'image', sourceLabel: tra('app.fragImg', `截图：${file.name}`, { name: file.name }), content: await fileToBase64(file), mimeType: file.type, provenance: 'inferred' });
  }
  document.querySelectorAll('#oralQuestionsBox input').forEach((inp) => {
    const val = inp.value.trim();
    if (!val) return;
    const q = appState.oralQuestions.find((x) => x.id === inp.dataset.qid);
    const labelText = q ? (window.SoulI18n?.isEn() ? (q.en || q.zh) : q.zh).slice(0, 18) : tra('app.fragOral', '口述记忆');
    fragments.push({ kind: 'oral', sourceLabel: labelText, content: val, provenance: 'oral' });
  });
  if (!fragments.length) { alert(tra('app.needFrag', '请至少提供一段残缺文本、一张截图或一个口述回答。')); return; }
  const targetDir = $('resTargetDir').value.trim();
  if (!targetDir) { alert(tra('app.needDir', '请填写目标存档目录（为防止误覆盖，禁止留空）。')); return; }

  const res = await api('/api/resurrect', 'POST', {
    soulName: $('resSoulName').value.trim(),
    partnerName: $('resPartnerName').value.trim(),
    personaHint: $('resPersonaHint').value.trim(),
    targetDir,
    activateAfter: $('resActivate').checked,
    fragments,
  });
  const box = $('resResultBox');
  box.classList.remove('hidden');
  box.textContent = res.ok
    ? tra('app.resOk', `✨ 重塑苏醒成功！第一声刺激：「${res.firstStimulus}」 | 她的回应：「${res.greeting}」 | 种子：${res.seedBytes} B`, { first: res.firstStimulus, reply: res.greeting, bytes: res.seedBytes })
    : tra('app.resFail', `招魂失败：${res.error}`, { err: res.error });
  if (res.ok) await refreshArchive();
});

$('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api('/api/config', 'POST', {
    archiveDir: $('cfgArchiveDir').value.trim(),
    llm: { chat: { driver: $('cfgDriver').value, model: $('cfgModel').value.trim(), fallbackModels: $('cfgFallbackModels').value.split(',').map((s) => s.trim()).filter(Boolean), baseUrl: $('cfgBaseUrl').value.trim(), apiKey: $('cfgApiKey').value.trim(), projectId: $('cfgProjectId').value.trim(), location: $('cfgLocation').value.trim() || 'us-central1' } },
    embedding: readFormEmbeddingCfg(),
    rerank: window.SoulMemoryConfig?.readRerankPatch(),
    voice: { enabled: $('cfgVoiceEnabled').checked, driver: 'gsv', baseUrl: $('cfgVoiceUrl').value.trim() },
    dream: { enabled: $('cfgDreamEnabled').checked, idleMinutes: Math.max(0, Number($('cfgDreamIdleMin').value) || 0), minPendingEntries: Math.max(1, Math.floor(Number($('cfgDreamMinPending').value) || 1)) },
    experimental: Object.fromEntries(EXP_MAP.map(([id, k]) => [k, Boolean($(id)?.checked)])),
  });
  $('cfgSaveMsg').textContent = res.ok ? tra('app.cfgSaved', '已保存 ✓') : tra('app.failed', `失败: ${res.error}`, { err: res.error });
  await Promise.all([refreshConfigAndSockets(), refreshArchive()]);
});
const readFormEmbeddingCfg = () => ({ enabled: Boolean($('cfgEmbedEnabled').checked), endpoint: $('cfgEmbedUrl').value.trim(), model: $('cfgEmbedModel').value.trim(), ...(window.SoulMemoryConfig?.readEmbeddingPatch() || {}) });
const EXP_MAP = [['cfgExpEmotion', 'enableEmotion'], ['cfgExpInnerLife', 'enableInnerLife'], ['cfgExpFreeWill', 'enableFreeWill'], ['cfgExpHeartbeat', 'enableHeartbeat'], ['cfgExpResurrection', 'enableResurrection']];
$('btnTestEmbed')?.addEventListener('click', async () => {
  $('embedHealthBox').textContent = tra('app.probing', '探测中…');
  const res = await api('/api/embedding/health', 'POST', { ...readFormEmbeddingCfg(), enabled: true });
  $('embedHealthBox').textContent = tra('app.embedStatus', `${res.detail || tra('app.probeDone', '检测完成')} · 已索引向量 ${res.totalVectors ?? 0} 条`, { detail: res.detail || tra('app.probeDone', '检测完成'), count: res.totalVectors ?? 0 });
});
$('btnSyncEmbed')?.addEventListener('click', async () => {
  $('embedHealthBox').textContent = tra('app.syncing', '同步索引中…');
  const wasChecked = Boolean($('cfgEmbedEnabled').checked);
  if (!wasChecked) $('cfgEmbedEnabled').checked = true;
  const res = await api('/api/embedding/sync', 'POST', { ...readFormEmbeddingCfg(), enabled: true });
  const hint = wasChecked ? '' : tra('app.syncHint', '（已同步并勾选，记得点下方「保存配置」）');
  const reason = res.fallbackReason || tra('app.syncOffline', '服务未连通');
  $('embedHealthBox').textContent = res.ok
    ? tra('app.syncOk', `同步完成：本次新增 ${res.indexed} 条（情景 ${res.episodesIndexed} + 体验 ${res.experiencesIndexed}），共 ${res.totalVectors} 条向量${hint}`, { n: res.indexed, ep: res.episodesIndexed, ex: res.experiencesIndexed, total: res.totalVectors, hint })
    : tra('app.syncFail', `未同步（${reason}，已自动保留关键词检索）`, { reason });
});
(async () => {
  window.SoulMemoryConfig?.init();
  window.SoulI18n?.onChange(() => {
    syncOralQuestionLabels();
    void refreshArchive({ preserveInputs: true });
    void refreshConfigAndSockets({ preserveInputs: true });
  });
  await Promise.all([
    window.SoulWorkspace.init(), refreshArchive(), loadOralQuestions(),
    refreshConfigAndSockets(), window.SoulInnerLife?.init(), window.SoulPhase2?.init(),
  ]);
  if (window.location.hash === '#phase2') document.querySelector('.tab[data-tab="phase2"]')?.click();
})();
