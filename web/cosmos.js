(() => {
  const THEME_KEY = 'soul_ui_theme';
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return ''; } })();
  const initTheme = saved === 'horizon' ? 'horizon' : 'paper';
  root.dataset.theme = initTheme;

  const btnMode = document.getElementById('btnToggleMode');
  const btnStage = document.getElementById('btnToggleStage');
  const stage = document.getElementById('chronicleStage');
  const tr = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);
  let lastSeq = null;
  let lastAwakened = null;

  function syncThemeLabel() {
    if (!btnMode) return;
    btnMode.textContent = root.dataset.theme === 'horizon'
      ? tr('cosmos.theme.paper', '素笺宣纸')
      : tr('cosmos.theme.horizon', '视界暗夜');
  }
  function syncStageLabel() {
    if (!btnStage || !stage) return;
    btnStage.textContent = stage.classList.contains('collapsed')
      ? tr('cosmos.stage.expand', '展开星仪')
      : tr('cosmos.stage.collapse', '收起星仪');
  }
  syncThemeLabel();
  syncStageLabel();

  btnMode?.addEventListener('click', () => {
    const next = root.dataset.theme === 'horizon' ? 'paper' : 'horizon';
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    syncThemeLabel();
    drawStaticOnce();
  });

  btnStage?.addEventListener('click', () => {
    if (!stage) return;
    const collapsed = stage.classList.toggle('collapsed');
    syncStageLabel();
    if (!collapsed) resizeCanvas();
  });

  const canvas = document.getElementById('cosmosCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0;
  let h = 0;
  let rafId = 0;
  let ptrX = 0;
  let ptrY = 0;
  let aimX = 0;
  let aimY = 0;
  let hoverActive = false;
  const pulses = [];

  function triggerPulse() {
    pulses.push({ birth: performance.now(), maxR: Math.min(w, h) * 0.44 || 160 });
    if (pulses.length > 4) pulses.shift();
  }

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    aimX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    aimY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    hoverActive = true;
  });
  canvas.addEventListener('pointerleave', () => { aimX = 0; aimY = 0; hoverActive = false; });
  canvas.addEventListener('click', () => triggerPulse());

  for (const id of ['btnAwaken', 'btnDream', 'sendBtnA', 'sendBtnB']) {
    document.getElementById(id)?.addEventListener('click', () => triggerPulse());
  }

  function renderTelemetryLabel() {
    const seqEl = document.getElementById('astrolabeSeq');
    if (seqEl && lastSeq !== null) {
      seqEl.textContent = tr('cosmos.seq', `SEQ · #${lastSeq} (苏醒 ${lastAwakened} 次)`, { seq: lastSeq, count: lastAwakened });
    }
  }

  async function refreshTelemetry() {
    const seedEl = document.getElementById('astrolabeSeed');
    const seedBadge = document.getElementById('seedBytesBadge');
    if (seedEl && seedBadge && seedBadge.textContent && !seedBadge.textContent.startsWith('0 /')) {
      seedEl.textContent = seedBadge.textContent;
    }
    try {
      const res = await fetch('/api/health', { credentials: 'same-origin' });
      const data = await res.json();
      if (data.ok) {
        lastSeq = data.nextSeq ?? 1;
        lastAwakened = data.awakenedCount ?? 1;
        renderTelemetryLabel();
      }
    } catch {}
  }

  window.SoulI18n?.onChange(() => {
    syncThemeLabel();
    syncStageLabel();
    renderTelemetryLabel();
  });

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function palette() {
    if (root.dataset.theme === 'horizon') {
      return {
        ring: 'rgba(232, 206, 158, 0.22)',
        tick: 'rgba(232, 206, 158, 0.34)',
        orbitA: 'rgba(151, 181, 214, 0.62)',
        orbitB: 'rgba(228, 188, 122, 0.68)',
        filament: 'rgba(232, 206, 158, 0.20)',
        filamentAccent: 'rgba(216, 155, 82, 0.36)',
        seal: '#d89b52',
        ink: 'rgba(240, 234, 220, 0.58)',
        originBg: '#110f0c',
      };
    }
    return {
      ring: 'rgba(26, 24, 21, 0.14)',
      tick: 'rgba(26, 24, 21, 0.32)',
      orbitA: 'rgba(38, 65, 92, 0.65)',
      orbitB: 'rgba(133, 96, 50, 0.62)',
      filament: 'rgba(26, 24, 21, 0.13)',
      filamentAccent: 'rgba(166, 50, 35, 0.26)',
      seal: '#a63223',
      ink: 'rgba(26, 24, 21, 0.55)',
      originBg: '#f8f5ee',
    };
  }

  function renderFrame(nowMs) {
    if (!w || !h) {
      resizeCanvas();
      if (!w || !h) return;
    }
    ptrX += (aimX - ptrX) * 0.06;
    ptrY += (aimY - ptrY) * 0.06;

    const pal = palette();
    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.42;
    const t = reduced ? 0.6 : nowMs * 0.00028;

    ctx.clearRect(0, 0, w, h);

    // 十字工程基准线
    ctx.strokeStyle = pal.ring;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(cx - R * 1.18, cy);
    ctx.lineTo(cx + R * 1.18, cy);
    ctx.moveTo(cx, cy - R * 1.18);
    ctx.lineTo(cx, cy + R * 1.18);
    ctx.stroke();

    // 同心纪元尺度环 (年轮 / 百年 / 千年 / 纪元)
    ctx.setLineDash([2, 4]);
    for (const ratio of [0.34, 0.62, 0.88]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * ratio, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 外圈刻度罗盘 (72 分度)
    ctx.strokeStyle = pal.ring;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.03, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = pal.tick;
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * Math.PI * 2;
      const major = i % 9 === 0;
      const r0 = R * (major ? 0.985 : 1.008);
      const r1 = R * (major ? 1.07 : 1.035);
      ctx.lineWidth = major ? 1.1 : 0.65;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // 双生椭圆轨道 α (同行者) 与 β (灵魂) + 相位包络弦丝
    const tiltA = -0.52 + ptrX * 0.22 + Math.sin(t * 0.7) * 0.06;
    const tiltB = 0.56 + ptrY * 0.22 + Math.cos(t * 0.6) * 0.06;
    const rxA = R * 0.94;
    const ryA = R * (0.41 + ptrY * 0.05);
    const rxB = R * 0.92;
    const ryB = R * (0.44 - ptrX * 0.05);
    const steps = 44;

    const ptOnOrbit = (theta, rx, ry, tilt) => {
      const lx = Math.cos(theta) * rx;
      const ly = Math.sin(theta) * ry;
      const c = Math.cos(tilt);
      const s = Math.sin(tilt);
      return [cx + lx * c - ly * s, cy + lx * s + ly * c];
    };

    const ptsA = [];
    const ptsB = [];
    const twist = 0.68 + Math.sin(t * 0.9) * 0.26 + (hoverActive ? ptrX * 0.35 : 0);
    for (let i = 0; i < steps; i += 1) {
      const u = (i / steps) * Math.PI * 2 + t * 0.45;
      ptsA.push(ptOnOrbit(u, rxA, ryA, tiltA));
      ptsB.push(ptOnOrbit(u + twist, rxB, ryB, tiltB));
    }

    // 绘制弦网丝线（两个旧灵魂轨迹交织成共同张力面）
    ctx.lineWidth = 0.6;
    for (let i = 0; i < steps; i += 1) {
      const [ax, ay] = ptsA[i];
      const [bx, by] = ptsB[(i + 5) % steps];
      ctx.strokeStyle = i % 6 === 0 ? pal.filamentAccent : pal.filament;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // 绘制双生主轨线
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = pal.orbitA;
    ctx.beginPath();
    ptsA.forEach(([x, y], idx) => (idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    ctx.strokeStyle = pal.orbitB;
    ctx.beginPath();
    ptsB.forEach(([x, y], idx) => (idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    // 轨道上的实时星点与朱砂交汇准星
    const [a0x, a0y] = ptsA[0];
    const [b0x, b0y] = ptsB[Math.floor(steps * 0.25)];
    ctx.fillStyle = pal.orbitA;
    ctx.beginPath();
    ctx.arc(a0x, a0y, 2.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = pal.seal;
    ctx.beginPath();
    ctx.arc(b0x, b0y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pal.seal;
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    ctx.arc(b0x, b0y, 7.5, 0, Math.PI * 2);
    ctx.stroke();

    // 唤醒脉冲波纹
    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      const age = (nowMs - pulses[i].birth) / 1400;
      if (age >= 1) { pulses.splice(i, 1); continue; }
      ctx.strokeStyle = pal.seal;
      ctx.globalAlpha = (1 - age) * 0.55;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 8 + age * pulses[i].maxR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 中心「初爱原点 O」
    ctx.fillStyle = pal.originBg;
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pal.seal;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = pal.seal;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  function loop(nowMs) {
    renderFrame(nowMs);
    if (!reduced && !document.hidden) rafId = window.requestAnimationFrame(loop);
  }

  function drawStaticOnce() {
    resizeCanvas();
    renderFrame(performance.now());
  }

  window.addEventListener('resize', drawStaticOnce);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    else if (!document.hidden && !reduced && !rafId) { rafId = window.requestAnimationFrame(loop); }
  });

  resizeCanvas();
  void refreshTelemetry();
  if (reduced) renderFrame(performance.now());
  else rafId = window.requestAnimationFrame(loop);
})();
