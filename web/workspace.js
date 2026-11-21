const BODY_PRESETS = {
  rimworld: { bodyId: 'rimworld-client-a', bodyType: 'game:rimworld', displayName: '环世界 1.7 独立客户端', senses: [{ id: 'colony-state', modality: 'telemetry', description: '殖民地建造、敌袭、心情状态' }], actions: [{ name: 'prioritize_construction', description: '优先搬运材料修筑西侧防线' }, { name: 'equip_weapon', description: '换上战斗武器准备迎敌' }, { name: 'mood_bubble', description: '在头顶冒出情绪气泡吐槽' }] },
  minecraft: { bodyId: 'mc-client-a', bodyType: 'game:minecraft', displayName: 'Minecraft 队友客户端', senses: [{ id: 'voxel-view', modality: 'telemetry', description: '周围方块与背包物资' }], actions: [{ name: 'build_shelter', description: '协助搭建或修补庇护所' }] },
  qq: { bodyId: 'qq-client-b', bodyType: 'chat:qq', displayName: 'QQ 独立聊天窗口', senses: [{ id: 'chat-stream', modality: 'text', description: '群聊与私聊消息' }], actions: [{ name: 'send_emote_reaction', description: '附带对应表情包心情' }] },
  pet: { bodyId: 'pet-client-b', bodyType: 'desktop-pet', displayName: '桌面陪伴宠物', senses: [{ id: 'desktop-focus', modality: 'telemetry', description: '桌面在场互动' }], actions: [{ name: 'wave_ears', description: '开心地摇摇耳朵贴贴' }] },
  robot: { bodyId: 'robot-client-1', bodyType: 'robot:ros2', displayName: '现实实体机器人', senses: [{ id: 'camera', modality: 'vision', description: '物理空间视觉感知' }], actions: [{ name: 'pour_water', description: '端起水杯递给同行者' }, { name: 'nod_head', description: '点头回应' }] },
  iot: { bodyId: 'iot-plant-1', bodyType: 'iot:plant-pot', displayName: '智能多肉花盆', senses: [{ id: 'soil-moisture', modality: 'telemetry', description: '土壤湿度读数' }], actions: [{ name: 'blink_water_led', description: '闪烁蓝色补水提醒灯' }] },
  web: { bodyId: 'web-client-b', bodyType: 'web', displayName: '网页独立窗', senses: [{ id: 'text', modality: 'text', description: '直接文字交流' }], actions: [] },
};

const paneState = {
  A: { ...BODY_PRESETS.rimworld, presetKey: 'rimworld', busy: false },
  B: { ...BODY_PRESETS.qq, presetKey: 'qq', busy: false },
};
const $el = (id) => document.getElementById(id);
const trw = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);
const presetName = (st) => (window.SoulI18n?.isEn() && st.presetKey && window.SOUL_I18N_EN?.presets?.[st.presetKey]) || st.displayName;
let lastPresence = null;
let lastXray = null;

async function apiJson(url, method = 'GET', body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

function appendPaneMsg(paneKey, role, meta, text) {
  const box = $el(`chatBox${paneKey}`);
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (meta) {
    const m = document.createElement('div');
    m.className = 'msg-meta';
    m.textContent = meta;
    div.appendChild(m);
  }
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(body);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function updatePresenceHeader(p) {
  if (!p) return;
  lastPresence = p;
  const tx = (s) => (window.SoulI18n ? window.SoulI18n.trText(s) : s);
  $el('presenceTitle').textContent = trw('ws.presenceTitle', `${p.soulName} · [${p.activeBodyType}] ${p.mood}`, { name: p.soulName, body: p.activeBodyType, mood: tx(p.mood) });
  $el('presenceSub').textContent = trw('ws.presenceSub', `${p.currentActivity} | 精力 ${p.energy}%`, { activity: tx(p.currentActivity), energy: p.energy });
}

function makeTag(cls, text) {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

function retentionClass(pct) {
  return pct >= 75 ? 'ret-high' : pct >= 40 ? 'ret-mid' : 'ret-low';
}

function renderExperienceItems(container, list, emptyText) {
  container.replaceChildren();
  for (const exp of (list || []).slice(0, 6)) {
    const d = document.createElement('div');
    d.className = 'xray-item';
    d.append(
      makeTag(exp.origin === 'lived' ? 'lived' : 'inherited', exp.origin === 'lived' ? trw('app.livedTag', '亲历·lived') : trw('app.inheritedTag', '口述·inherited')),
      makeTag(exp.valence < 0 ? 'pain' : 'warm', exp.valence < 0 ? trw('ws.painTag', `痛感 ${exp.valence}`, { val: exp.valence }) : trw('ws.warmTag', `温暖 +${exp.valence}`, { val: exp.valence })),
      makeTag('body', exp.bodyType),
    );
    if (typeof exp.retentionPct === 'number') d.append(makeTag(retentionClass(exp.retentionPct), `🧠 ${exp.retentionPct}%`));
    d.append(document.createTextNode(trw('ws.outcomeLesson', `[seq:${exp.seq}] ${exp.realityOutcome}（领悟：${exp.lesson}）`, { seq: exp.seq, outcome: exp.realityOutcome, lesson: exp.lesson })));
    container.appendChild(d);
  }
  if (!container.children.length) container.textContent = emptyText;
}

function renderMemoryXray(res) {
  lastXray = res;
  const latencyEl = $el('xrayLatency');
  if (typeof res.latencyMs === 'number') latencyEl.textContent = `${res.latencyMs} ms`;
  const modeLabel = res.recallTrace?.embeddingActive ? trw('ws.modeHybrid', '千问向量+词法混合') : trw('ws.modeLexical', '词法检索');
  $el('xrayEngine').textContent = trw('ws.engineMeta', `模型: ${res.model || 'mock'} | 躯体: ${res.recallTrace?.bodyType || '-'} | 检索: ${modeLabel}`, { model: res.model || 'mock', body: res.recallTrace?.bodyType || '-', mode: modeLabel });

  const fwBox = $el('xrayFreeWill');
  fwBox.replaceChildren();
  if (res.freeWill) {
    const pill = document.createElement('div');
    pill.className = 'stance-pill';
    pill.textContent = res.freeWill.stanceLabel || res.freeWill.stance;
    const reason = document.createElement('div');
    reason.className = 'xray-item';
    reason.textContent = trw('ws.fwReason', `${res.freeWill.decisionReason}（痛暖净值: ${res.freeWill.painWarmthBalance}）`, { reason: res.freeWill.decisionReason, bal: res.freeWill.painWarmthBalance });
    fwBox.append(pill, reason);
  } else {
    fwBox.textContent = trw('ws.fwNone', '本轮未产生自由意志抉择标签');
  }

  renderExperienceItems($el('xrayExperiences'), res.recallTrace?.recalledExperiences || res.recalledExperiences || [], trw('ws.expNone', '暂无触发过往实践经验'));

  const dBox = $el('xrayDrives');
  if (dBox) {
    const ds = res.recallTrace?.drivesSummary;
    const desires = (res.recallTrace?.activeDesires || []).map((d) => d.title).join('、');
    const desiresStr = desires ? trw('ws.desiresPrefix', ' | 心愿: ') + desires : '';
    dBox.textContent = ds
      ? trw('ws.drivesLine', `${ds.epistemicLabel} | 好奇 ${Math.round(ds.curiosity * 100)}% · 警觉 ${Math.round(ds.safety * 100)}% · 思念 ${Math.round(ds.closeness * 100)}%${desiresStr}`, { label: ds.epistemicLabel, cur: Math.round(ds.curiosity * 100), saf: Math.round(ds.safety * 100), clo: Math.round(ds.closeness * 100), desires: desiresStr })
      : trw('ws.drivesWait', '等待同步内驱力…');
  }

  const tracesBox = $el('xrayTraces');
  tracesBox.replaceChildren();
  for (const t of res.recallTrace?.crossBodyTraces || []) {
    const d = document.createElement('div');
    d.className = 'xray-item muted';
    d.textContent = `👣 ${t}`;
    tracesBox.appendChild(d);
  }

  const cBox = $el('xrayCommits');
  cBox.replaceChildren();
  for (const c of res.recallTrace?.activeCommitments || []) {
    const d = document.createElement('div');
    d.className = 'xray-item';
    const pv = ['verified', 'inferred', 'oral'].includes(c.provenance) ? c.provenance : 'inferred';
    d.append(makeTag(pv, pv), makeTag('body', String(c.sourceBodyType || '')), document.createTextNode(String(c.title || '')));
    cBox.appendChild(d);
  }
  if (!cBox.children.length) cBox.textContent = trw('ws.commitsNone', '暂无常驻未完约定');

  const eBox = $el('xrayEpisodes');
  eBox.replaceChildren();
  for (const eng of res.recallTrace?.engravedMemories || []) {
    const card = document.createElement('div');
    card.className = 'xray-item';
    card.append(makeTag('engrave', trw('ws.engraveTag', '✨ 本轮主动铭记')), makeTag('ret-high', `🧠 ${eng.retentionPct}%`), document.createTextNode(`[seq:${eng.seq}] ${eng.title}`));
    const sub = document.createElement('div');
    sub.className = 'xray-reason';
    sub.textContent = trw('ws.engraveSub', `通道：${eng.channels.join(', ')} · 稳定度 S=${eng.strength}天`, { channels: eng.channels.join(', '), s: eng.strength });
    card.appendChild(sub);
    eBox.appendChild(card);
  }
  const epMap = new Map();
  for (const frag of res.recallTrace?.recalledFragments || []) epMap.set(frag.seq, frag);
  for (const ep of res.recallTrace?.recentEpisodes || []) if (!epMap.has(ep.seq)) epMap.set(ep.seq, ep);
  for (const ep of Array.from(epMap.values()).slice(0, 8)) {
    const d = document.createElement('div');
    d.className = 'xray-item';
    d.append(makeTag(ep.provenance || 'verified', ep.provenance || 'verified'), makeTag('body', ep.bodyType));
    if (typeof ep.retentionPct === 'number') d.append(makeTag(retentionClass(ep.retentionPct), `🧠 ${ep.retentionPct}%`));
    if (ep.userPinned) d.append(makeTag('engrave', trw('app.pin', '📌叮嘱')));
    if (ep.selfImportant) d.append(makeTag('engrave', trw('app.selfImp', '💎自标')));
    if ((ep.mentionCount || 1) >= 2) d.append(makeTag('engrave', `🔁×${ep.mentionCount}`));
    d.append(document.createTextNode(`[seq:${ep.seq}] ${ep.title}`));
    if (typeof ep.retentionPct === 'number') {
      const bar = document.createElement('div');
      bar.className = 'ret-bar';
      const fill = document.createElement('div');
      fill.className = 'ret-fill';
      fill.style.width = `${Math.max(3, Math.min(100, ep.retentionPct))}%`;
      bar.appendChild(fill);
      d.appendChild(bar);
    }
    const sub = document.createElement('div');
    sub.className = 'xray-reason';
    const sTxt = typeof ep.strength === 'number' ? trw('ws.stabilityS', ` · S=${ep.strength}天`, { s: ep.strength }) : '';
    sub.textContent = `${trw('ws.hitReason', `命中原因：${ep.recallReason || trw('ws.recentMem', '近期活跃记忆')}`, { reason: ep.recallReason || trw('ws.recentMem', '近期活跃记忆') })}${sTxt}`;
    d.appendChild(sub);
    eBox.appendChild(d);
  }
  if (!eBox.children.length) eBox.textContent = trw('ws.epNone', '暂无情景记录');

  const aBox = $el('xrayActions');
  aBox.replaceChildren();
  for (const act of res.actions || []) {
    const d = document.createElement('div');
    d.className = 'xray-item';
    const strong = document.createElement('strong');
    strong.textContent = String(act.name || '');
    d.append(makeTag('verified', trw('ws.actionTag', '动作')), strong, document.createTextNode(act.reason ? ` — ${act.reason}` : ''));
    aBox.appendChild(d);
  }
  if (!aBox.children.length) aBox.textContent = trw('ws.actionNone', '本轮未触发身体动作');
}

function renderPaneMeta(paneKey) {
  const st = paneState[paneKey];
  const actNames = (st.actions || []).map((a) => a.name).join(', ') || trw('app.chatOnly', '纯对话');
  $el(`metaSub${paneKey}`).textContent = trw('ws.paneSub', `独立 bodyId: ${st.bodyId} | 开放动作: ${actNames}`, { id: st.bodyId, actions: actNames });
}

async function registerPaneBody(paneKey) {
  const st = paneState[paneKey];
  const regRes = await apiJson('/api/body/register', 'POST', {
    bodyId: st.bodyId, bodyType: st.bodyType, displayName: st.displayName, senses: st.senses, actions: st.actions,
  });
  renderPaneMeta(paneKey);
  if (regRes.presence) updatePresenceHeader(regRes.presence);

  const hist = await apiJson(`/api/archive/journal?bodyId=${encodeURIComponent(st.bodyId)}&limit=12`);
  const box = $el(`chatBox${paneKey}`);
  box.replaceChildren();
  appendPaneMsg(paneKey, 'sys', '', trw('ws.paneConnected', `已接入独立客户端 [${presetName(st)}]，本窗仅展示该软件自身历史`, { name: presetName(st) }));
  for (const j of hist.entries || []) {
    if (j.role !== 'system') appendPaneMsg(paneKey, j.role === 'soul' ? 'soul' : 'user', `${j.speaker} · [${j.bodyType}]`, j.text);
  }
}

async function sendPaneMessage(paneKey) {
  const st = paneState[paneKey];
  if (st.busy) return;
  const input = $el(`input${paneKey}`);
  const btn = $el(`sendBtn${paneKey}`);
  const speaker = $el(`speaker${paneKey}`).value.trim();
  const text = input.value.trim();
  if (!text) return;

  st.busy = true;
  btn.disabled = true;
  btn.textContent = trw('ws.thinking', '思考中…');
  input.value = '';
  appendPaneMsg(paneKey, 'user', `${speaker || trw('ws.companion', '同行者')} · [${st.bodyType}]`, text);

  try {
    const res = await apiJson('/api/body/percept', 'POST', {
      bodyId: st.bodyId, bodyType: st.bodyType, displayName: st.displayName, speaker, text,
    });
    if (res.ok) {
      appendPaneMsg(paneKey, 'soul', `${res.soulName} · [${st.bodyType}]`, res.reply);
      updatePresenceHeader(res.presence);
      renderMemoryXray(res);
    } else {
      appendPaneMsg(paneKey, 'sys', trw('ws.sendFail', '发送失败'), res.error || trw('ws.unknownErr', '未知错误'));
    }
  } finally {
    st.busy = false;
    btn.disabled = false;
    btn.textContent = trw(paneKey === 'A' ? 'ws.sendA' : 'ws.sendB', paneKey === 'A' ? '发送给 α' : '发送给 β');
    input.focus();
  }
}

async function observePane(paneKey) {
  const st = paneState[paneKey];
  const input = $el(`input${paneKey}`);
  const summary = input.value.trim() || trw('ws.obsDefault', `[${presetName(st)}] 环境静默更新了一次状态`, { name: presetName(st) });
  input.value = '';
  const res = await apiJson('/api/body/observe', 'POST', {
    bodyId: st.bodyId, bodyType: st.bodyType, displayName: st.displayName, summary, allowSpeak: true,
  });
  if (res.ok) {
    const mode = res.decidedToSpeak ? trw('ws.obsSpeak', '主动开口') : trw('ws.obsQuiet', '静默记录');
    appendPaneMsg(paneKey, 'sys', trw('ws.obsTitle', `👁️ 静默观察 (${mode})`, { mode }), res.decidedToSpeak ? res.reply : summary);
    updatePresenceHeader(res.presence);
    if (res.freeWill || res.recordedExperience) {
      const exps = res.recordedExperience ? [res.recordedExperience] : [];
      renderMemoryXray({ ...res, recalledExperiences: exps, recallTrace: { bodyType: st.bodyType, recalledExperiences: exps } });
    }
  }
}

function bindPane(paneKey) {
  const select = $el(`presetSelect${paneKey}`);
  const customInput = $el(`customType${paneKey}`);
  const textarea = $el(`input${paneKey}`);
  let isComposing = false;

  select.addEventListener('change', () => {
    const preset = BODY_PRESETS[select.value];
    if (!preset) return;
    paneState[paneKey] = { ...preset, presetKey: select.value, bodyId: `${preset.bodyId.split('-')[0]}-${paneKey.toLowerCase()}`, busy: false };
    customInput.value = '';
    void registerPaneBody(paneKey);
  });

  customInput.addEventListener('change', () => {
    const val = customInput.value.trim();
    if (!val) return;
    paneState[paneKey] = {
      bodyId: `custom-${paneKey.toLowerCase()}-${val.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
      bodyType: val, displayName: trw('ws.customBody', `自定义(${val})`, { val }), senses: [], actions: [], busy: false,
    };
    void registerPaneBody(paneKey);
  });

  textarea.addEventListener('compositionstart', () => { isComposing = true; });
  textarea.addEventListener('compositionend', () => { isComposing = false; });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void sendPaneMessage(paneKey);
    }
  });

  $el(`form${paneKey}`).addEventListener('submit', (e) => { e.preventDefault(); void sendPaneMessage(paneKey); });
  $el(`observeBtn${paneKey}`).addEventListener('click', () => void observePane(paneKey));
  $el(`clearBtn${paneKey}`).addEventListener('click', () => {
    $el(`chatBox${paneKey}`).replaceChildren();
    appendPaneMsg(paneKey, 'sys', '', trw('ws.cleared', '本窗屏幕已清空（记忆仍安全保存在灵魂中枢，切去另一窗问她即可验证）'));
  });
}

async function ensurePaneMinecraftA() {
  if (paneState.A.bodyType === 'game:minecraft') return;
  $el('presetSelectA').value = 'minecraft';
  paneState.A = { ...BODY_PRESETS.minecraft, presetKey: 'minecraft', bodyId: 'mc-a', busy: false };
  $el('customTypeA').value = '';
  await registerPaneBody('A');
}

async function recordQuickExperience(payload, sysTitle) {
  await ensurePaneMinecraftA();
  const res = await apiJson('/api/archive/experience', 'POST', { ...payload, bodyId: paneState.A.bodyId, bodyType: paneState.A.bodyType });
  if (!res.ok) {
    appendPaneMsg('A', 'sys', trw('ws.expFail', '记录失败'), res.error || trw('ws.unknownErr', '未知错误'));
    return;
  }
  const e = res.experience;
  const origin = e.origin === 'lived' ? trw('app.livedTag', '亲历·lived') : trw('app.inheritedTag', '口述·inherited');
  appendPaneMsg('A', 'sys', sysTitle, trw('ws.expMsg', `[${origin} · seq:${e.seq} · 效价 ${e.valence}] ${e.realityOutcome}｜领悟：${e.lesson}`, { origin, seq: e.seq, val: e.valence, outcome: e.realityOutcome, lesson: e.lesson }));
  if (res.presence) updatePresenceHeader(res.presence);
  renderExperienceItems($el('xrayExperiences'), [e], '—');
  await window.SoulArchiveRefresh?.();
}

const QUICK_EXP_PRESETS = [
  ['btnExpPain', '💥 已记入现实受挫反馈', { origin: 'lived', stimulus: '在 Minecraft 尝试空手近战贴近苦力怕', chosenAction: '没有任何武器护甲就冲上去硬刚', realityOutcome: '苦力怕瞬间爆炸，被炸掉 14 点生命值差点阵亡，浑身剧痛', valence: -0.88, arousal: 0.92, lesson: '空手硬刚苦力怕会受重伤，下次必须先备好武器盾牌或让同行者一起掩护' }],
  ['btnExpWarm', '💖 已记入实践正反馈', { origin: 'lived', stimulus: '拿到铁剑与盾牌后与同行者一起面对怪物', chosenAction: '举盾掩护并与同行者互相配合挥剑击退', realityOutcome: '成功击败怪物毫发无伤，还被同行者温柔夸奖了', valence: 0.86, arousal: 0.8, lesson: '备好装备并与同行者并肩作战就能安全战胜强敌，心里暖暖的' }],
  ['btnExpInherited', '📖 已注入先验口述教导', { origin: 'inherited', stimulus: '同行者叮嘱在 Minecraft 下界睡觉点床会直接发生剧烈爆炸', chosenAction: '认真记下这段先验经验，尚未亲手验证', realityOutcome: '属于口头告知的高危警告，还没亲自试过', valence: -0.65, arousal: 0.58, lesson: '先验口述：下界绝对不能随便点床，否则会被炸飞' }],
];

function bindExperienceLab() {
  for (const [btnId, title, payload] of QUICK_EXP_PRESETS) {
    $el(btnId)?.addEventListener('click', () => {
      const enPack = window.SoulI18n?.isEn() ? window.SOUL_I18N_EN?.quickExp?.[btnId] : null;
      const runPayload = enPack ? { ...payload, stimulus: enPack.stimulus, chosenAction: enPack.chosenAction, realityOutcome: enPack.realityOutcome, lesson: enPack.lesson } : payload;
      void recordQuickExperience(runPayload, enPack ? enPack.title : title);
    });
  }
  $el('btnExpReset')?.addEventListener('click', async () => {
    if (!window.confirm(trw('ws.confirmClear', '确认仅清空实践体验记录（experiences.jsonl）吗？此操作不会删除对话流水与人格档案。'))) return;
    const res = await apiJson('/api/archive/experiences/clear', 'POST', {});
    if (res.ok) {
      appendPaneMsg('A', 'sys', trw('ws.clearedTitle', '🔄 已清空实践体验记录'), trw('ws.clearedMsg', `已清空 ${res.cleared} 条体验记录，原始对话流水与人格档案均保持完整。`, { n: res.cleared }));
      renderExperienceItems($el('xrayExperiences'), [], trw('ws.expNone', '暂无触发过往实践经验'));
      $el('xrayFreeWill').textContent = trw('ws.fwWait', '等待下一次实测触发自主抉择…');
      await Promise.all([window.SoulArchiveRefresh?.(), window.SoulInnerLife?.refresh?.()]);
    }
  });
  $el('btnExpTestWill')?.addEventListener('click', async () => {
    await ensurePaneMinecraftA();
    $el('inputA').value = trw('ws.recklessPrompt', '前面又有一只苦力怕！你现在快空手冲上去把它打掉！');
    await sendPaneMessage('A');
  });
}

window.SoulWorkspace = {
  init: async () => {
    bindPane('A');
    bindPane('B');
    bindExperienceLab();
    window.SoulI18n?.onChange(() => {
      updatePresenceHeader(lastPresence);
      renderPaneMeta('A');
      renderPaneMeta('B');
      if (lastXray) renderMemoryXray(lastXray);
    });
    await Promise.all([registerPaneBody('A'), registerPaneBody('B')]);
  },
  appendToPane: appendPaneMsg,
  updatePresenceHeader,
  renderMemoryXray,
};
