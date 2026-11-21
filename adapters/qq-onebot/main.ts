import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConflictPorts, DEFAULT_GUARD_CONFIG, describeGuardReason, QqRiskGuard } from './guard.ts';
import { OneBotClient, parseOneBotMessage, stripMarkdownForQq } from './onebot-client.ts';
import { escapeCqOutbound, fetchSafeHttpsImageBase64 } from './safety.ts';
import type { OneBotMessageEvent, QqAdapterConfig } from './types.ts';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_CONFIG_PATH = path.join(THIS_DIR, 'qq-adapter.example.json');
export const DEFAULT_LOCAL_CONFIG_PATH = path.join(THIS_DIR, 'qq-adapter.local.json');

export function defaultQqAdapterConfig(): QqAdapterConfig {
  return {
    soulHubUrl: 'http://127.0.0.1:7777',
    bodyId: 'qq-onebot-main',
    displayName: 'QQ 独立客户端',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', wsAccessToken: '', httpUrl: 'http://127.0.0.1:3000', httpAccessToken: '', reconnectBaseMs: 2000, reconnectMaxMs: 30000 },
    guard: { ...DEFAULT_GUARD_CONFIG },
    enableImageForward: true,
    stripMarkdown: true,
    voice: { enabled: false, sendTextWithVoice: true, directGsvUrl: '', character: 'default' },
    proactive: { enabled: false, targetUserId: '' },
  };
}

export function loadQqAdapterConfig(configPath?: string): QqAdapterConfig {
  const target = configPath
    ? path.resolve(configPath)
    : process.env.QQ_ADAPTER_CONFIG
      ? path.resolve(process.env.QQ_ADAPTER_CONFIG)
      : DEFAULT_LOCAL_CONFIG_PATH;
  const base = defaultQqAdapterConfig();
  let raw: Partial<QqAdapterConfig> = {};
  if (fs.existsSync(target)) {
    raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<QqAdapterConfig>;
  }
  return {
    ...base,
    ...raw,
    onebot: { ...base.onebot, ...(raw.onebot || {}) },
    guard: { ...base.guard, ...(raw.guard || {}) },
    voice: { ...base.voice, ...(raw.voice || {}) },
    proactive: { ...base.proactive, ...(raw.proactive || {}) },
  };
}

async function postJson<T = Record<string, unknown>>(url: string, body: unknown, token = '', timeoutMs = 45000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Soul-Token': token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text().catch(() => '');
  let parsed: (T & { ok?: boolean; error?: string }) | null = null;
  if (raw.trim()) {
    try { parsed = JSON.parse(raw) as T & { ok?: boolean; error?: string }; } catch {}
  }
  if (!res.ok) {
    const detail = parsed?.error || raw.replace(/\s+/g, ' ').trim().slice(0, 220) || res.statusText || '未知错误';
    throw new Error(`请求灵魂中枢失败 [HTTP ${res.status}] ${url}: ${detail}`);
  }
  if (!parsed) throw new Error(`灵魂中枢返回非 JSON 响应 [HTTP ${res.status}] ${url}: ${raw.slice(0, 160)}`);
  return parsed;
}

async function fetchDirectVoice(gsvUrl: string, text: string, character?: string, onWarn?: (msg: string) => void): Promise<string | null> {
  try {
    const res = await fetch(`${gsvUrl.replace(/\/+$/, '')}/v1/speak/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, character: character || 'default' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const msg = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
      onWarn?.(`语音合成服务返回异常 [HTTP ${res.status}]${msg ? `: ${msg}` : ''}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf.toString('base64') : null;
  } catch (err) {
    onWarn?.(`直连语音合成异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function createQqOneBotAdapter(config: QqAdapterConfig, opts: { logger?: (line: string) => void; sseRetryMs?: number } = {}) {
  const log = opts.logger ?? ((line: string) => console.log(`[qq-onebot] ${line}`));
  const sseRetryMs = Math.max(10, opts.sseRetryMs ?? 3000);
  const hubBase = config.soulHubUrl.replace(/\/+$/, '');
  const apiToken = String(config.apiToken || process.env.SOUL_API_TOKEN || '').trim();
  const guard = new QqRiskGuard(config.guard);
  let sseAbort: AbortController | null = null;
  let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const client = new OneBotClient({
    endpoint: config.onebot,
    onConnected: (nowMs) => {
      guard.markConnected(nowMs);
      log(`OneBot WS 已连接 (${config.onebot.wsUrl})`);
    },
    onError: (err) => log(`OneBot 警告: ${err.message}`),
    onMessage: (ev) => handleIncomingMessage(ev),
  });

  async function sendToTarget(ev: OneBotMessageEvent, message: string | Array<{ type: string; data: Record<string, unknown> }>): Promise<void> {
    const outMsg = typeof message === 'string' ? escapeCqOutbound(message) : message;
    if (ev.message_type === 'private' && ev.user_id !== undefined) await client.sendPrivateMsg(ev.user_id, outMsg);
    else if (ev.message_type === 'group' && ev.group_id !== undefined) await client.sendGroupMsg(ev.group_id, outMsg);
  }

  async function handleIncomingMessage(ev: OneBotMessageEvent): Promise<void> {
    const parsed = parseOneBotMessage(ev.message ?? ev.raw_message, ev.self_id);
    const decision = guard.evaluateIncoming(ev, parsed);
    if (decision.decision === 'drop') {
      if (decision.reason !== 'not-message-event' && decision.reason !== 'self-message') {
        const scope = ev.message_type === 'group' ? `群:${ev.group_id ?? '?'}/成员:${ev.user_id ?? '?'}` : `私聊:${ev.user_id ?? '?'}`;
        log(`🛡️ 防风控已拦截 [${scope}]：${describeGuardReason(decision.reason)} (${decision.reason})`);
      }
      return;
    }

    const senderName = String(ev.sender?.card || ev.sender?.nickname || ev.user_id || 'QQ好友').trim();
    if (decision.decision === 'observe') {
      await postJson(`${hubBase}/api/body/observe`, {
        bodyId: config.bodyId, bodyType: 'chat:qq', displayName: config.displayName,
        summary: `[群聊 ${ev.group_id}] ${senderName}: ${parsed.text || '[图片/媒体]'}`,
        allowSpeak: false, metadata: { platform: 'qq', groupId: String(ev.group_id ?? ''), userId: String(ev.user_id ?? '') },
      }, apiToken).catch((err) => {
        log(`群聊静默旁听上报失败: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    const targetKey = decision.targetKey || '';
    if (targetKey && !guard.tryAcquireTarget(targetKey)) {
      log(`🛡️ 防风控已拦截 [${targetKey}]：上一条回复仍在生成中 (target-busy)`);
      return;
    }

    try {
      const images = config.enableImageForward && parsed.imageUrls.length
        ? await fetchSafeHttpsImageBase64(parsed.imageUrls, log)
        : [];
      const wantHubVoice = config.voice.enabled && !config.voice.directGsvUrl;
      const res = await postJson<{ ok: boolean; reply: string; voice?: { ok: boolean; base64?: string } }>(`${hubBase}/api/body/percept`, {
        bodyId: config.bodyId, bodyType: 'chat:qq', displayName: config.displayName, speaker: senderName,
        text: parsed.text || '[对方发来一张图片]', images, wantVoice: wantHubVoice,
        metadata: { platform: 'qq', messageType: ev.message_type, userId: String(ev.user_id ?? ''), groupId: String(ev.group_id ?? '') },
      }, apiToken, config.perceptTimeoutMs ?? 95_000);

      const rawReply = escapeCqOutbound(config.stripMarkdown ? stripMarkdownForQq(res.reply) : res.reply);
      const chunks = guard.splitSafeReply(rawReply);
      if (!chunks.length) return;

      const delayMs = guard.computeHumanDelayMs();
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      const voiceB64 = config.voice.enabled
        ? (res.voice?.ok && res.voice.base64
            ? res.voice.base64
            : config.voice.directGsvUrl
              ? await fetchDirectVoice(config.voice.directGsvUrl, chunks[0], config.voice.character, log)
              : null)
        : null;

      if (!voiceB64 || config.voice.sendTextWithVoice) {
        for (const chunk of chunks) await sendToTarget(ev, escapeCqOutbound(chunk));
      }
      if (voiceB64) await sendToTarget(ev, [{ type: 'record', data: { file: `base64://${voiceB64}` } }]);
      if (targetKey) guard.recordReplySent(targetKey);
    } finally {
      if (targetKey) guard.releaseTarget(targetKey);
    }
  }

  function cleanOutbound(raw: unknown): string {
    const s = config.stripMarkdown ? stripMarkdownForQq(String(raw ?? '')) : String(raw ?? '').trim();
    return guard.splitSafeReply(escapeCqOutbound(s))[0] || '';
  }

  async function dispatchQqOutbound(kind: 'group' | 'private', targetId: string, text: string, fromBodyType?: string) {
    if (!targetId) { log('跨躯体发消息被护栏拦截：未配置或未指定目标账号/群号'); return; }
    const gate = kind === 'group' ? guard.canSendToGroup(targetId) : guard.canSendProactive(targetId);
    if (!gate.ok) { log(`🛡️ 跨躯体发消息被防风控拦截：${describeGuardReason(gate.reason)} (${gate.reason})`); return; }
    const safeText = escapeCqOutbound(text);
    if (kind === 'group') await client.sendGroupMsg(targetId, safeText);
    else await client.sendPrivateMsg(targetId, safeText);
    guard.recordReplySent(`${kind}:${targetId}`);
    const label = kind === 'group' ? `QQ 群 ${targetId}` : `QQ ${targetId}`;
    log(`已跨躯体在 ${label} 发送：${safeText}`);
    void postJson(`${hubBase}/api/body/observe`, {
      bodyId: config.bodyId, bodyType: 'chat:qq', displayName: config.displayName,
      summary: `[跨躯体执行成功] 响应 [${fromBodyType || '另一躯体'}] 请求，已在 ${label} 发送：${safeText}`,
      allowSpeak: false,
    }, apiToken).catch((err) => {
      log(`跨躯体执行回执上报失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function handleSseFrame(eventName: string, dataStr: string): Promise<void> {
    if (eventName === 'proactive') {
      const targetUser = String(config.proactive.targetUserId ?? '').trim();
      if (!config.proactive.enabled || !targetUser) return;
      const env = JSON.parse(dataStr) as { payload?: { bodyId?: string; reply?: string } };
      if (env.payload?.bodyId && env.payload.bodyId !== config.bodyId) return;
      const text = cleanOutbound(env.payload?.reply);
      if (!text) return;
      const gate = guard.canSendProactive(targetUser);
      if (!gate.ok) { log(`🛡️ 主动搭话被防风控拦截：${describeGuardReason(gate.reason)} (${gate.reason})`); return; }
      await client.sendPrivateMsg(targetUser, text);
      guard.recordReplySent(`private:${targetUser}`);
      return;
    }
    if (eventName !== 'body.action') return;
    const env = JSON.parse(dataStr) as { payload?: { fromBodyType?: string; targetBodyId?: string; action?: { name?: string; params?: Record<string, unknown> } } };
    const p = env.payload;
    if (!p || p.targetBodyId !== config.bodyId || !p.action?.name) return;
    const params = p.action.params || {};
    const text = cleanOutbound(params.text);
    if (!text) return;
    if (p.action.name === 'send_qq_group_message') {
      await dispatchQqOutbound('group', String(params.groupId || config.guard.allowedGroups[0] || '').trim(), text, p.fromBodyType);
    } else if (p.action.name === 'send_qq_private_message') {
      await dispatchQqOutbound('private', String(params.userId || config.guard.allowedUsers[0] || '').trim(), text, p.fromBodyType);
    }
  }

  function subscribeHubEvents(): Promise<void> {
    return new Promise((resolveReady) => {
      let settled = false;
      const markReady = () => { if (!settled) { settled = true; resolveReady(); } };
      const loop = async () => {
        while (running) {
          sseAbort = new AbortController();
          try {
            const sseUrl = `${hubBase}/api/events?bodyId=${encodeURIComponent(config.bodyId)}`;
            const res = await fetch(sseUrl, { signal: sseAbort.signal, headers: apiToken ? { 'X-Soul-Token': apiToken } : undefined });
            markReady();
            if (!res.ok || !res.body) {
              const errBody = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 180);
              log(`订阅灵魂中枢事件流失败 [HTTP ${res.status}]${errBody ? `: ${errBody}` : ''}，${Math.round(sseRetryMs / 100) / 10} 秒后重连…`);
            } else {
              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = '';
              while (running) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let sep: number;
                while ((sep = buf.indexOf('\n\n')) >= 0) {
                  const frame = buf.slice(0, sep);
                  buf = buf.slice(sep + 2);
                  const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
                  const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
                  if (!evLine || !dataLine) continue;
                  await handleSseFrame(evLine.slice(6).trim(), dataLine.slice(5).trim()).catch((err) => {
                    log(`跨躯体动作处理异常: ${err instanceof Error ? err.message : String(err)}`);
                  });
                }
              }
              if (running) log('灵魂中枢事件流连接已断开，准备重连…');
            }
          } catch (err) {
            markReady();
            if (!running) break;
            log(`订阅灵魂中枢事件流异常: ${err instanceof Error ? err.message : String(err)}，等待重连…`);
          }
          if (running) {
            await new Promise<void>((r) => { sseRetryTimer = setTimeout(r, sseRetryMs); });
            sseRetryTimer = null;
          }
        }
      };
      void loop();
    });
  }

  return {
    guard,
    client,
    async check() {
      const conflictPorts = await checkConflictPorts(config.guard.conflictCheckPorts);
      let hub: { ok: boolean; soulName?: string; error?: string } = { ok: false };
      try {
        const h = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(3000) });
        const raw = await h.text().catch(() => '');
        if (!h.ok) hub = { ok: false, error: `HTTP ${h.status}${raw ? `: ${raw.replace(/\s+/g, ' ').trim().slice(0, 140)}` : ''}` };
        else { const j = JSON.parse(raw) as { ok?: boolean; soulName?: string }; hub = { ok: Boolean(j.ok), soulName: j.soulName }; }
      } catch (err) { hub = { ok: false, error: err instanceof Error ? err.message : String(err) }; }

      let onebot: { ok: boolean; selfId?: string; nickname?: string; error?: string } = { ok: false };
      if (config.onebot.httpUrl) {
        try {
          const info = await client.getLoginInfo();
          onebot = { ok: true, selfId: String(info?.user_id ?? ''), nickname: String(info?.nickname ?? '') };
        } catch (err) { onebot = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      }
      return {
        ok: conflictPorts.length === 0 && hub.ok && onebot.ok, conflictPorts, hub, onebot,
        whitelistCount: { users: config.guard.allowedUsers.length, groups: config.guard.allowedGroups.length },
      };
    },
    async start() {
      const conflicts = await checkConflictPorts(config.guard.conflictCheckPorts);
      if (conflicts.length) throw new Error(`检测到冲突桥接端口正在监听: ${conflicts.join(', ')}。请先暂停旧桥接进程，严禁同一 QQ 同时运行两个 Bot！`);
      const actions = [
        { name: 'send_emote_reaction', description: '在 QQ 中表达情绪与语气回应' },
        ...(config.guard.allowedGroups.length ? [{ name: 'send_qq_group_message', description: '向已授权白名单 QQ 群发送一条消息（可跨躯体执行，如去群里唱歌、打招呼、汇报进展）', params: { text: '要发送到QQ群的文字内容', groupId: '可选目标群号，默认发到白名单第一个群' } }] : []),
        ...(config.guard.allowedUsers.length ? [{ name: 'send_qq_private_message', description: '向已授权白名单好友私聊发送一条消息（可跨躯体执行）', params: { text: '要私聊发送的文字内容', userId: '可选目标QQ号，默认发给白名单第一个好友' } }] : []),
      ];
      await postJson(`${hubBase}/api/body/register`, {
        bodyId: config.bodyId, bodyType: 'chat:qq', displayName: config.displayName,
        senses: [{ id: 'qq-onebot-v11', modality: 'text', description: 'QQ 私聊、白名单群聊与可选图片消息' }], actions,
      }, apiToken);
      running = true;
      client.connect();
      await subscribeHubEvents();
      log(`已挂载至灵魂中枢 ${hubBase} (bodyId=${config.bodyId})`);
    },
    stop() {
      running = false;
      if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
      sseAbort?.abort(); sseAbort = null;
      client.close();
    },
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--init')) {
    if (fs.existsSync(DEFAULT_LOCAL_CONFIG_PATH)) {
      console.log(`本地配置已存在，跳过覆盖: ${DEFAULT_LOCAL_CONFIG_PATH}`);
    } else {
      fs.copyFileSync(EXAMPLE_CONFIG_PATH, DEFAULT_LOCAL_CONFIG_PATH);
      console.log(`已生成本地配置模板: ${DEFAULT_LOCAL_CONFIG_PATH}`);
      console.log('请填写你的 OneBot WS/HTTP token 与白名单 QQ 号后运行 --check 自检。');
    }
  } else {
    const cfg = loadQqAdapterConfig();
    const adapter = createQqOneBotAdapter(cfg);
    if (args.includes('--check')) {
      adapter.check().then((res) => {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
      });
    } else {
      adapter.start().catch((err) => {
        console.error('[qq-onebot] 启动失败:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      });
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => { adapter.stop(); process.exit(0); });
      }
    }
  }
}
