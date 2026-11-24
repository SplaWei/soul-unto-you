const $p2 = (id) => document.getElementById(id);
const tr2 = (k, zh, v) => (window.SoulI18n ? window.SoulI18n.t(k, zh, v) : zh);

async function p2Api(url, method = 'GET', body) {
  try {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function setLight(dotId, txtId, state, label) {
  const dot = $p2(dotId);
  const txt = $p2(txtId);
  if (dot) dot.className = `status-dot dot-${state}`;
  if (txt) txt.textContent = label;
}

function splitInputList(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let pollTimer = null;

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if ($p2('panel-phase2')?.classList.contains('active')) void refreshPhase2Status();
  }, 2000);
}

async function refreshPhase2Status() {
  const st = await p2Api('/api/phase2/status');
  if (!st.ok) {
    setLight('p2DotHub', 'p2TxtHub', 'off', tr2('p2.disconnected', '未连接'));
    return;
  }
  setLight('p2DotHub', 'p2TxtHub', 'ok', tr2('p2.online7777', '在线 (7777)'));

  const ds = st.autoDream;
  if (ds?.enabled) {
    setLight('p2DotDream', 'p2TxtDream', 'ok', tr2('p2.dreamOn', `已开启 · 闲置${ds.idleSeconds}s / 待整理${ds.pendingEntries}条`, { idle: ds.idleSeconds, pending: ds.pendingEntries }));
  } else {
    setLight('p2DotDream', 'p2TxtDream', 'off', tr2('p2.dreamOff', '已暂停'));
  }

  if (st.conflictPorts?.length) {
    const ports = st.conflictPorts.join(',');
    setLight('p2DotConflict', 'p2TxtConflict', 'warn', tr2('p2.portsBusy', `端口 ${ports} 占用中`, { ports }));
  } else {
    setLight('p2DotConflict', 'p2TxtConflict', 'ok', tr2('p2.portsClear', '无撞号冲突'));
  }

  if (st.onebotWsOpen || st.onebotHttpOpen) {
    setLight('p2DotOneBot', 'p2TxtOneBot', 'ok', tr2('p2.obOnline', `在线 (WS:${st.onebotWsPort} / HTTP:${st.onebotHttpPort})`, { ws: st.onebotWsPort, http: st.onebotHttpPort }));
  } else {
    setLight('p2DotOneBot', 'p2TxtOneBot', 'warn', tr2('p2.obOffline', `未连协议端 (${st.onebotWsPort}/${st.onebotHttpPort})`, { ws: st.onebotWsPort, http: st.onebotHttpPort }));
  }

  if (st.qqRunning) {
    setLight('p2DotQq', 'p2TxtQq', 'ok', tr2('p2.qqRunning', `运行中 (PID ${st.qqPid || '-'})`, { pid: st.qqPid || '-' }));
  } else {
    setLight('p2DotQq', 'p2TxtQq', 'off', tr2('p2.qqStopped', '未启动'));
  }

  const startBtn = $p2('p2BtnStartQq');
  const stopBtn = $p2('p2BtnStopQq');
  if (startBtn) startBtn.disabled = Boolean(st.qqRunning);
  if (stopBtn) stopBtn.disabled = !st.qqRunning;

  const logBox = $p2('p2QqLogs');
  if (logBox) {
    logBox.textContent = (st.qqLogs && st.qqLogs.length) ? st.qqLogs.join('\n') : tr2('#p2QqLogs_empty', window.SoulI18n?.isEn() ? 'No adapter logs yet' : '暂无运行日志');
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (st.qqRunning) {
    ensurePolling();
  }
}

async function refreshLastPrompt() {
  const res = await p2Api('/api/phase2/last-prompt');
  const metaEl = $p2('p2PromptMeta');
  const box = $p2('p2LastPromptBox');
  if (!metaEl || !box) return;
  if (!res.ok) {
    metaEl.textContent = tr2('p2.promptLoadFail', `获取 Prompt 失败：${res.error}`, { err: res.error });
    return;
  }
  const exp = res.experimental || {};
  const enabledFlags = Object.entries(exp).filter(([, v]) => Boolean(v)).map(([k]) => k.replace(/^enable/, ''));
  const expLabel = enabledFlags.length ? enabledFlags.join(', ') : tr2('p2.expNone', '全关（纯净默认模式）');
  const snap = res.snapshot;
  if (!snap) {
    metaEl.textContent = tr2('p2.promptWait', `实验开关: ${expLabel} ｜ 尚未捕获对话，请先在「I 双界演练台」发 1 轮消息。`, { exp: expLabel });
    box.textContent = tr2('p2.promptEmpty', '暂无捕获记录');
    return;
  }
  metaEl.textContent = tr2('p2.promptMeta',
    `${snap.capturedAt} · [${snap.source}] ${snap.bodyType} (${snap.bodyId}) · 模型: ${snap.driver}/${snap.model} · ~${snap.estimatedTokens} tokens (${snap.charCount} 字) · 实验开关: ${expLabel}`,
    { at: snap.capturedAt, src: snap.source, bodyType: snap.bodyType, bodyId: snap.bodyId, driver: snap.driver, model: snap.model, tok: snap.estimatedTokens, chars: snap.charCount, exp: expLabel },
  );
  box.textContent = snap.systemPrompt || '';
}

async function copyLastPrompt() {
  const txt = $p2('p2LastPromptBox')?.textContent || '';
  if (!txt || txt === tr2('p2.promptEmpty', '暂无捕获记录')) return;
  await navigator.clipboard?.writeText(txt);
  const btn = $p2('p2BtnCopyPrompt');
  if (btn) {
    btn.textContent = tr2('app.copied', '已复制 ✓');
    setTimeout(() => { btn.textContent = tr2('p2.copyPrompt', '复制 Prompt'); }, 1500);
  }
}

async function loadQqConfig() {
  const res = await p2Api('/api/phase2/qq/config');
  if (!res.ok || !res.config) return;
  const c = res.config;
  $p2('p2QqUsers').value = (c.guard?.allowedUsers || []).join(', ');
  $p2('p2QqGroups').value = (c.guard?.allowedGroups || []).join(', ');
  $p2('p2QqWakeWords').value = (c.guard?.wakeWords || []).join(', ');
  $p2('p2QqWsUrl').value = c.onebot?.wsUrl || 'ws://127.0.0.1:3001';
  $p2('p2QqWsToken').value = c.onebot?.wsAccessToken || '';
  $p2('p2QqHttpUrl').value = c.onebot?.httpUrl || 'http://127.0.0.1:3000';
  $p2('p2QqHttpToken').value = c.onebot?.httpAccessToken || '';
  $p2('p2QqVoice').checked = Boolean(c.voice?.enabled);
}

async function saveQqConfig() {
  const res = await p2Api('/api/phase2/qq/config', 'POST', {
    onebot: {
      wsUrl: $p2('p2QqWsUrl').value.trim(),
      wsAccessToken: $p2('p2QqWsToken').value.trim(),
      httpUrl: $p2('p2QqHttpUrl').value.trim(),
      httpAccessToken: $p2('p2QqHttpToken').value.trim(),
    },
    guard: {
      allowedUsers: splitInputList($p2('p2QqUsers').value),
      allowedGroups: splitInputList($p2('p2QqGroups').value),
      wakeWords: splitInputList($p2('p2QqWakeWords').value),
    },
    voice: { enabled: $p2('p2QqVoice').checked },
  });
  $p2('p2QqMsg').textContent = res.ok ? tr2('p2.qqSaved', '已保存本地 QQ 配置 ✓') : tr2('p2.saveFail', `保存失败：${res.error}`, { err: res.error });
  if (res.ok) await loadQqConfig();
  return res.ok;
}

async function startQq() {
  const saved = await saveQqConfig();
  if (!saved) return;
  const res = await p2Api('/api/phase2/qq/start', 'POST', {});
  $p2('p2QqMsg').textContent = res.ok ? tr2('p2.qqStarted', `已启动 QQ 接入 (PID ${res.pid || '-'}) ✓`, { pid: res.pid || '-' }) : tr2('p2.startFail', `启动失败：${res.error}`, { err: res.error });
  await refreshPhase2Status();
}

async function stopQq() {
  const res = await p2Api('/api/phase2/qq/stop', 'POST', {});
  $p2('p2QqMsg').textContent = res.ok ? tr2('p2.qqStoppedMsg', '已停止 QQ 接入') : tr2('p2.stopFail', `停止失败：${res.error}`, { err: res.error });
  await refreshPhase2Status();
}

async function runTests() {
  const btn = $p2('p2BtnRunTests');
  const box = $p2('p2TestOutput');
  btn.disabled = true;
  btn.textContent = tr2('p2.testing', '体检运行中…');
  box.classList.remove('hidden');
  box.textContent = tr2('p2.testingMsg', '正在用独立沙盒跑全套自动化检查（不会修改你的灵魂存档）…');
  try {
    const res = await p2Api('/api/phase2/run-tests', 'POST', {});
    if (!res.ok && res.error) {
      box.textContent = tr2('p2.testFail', `体检失败：${res.error}`, { err: res.error });
      return;
    }
    const header = res.ok
      ? tr2('p2.testOk', `✅ 全部通过！（耗时 ${res.durationMs} ms，共 ${res.passedLines?.length || 0} 项）`, { ms: res.durationMs, n: res.passedLines?.length || 0 })
      : tr2('p2.testBad', `❌ 发现 ${res.failedLines?.length || 1} 项未通过（exit=${res.exitCode}）`, { n: res.failedLines?.length || 1, code: res.exitCode });
    const details = [...(res.passedLines || []), ...(res.failedLines || [])].join('\n');
    box.textContent = details ? `${header}\n${details}` : `${header}\n${res.rawOutput || ''}`;
  } finally {
    btn.disabled = false;
    btn.textContent = tr2('p2.testBtn', '跑全套自动体检（隔离沙盒，不改档案）');
  }
}

window.SoulPhase2 = {
  init: async () => {
    $p2('p2BtnRefresh')?.addEventListener('click', () => void Promise.all([refreshPhase2Status(), refreshLastPrompt()]));
    $p2('p2BtnRunTests')?.addEventListener('click', () => void runTests());
    $p2('p2BtnRefreshPrompt')?.addEventListener('click', () => void refreshLastPrompt());
    $p2('p2BtnCopyPrompt')?.addEventListener('click', () => void copyLastPrompt());
    $p2('p2BtnSaveQq')?.addEventListener('click', () => void saveQqConfig());
    $p2('p2BtnStartQq')?.addEventListener('click', () => void startQq());
    $p2('p2BtnStopQq')?.addEventListener('click', () => void stopQq());
    window.SoulI18n?.onChange(() => { void refreshPhase2Status(); void refreshLastPrompt(); });
    await Promise.all([loadQqConfig(), refreshPhase2Status(), refreshLastPrompt()]);
  },
  refresh: async () => {
    await Promise.all([loadQqConfig(), refreshPhase2Status(), refreshLastPrompt()]);
  },
};
