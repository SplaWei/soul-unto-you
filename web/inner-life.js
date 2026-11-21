(() => {
  const $i = (id) => document.getElementById(id);
  const tri = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);
  let lastInnerData = null;

  async function ilApi(url, method = 'GET', body) {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    return res.json();
  }

  function mountInnerPanel() {
    const root = $i('panel-inner');
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = '1';
    root.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2 id="ilDrivesHeading"></h2>
            <span class="badge" id="ilEpistemicBadge"></span>
          </div>
          <p class="muted" id="ilDrivesDesc"></p>
          <div id="ilDrivesBars"></div>
          <div class="row-gap" style="margin-top:10px;">
            <button class="btn small" id="ilPresetSkeptical" type="button"></button>
            <button class="btn small primary" id="ilPresetBelieved" type="button"></button>
            <button class="btn small" id="ilPresetDismissed" type="button"></button>
            <button class="btn small gold" id="ilPresetCloseness" type="button"></button>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2 id="ilHbHeading"></h2>
            <span class="badge" id="ilHbBadge"></span>
          </div>
          <p class="muted" id="ilHbDesc"></p>
          <div class="row-gap">
            <button class="btn gold" id="ilBtnHeartbeat" type="button"></button>
            <button class="btn small" id="ilBtnHbDiary" type="button"></button>
            <button class="btn small" id="ilBtnHbDesire" type="button"></button>
            <button class="btn small primary" id="ilBtnHbReach" type="button"></button>
          </div>
          <div class="result-banner hidden" id="ilHbResult"></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2 id="ilDesiresHeading"></h2></div>
          <p class="muted" id="ilDesiresDesc"></p>
          <div class="list-box" id="ilDesiresList"></div>
          <form class="inline-form" id="ilDesireForm">
            <input id="ilDesireTitle" type="text" required>
            <input id="ilDesireDetail" type="text" required>
            <button class="btn small primary" id="ilBtnAddDesire" type="submit"></button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><h2 id="ilDiaryHeading"></h2></div>
          <div class="list-box" id="ilDiaryList"></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <h2 id="ilSelfHeading"></h2>
            <button class="btn small gold" id="ilBtnEvolve" type="button"></button>
          </div>
          <pre class="mono-box" id="ilEvolvingBox"></pre>
        </div>
        <div class="card">
          <div class="card-head"><h2 id="ilBeliefsHeading"></h2></div>
          <p class="muted" id="ilBeliefsDesc"></p>
          <div class="list-box" id="ilBeliefsList"></div>
        </div>
      </div>
    `;
    syncInnerStaticText();
  }

  function syncInnerStaticText() {
    if (!$i('ilDrivesHeading')) return;
    $i('ilDrivesHeading').textContent = tri('il.drivesTitle', 'DRIVES · 五维动态内驱力与认知态度');
    $i('ilDrivesDesc').textContent = tri('il.drivesDesc', '内在驱力决定了她对书本/口述先验知识的态度（笃信采纳 / 半信半疑·求证 / 漫不经心），并随真实实践不断波动。');
    $i('ilPresetSkeptical').textContent = tri('il.presetSkeptical', '调为好奇半信半疑态');
    $i('ilPresetBelieved').textContent = tri('il.presetBelieved', '调为高警觉笃心态');
    $i('ilPresetDismissed').textContent = tri('il.presetDismissed', '调为玩心漫不经心态');
    $i('ilPresetCloseness').textContent = tri('il.presetCloseness', '调为高思念想找你态');
    $i('ilHbHeading').textContent = tri('il.hbTitle', 'HEARTBEAT · 静默灵魂心搏（无人打扰时的自主生活）');
    if (!$i('ilHbBadge').dataset.active) $i('ilHbBadge').textContent = tri('il.idle', '待触发');
    $i('ilHbDesc').textContent = tri('il.hbDesc', '静默期心搏唤醒时，她会在「安静陪伴 / 写私密日记 / 更新微心愿 / 主动找你搭话」四者间自主抉择。');
    $i('ilBtnHeartbeat').textContent = tri('il.btnHb', '触发自然心搏（自主四选一）');
    $i('ilBtnHbDiary').textContent = tri('il.btnHbDiary', '心搏写日记');
    $i('ilBtnHbDesire').textContent = tri('il.btnHbDesire', '心搏立心愿');
    $i('ilBtnHbReach').textContent = tri('il.btnHbReach', '心搏主动找你');
    $i('ilDesiresHeading').textContent = tri('il.desiresTitle', 'DESIRES · 自主微心愿清单 (INNER-LIFE/desires.json)');
    $i('ilDesiresDesc').textContent = tri('il.desiresDesc', '区别于人类安排的待办约定，这是她自己从实践经历或好奇心中长出来的小目的。');
    $i('ilDesireTitle').placeholder = tri('il.desireTitlePh', '微心愿标题');
    $i('ilDesireDetail').placeholder = tri('il.desireDetailPh', '为什么想做这件事');
    $i('ilBtnAddDesire').textContent = tri('il.addDesire', '记下心愿');
    $i('ilDiaryHeading').textContent = tri('il.diaryTitle', 'DIARY · 私密心路日记 (INNER-LIFE/diary.jsonl)');
    $i('ilSelfHeading').textContent = tri('il.selfTitle', 'SELF · 活体自我演化快照 (EVOLVING-SELF.md)');
    $i('ilBtnEvolve').textContent = tri('il.btnEvolve', '触发自我演化反思');
    $i('ilBeliefsHeading').textContent = tri('il.beliefsTitle', 'BELIEFS · 时序信念年轮 (MEMORIES/beliefs.jsonl)');
    $i('ilBeliefsDesc').textContent = tri('il.beliefsDesc', '保留“从前以为 vs 现在相信”的每一道认知演变轨迹，绝不删档。');
    if (!lastInnerData) {
      $i('ilEpistemicBadge').textContent = tri('il.loading', '加载中…');
      $i('ilEvolvingBox').textContent = tri('il.loading', '加载中…');
    }
  }

  function setEmptyHint(box, msg) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = msg;
    box.replaceChildren(empty);
  }

  function renderDrives(drives, label) {
    $i('ilEpistemicBadge').textContent = window.SoulI18n?.isEn()
      ? (drives.epistemicTendency || label)
      : (label || drives.epistemicTendency);
    const box = $i('ilDrivesBars');
    box.replaceChildren();
    const dims = [
      [tri('il.dimCuriosity', '好奇求证 (CURIOSITY)'), Math.round(drives.curiosity * 100), 'var(--bar-1)'],
      [tri('il.dimCloseness', '亲密思念 (CLOSENESS)'), Math.round(drives.closeness * 100), 'var(--bar-2)'],
      [tri('il.dimSafety', '安全警觉 (SAFETY)'), Math.round(drives.safety * 100), 'var(--bar-3)'],
      [tri('il.dimPlayfulness', '玩心松弛 (PLAYFULNESS)'), Math.round(drives.playfulness * 100), 'var(--bar-4)'],
      [tri('il.dimEnergy', '身心精力 (ENERGY)'), Math.round(drives.energy), 'var(--bar-5)'],
    ];
    for (const [name, pct, color] of dims) {
      const row = document.createElement('div');
      row.className = 'drive-row';
      const head = document.createElement('div');
      head.className = 'drive-head';
      const nEl = document.createElement('span');
      nEl.textContent = name;
      const pEl = document.createElement('span');
      pEl.textContent = `${pct}%`;
      head.append(nEl, pEl);
      const bar = document.createElement('div');
      bar.className = 'drive-bar';
      const fill = document.createElement('div');
      fill.className = 'drive-fill';
      fill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
      fill.style.background = color;
      bar.appendChild(fill);
      row.append(head, bar);
      box.appendChild(row);
    }
  }

  function renderDesiresAndDiary(desires, diary) {
    const dBox = $i('ilDesiresList');
    dBox.replaceChildren();
    for (const d of (desires || []).filter((x) => x.status === 'active').reverse()) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const txt = document.createElement('span');
      const tag = document.createElement('span');
      tag.className = 'tag warm';
      tag.textContent = `${d.triggerSource} · ${Math.round(d.urgency * 100)}%`;
      txt.append(tag, document.createTextNode(`${d.title}：${d.detail}`));
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = tri('il.fulfill', '✓ 实现');
      btn.onclick = async () => {
        await ilApi('/api/inner-life/desire/fulfill', 'POST', { id: d.id });
        await refreshInnerLife();
      };
      item.append(txt, btn);
      dBox.appendChild(item);
    }
    if (!dBox.children.length) setEmptyHint(dBox, tri('il.noDesires', '暂无进行中的自主微心愿'));

    const jBox = $i('ilDiaryList');
    jBox.replaceChildren();
    for (const entry of (diary || []).slice(-12).reverse()) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const wrap = document.createElement('span');
      const tag = document.createElement('span');
      tag.className = 'tag body';
      tag.textContent = `${entry.actionTaken} · ${entry.mood}`;
      wrap.append(tag, document.createTextNode(`[seq:${entry.seq}] ${entry.thought}`));
      item.appendChild(wrap);
      jBox.appendChild(item);
    }
    if (!jBox.children.length) setEmptyHint(jBox, tri('il.noDiary', '暂无内心日记，点击上方「触发自然心搏」即可观看。'));
  }

  function renderEvolution(md, beliefs) {
    $i('ilEvolvingBox').textContent = md || tri('il.noEvolving', '尚无自我演化快照');
    const bBox = $i('ilBeliefsList');
    bBox.replaceChildren();
    for (const b of (beliefs || []).slice().reverse()) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const wrap = document.createElement('span');
      const tag = document.createElement('span');
      tag.className = `tag ${b.supersededAtSeq ? 'pain' : 'warm'}`;
      const pct = Math.round(b.confidence * 100);
      tag.textContent = b.supersededAtSeq
        ? tri('il.superseded', `已被 seq:${b.supersededAtSeq} 修正`, { seq: b.supersededAtSeq })
        : tri('il.held', `当前坚信 · ${pct}%`, { pct });
      wrap.append(tag, document.createTextNode(`[${b.topic} | seq:${b.validFromSeq}] ${b.statement}`));
      item.appendChild(wrap);
      bBox.appendChild(item);
    }
    if (!bBox.children.length) setEmptyHint(bBox, tri('il.noBeliefs', '暂无时序信念记录，随实践遭遇与做梦反思自动生长。'));
  }

  function renderInnerSnapshot(res) {
    renderDrives(res.drives, res.epistemicLabel);
    renderDesiresAndDiary(res.desires, res.diary);
    renderEvolution(res.evolvingSelfMarkdown, res.beliefs);
  }

  async function refreshInnerLife() {
    mountInnerPanel();
    const res = await ilApi('/api/inner-life');
    if (!res.ok) return;
    lastInnerData = res;
    renderInnerSnapshot(res);
  }

  async function triggerHb(forceAction) {
    const res = await ilApi('/api/inner-life/heartbeat', 'POST', { isSilentIdle: true, ...(forceAction ? { forceAction } : {}) });
    if (!res.ok) return;
    $i('ilHbBadge').dataset.active = '1';
    $i('ilHbBadge').textContent = res.action;
    const banner = $i('ilHbResult');
    banner.classList.remove('hidden');
    const mood = res.diaryEntry?.mood || '';
    const text = res.proactiveMessage || res.diaryEntry?.thought || '';
    banner.textContent = tri('il.hbBanner', `💓 心搏决定 [${res.action}]（${mood}）：${text}`, { action: res.action, mood, text });
    if (res.proactiveMessage && window.SoulWorkspace) {
      window.SoulWorkspace.appendToPane('B', 'soul', tri('il.hbReachMsg', '💓 静默心搏主动来找你了'), res.proactiveMessage);
    }
    await refreshInnerLife();
  }

  function bindEvents() {
    const presets = [
      ['ilPresetSkeptical', { curiosity: 0.78, safety: 0.4, playfulness: 0.62, closeness: 0.65 }],
      ['ilPresetBelieved', { safety: 0.85, curiosity: 0.45, playfulness: 0.38, closeness: 0.78 }],
      ['ilPresetDismissed', { playfulness: 0.86, curiosity: 0.55, safety: 0.3, closeness: 0.6 }],
      ['ilPresetCloseness', { closeness: 0.88, curiosity: 0.62, safety: 0.48, playfulness: 0.6 }],
    ];
    for (const [id, patch] of presets) {
      $i(id)?.addEventListener('click', async () => {
        await ilApi('/api/inner-life/drives', 'POST', patch);
        await refreshInnerLife();
      });
    }
    $i('ilBtnHeartbeat')?.addEventListener('click', () => void triggerHb());
    $i('ilBtnHbDiary')?.addEventListener('click', () => void triggerHb('write_diary'));
    $i('ilBtnHbDesire')?.addEventListener('click', () => void triggerHb('update_desire'));
    $i('ilBtnHbReach')?.addEventListener('click', () => void triggerHb('reach_out'));
    $i('ilBtnEvolve')?.addEventListener('click', async () => {
      const res = await ilApi('/api/inner-life/evolve', 'POST', {});
      if (res.ok) renderEvolution(res.evolvingSelfMarkdown, res.beliefs);
    });
    $i('ilDesireForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await ilApi('/api/inner-life/desire', 'POST', { title: $i('ilDesireTitle').value, detail: $i('ilDesireDetail').value });
      $i('ilDesireTitle').value = '';
      $i('ilDesireDetail').value = '';
      await refreshInnerLife();
    });
  }

  window.SoulInnerLife = {
    init: async () => {
      mountInnerPanel();
      bindEvents();
      window.SoulI18n?.onChange(() => {
        syncInnerStaticText();
        if (lastInnerData) renderInnerSnapshot(lastInnerData);
      });
      await refreshInnerLife();
    },
    refresh: refreshInnerLife,
  };
})();
