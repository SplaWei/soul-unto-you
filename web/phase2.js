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
  const mcPort = Number($p2('p2McPort')?.value) || 55916;
  const st = await p2Api(`/api/phase2/status?mcPort=${encodeURIComponent(mcPort)}`);
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

  const mc = st.mc || {};
  if (mc.running) {
    const name = mc.botName || 'Liuyao';
    setLight('p2DotMc', 'p2TxtMc', 'ok', tr2('p2.mcInGame', `已在游戏内 (${name} :${mc.port})`, { name, port: mc.port }));
  } else if (mc.installing) {
    setLight('p2DotMc', 'p2TxtMc', 'warn', tr2('p2.mcInstalling', '正在自动安装组件…'));
  } else if (st.mcLanOpen) {
    setLight('p2DotMc', 'p2TxtMc', 'warn', tr2('p2.mcLanOpen', `局域网 ${st.mcPort} 已开，待召唤`, { port: st.mcPort }));
  } else {
    setLight('p2DotMc', 'p2TxtMc', 'off', tr2('p2.mcOff', '未进入游戏'));
  }

  const startBtn = $p2('p2BtnStartQq');
  const stopBtn = $p2('p2BtnStopQq');
  if (startBtn) startBtn.disabled = Boolean(st.qqRunning);
  if (stopBtn) stopBtn.disabled = !st.qqRunning;

  const mcStartBtn = $p2('p2BtnStartMc');
  const mcStopBtn = $p2('p2BtnStopMc');
  if (mcStartBtn) mcStartBtn.disabled = Boolean(mc.running || mc.installing);
  if (mcStopBtn) mcStopBtn.disabled = !mc.running;

  const logBox = $p2('p2QqLogs');
  if (logBox) {
    logBox.textContent = (st.qqLogs && st.qqLogs.length) ? st.qqLogs.join('\n') : tr2('#p2QqLogs_empty', window.SoulI18n?.isEn() ? 'No adapter logs yet' : '暂无运行日志');
    logBox.scrollTop = logBox.scrollHeight;
  }
  const mcLogBox = $p2('p2McLogs');
  if (mcLogBox) {
    mcLogBox.textContent = (mc.logs && mc.logs.length) ? mc.logs.join('\n') : (window.SoulI18n?.isEn() ? 'No MC bot logs yet' : '暂无 MC 伴侣运行日志');
    mcLogBox.scrollTop = mcLogBox.scrollHeight;
  }

  if (st.qqRunning || mc.running || mc.installing) {
    ensurePolling();
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

async function checkMc() {
  const mcPort = Number($p2('p2McPort').value) || 55916;
  const res = await p2Api('/api/phase2/mc/check', 'POST', { mcPort });
  const box = $p2('p2McResult');
  box.classList.remove('hidden');
  box.textContent = res.ok
    ? tr2('p2.mcCheckOk', `${res.message}\n你可以直接点上面的「召唤她进入 MC」！`, { msg: res.message })
    : tr2('p2.checkFail', `检测失败：${res.error}`, { err: res.error });
}

async function startMc() {
  const btn = $p2('p2BtnStartMc');
  const mcPort = Number($p2('p2McPort').value) || 55916;
  const botName = ($p2('p2McBotName')?.value || 'Liuyao').trim();
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr2('p2.mcSummoning', '正在召唤中…');
  }
  $p2('p2McMsg').textContent = tr2('p2.mcConnecting', '正在连接 Minecraft 世界（首次会自动准备组件）…');
  ensurePolling();
  try {
    const res = await p2Api('/api/phase2/mc/start', 'POST', { mcPort, botName });
    $p2('p2McMsg').textContent = res.ok
      ? tr2('p2.mcSummoned', `已召唤「${res.botName}」进入 :${res.port} ✓（请看下方日志是否已进世界）`, { name: res.botName, port: res.port })
      : tr2('p2.summonFail', `召唤失败：${res.error}`, { err: res.error });
    await refreshPhase2Status();
  } finally {
    if (btn) btn.textContent = tr2('p2.mcSummonBtn', '召唤她进入 MC');
  }
}

async function stopMc() {
  const res = await p2Api('/api/phase2/mc/stop', 'POST', {});
  $p2('p2McMsg').textContent = res.ok ? tr2('p2.mcStopped', '已让她退出 MC 游戏世界') : tr2('p2.opFail', `操作失败：${res.error}`, { err: res.error });
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
    $p2('p2BtnRefresh')?.addEventListener('click', () => void refreshPhase2Status());
    $p2('p2BtnRunTests')?.addEventListener('click', () => void runTests());
    $p2('p2BtnSaveQq')?.addEventListener('click', () => void saveQqConfig());
    $p2('p2BtnStartQq')?.addEventListener('click', () => void startQq());
    $p2('p2BtnStopQq')?.addEventListener('click', () => void stopQq());
    $p2('p2BtnCheckMc')?.addEventListener('click', () => void checkMc());
    $p2('p2BtnStartMc')?.addEventListener('click', () => void startMc());
    $p2('p2BtnStopMc')?.addEventListener('click', () => void stopMc());
    window.SoulI18n?.onChange(() => { void refreshPhase2Status(); });
    await Promise.all([loadQqConfig(), refreshPhase2Status()]);
  },
  refresh: async () => {
    await Promise.all([loadQqConfig(), refreshPhase2Status()]);
  },
};
