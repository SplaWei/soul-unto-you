import net from 'node:net';
import type { OneBotMessageEvent, ParsedQqMessage, QqGuardConfig } from './types.ts';

export const DEFAULT_GUARD_CONFIG: QqGuardConfig = {
  allowedUsers: [],
  allowedGroups: [],
  privateCooldownMs: 2500,
  groupCooldownMs: 4000,
  maxRepliesPerMinute: 12,
  maxRepliesPerHour: 120,
  replyDelayMinMs: 800,
  replyDelayMaxMs: 1800,
  maxReplyChars: 450,
  groupRequireAtOrWakeWord: true,
  wakeWords: [],
  observeUnmentionedGroupMessages: true,
  maxMessageAgeSec: 15,
  conflictCheckPorts: [],
};

function probeTcpPort(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 检查本地是否存在其它活跃桥接端口，避免同一个 QQ 号同时挂两个 Bot 触发风控。
 */
export async function checkConflictPorts(
  ports: number[],
  host = '127.0.0.1',
  timeoutMs = 450,
): Promise<number[]> {
  const unique = Array.from(new Set(ports.map((p) => Math.floor(Number(p))).filter((p) => p > 0 && p <= 65535)));
  const active: number[] = [];
  for (const port of unique) {
    if (await probeTcpPort(port, host, timeoutMs)) {
      active.push(port);
    }
  }
  return active;
}

export interface GuardDecision {
  decision: 'reply' | 'observe' | 'drop';
  reason: string;
  targetKey?: string;
}

const GUARD_REASON_LABELS: Record<string, string> = {
  'user-not-whitelisted': '发送者 QQ 号不在私聊白名单内',
  'group-not-whitelisted': '该 QQ 群号不在群聊白名单内',
  'cooldown-active': '触发发言冷却保护，暂缓回复',
  'target-busy': '当前会话仍在等待回复，并发消息已跳过',
  'rate-limit-minute': '触发每分钟全局发送上限',
  'rate-limit-hour': '触发每小时全局发送上限',
  'duplicate-message': '重复消息 ID，已去重跳过',
  'stale-offline-backlog': '重连前积压的历史消息，防刷屏已跳过',
  'empty-message': '空消息或仅含不支持的媒体片段',
  'group-not-triggered': '群聊未 @ 机器人且未命中唤醒词',
  'group-ambient': '群聊日常旁听模式，仅静默观察记录',
  'unsupported-message-type': '暂不支持的消息类型',
  'self-message': '机器人自身发出的消息',
  'not-message-event': '非消息事件',
  allowed: '允许放行',
};

export function describeGuardReason(reason: string): string {
  return GUARD_REASON_LABELS[reason] || `未放行 (${reason})`;
}

export class QqRiskGuard {
  private readonly cfg: QqGuardConfig;
  private connectedAtMs: number;
  private readonly seenMsgIds: Set<string>;
  private readonly lastReplyByTarget: Map<string, number>;
  private readonly inFlightTargets: Set<string>;
  private replyTimestampsMs: number[];

  constructor(cfg?: Partial<QqGuardConfig>) {
    this.cfg = {
      ...DEFAULT_GUARD_CONFIG,
      ...(cfg || {}),
      allowedUsers: (cfg?.allowedUsers ?? DEFAULT_GUARD_CONFIG.allowedUsers).map((x) => String(x).trim()).filter(Boolean),
      allowedGroups: (cfg?.allowedGroups ?? DEFAULT_GUARD_CONFIG.allowedGroups).map((x) => String(x).trim()).filter(Boolean),
      wakeWords: (cfg?.wakeWords ?? DEFAULT_GUARD_CONFIG.wakeWords).map((x) => String(x).trim()).filter(Boolean),
      conflictCheckPorts: (cfg?.conflictCheckPorts ?? DEFAULT_GUARD_CONFIG.conflictCheckPorts).map((x) => Number(x)).filter((x) => x > 0),
    };
    this.connectedAtMs = Date.now();
    this.seenMsgIds = new Set<string>();
    this.lastReplyByTarget = new Map<string, number>();
    this.inFlightTargets = new Set<string>();
    this.replyTimestampsMs = [];
  }

  markConnected(nowMs = Date.now()): void {
    this.connectedAtMs = nowMs;
  }

  tryAcquireTarget(targetKey: string): boolean {
    if (!targetKey || this.inFlightTargets.has(targetKey)) return false;
    this.inFlightTargets.add(targetKey);
    return true;
  }

  releaseTarget(targetKey: string): void {
    if (targetKey) this.inFlightTargets.delete(targetKey);
  }

  private pruneHistory(nowMs: number): void {
    const hourAgo = nowMs - 3_600_000;
    if (this.replyTimestampsMs.length && this.replyTimestampsMs[0] < hourAgo) {
      this.replyTimestampsMs = this.replyTimestampsMs.filter((ts) => ts >= hourAgo);
    }
  }

  private checkRateLimit(targetKey: string, cooldownMs: number, nowMs: number): { ok: boolean; reason: string } {
    if (this.inFlightTargets.has(targetKey)) {
      return { ok: false, reason: 'target-busy' };
    }
    this.pruneHistory(nowMs);
    const lastTargetAt = this.lastReplyByTarget.get(targetKey);
    if (lastTargetAt !== undefined && nowMs - lastTargetAt < cooldownMs) {
      return { ok: false, reason: 'cooldown-active' };
    }
    const minAgo = nowMs - 60_000;
    let inLastMinute = 0;
    for (let i = this.replyTimestampsMs.length - 1; i >= 0; i -= 1) {
      if (this.replyTimestampsMs[i] >= minAgo) inLastMinute += 1;
      else break;
    }
    if (inLastMinute >= this.cfg.maxRepliesPerMinute) {
      return { ok: false, reason: 'rate-limit-minute' };
    }
    if (this.replyTimestampsMs.length >= this.cfg.maxRepliesPerHour) {
      return { ok: false, reason: 'rate-limit-hour' };
    }
    return { ok: true, reason: 'allowed' };
  }

  evaluateIncoming(ev: OneBotMessageEvent, parsed: ParsedQqMessage, nowMs = Date.now()): GuardDecision {
    if (ev.post_type !== 'message') {
      return { decision: 'drop', reason: 'not-message-event' };
    }
    const userId = String(ev.user_id ?? '').trim();
    const selfId = String(ev.self_id ?? '').trim();
    if (!userId || (selfId && userId === selfId)) {
      return { decision: 'drop', reason: 'self-message' };
    }
    if (ev.message_id !== undefined && ev.message_id !== null) {
      const msgKey = String(ev.message_id);
      if (this.seenMsgIds.has(msgKey)) {
        return { decision: 'drop', reason: 'duplicate-message' };
      }
      this.seenMsgIds.add(msgKey);
      if (this.seenMsgIds.size > 500) {
        const oldest = this.seenMsgIds.values().next().value;
        if (oldest !== undefined) this.seenMsgIds.delete(oldest);
      }
    }
    if (typeof ev.time === 'number' && ev.time > 0) {
      const staleBefore = this.connectedAtMs - Math.max(0, this.cfg.maxMessageAgeSec) * 1000;
      if (ev.time * 1000 < staleBefore) {
        return { decision: 'drop', reason: 'stale-offline-backlog' };
      }
    }
    if (!parsed.text.trim() && !parsed.imageUrls.length) {
      return { decision: 'drop', reason: 'empty-message' };
    }

    let targetKey = '';
    let cooldownMs = this.cfg.privateCooldownMs;
    if (ev.message_type === 'private') {
      if (!this.cfg.allowedUsers.includes(userId)) {
        return { decision: 'drop', reason: 'user-not-whitelisted' };
      }
      targetKey = `private:${userId}`;
    } else if (ev.message_type === 'group') {
      const groupId = String(ev.group_id ?? '').trim();
      if (!groupId || !this.cfg.allowedGroups.includes(groupId)) {
        return { decision: 'drop', reason: 'group-not-whitelisted' };
      }
      if (this.cfg.groupRequireAtOrWakeWord) {
        const lower = parsed.text.toLowerCase();
        const hitWake = this.cfg.wakeWords.some((w) => w && lower.includes(w.toLowerCase()));
        if (!parsed.isAtSelf && !hitWake) {
          return this.cfg.observeUnmentionedGroupMessages
            ? { decision: 'observe', reason: 'group-ambient' }
            : { decision: 'drop', reason: 'group-not-triggered' };
        }
      }
      targetKey = `group:${groupId}`;
      cooldownMs = this.cfg.groupCooldownMs;
    } else {
      return { decision: 'drop', reason: 'unsupported-message-type' };
    }

    const rate = this.checkRateLimit(targetKey, cooldownMs, nowMs);
    if (!rate.ok) {
      return { decision: 'drop', reason: rate.reason, targetKey };
    }
    return { decision: 'reply', reason: 'allowed', targetKey };
  }

  canSendProactive(userId: string, nowMs = Date.now()): { ok: boolean; reason: string } {
    const cleanId = String(userId ?? '').trim();
    if (!cleanId || !this.cfg.allowedUsers.includes(cleanId)) {
      return { ok: false, reason: 'user-not-whitelisted' };
    }
    return this.checkRateLimit(`private:${cleanId}`, this.cfg.privateCooldownMs, nowMs);
  }

  canSendToGroup(groupId: string, nowMs = Date.now()): { ok: boolean; reason: string } {
    const cleanId = String(groupId ?? '').trim();
    if (!cleanId || !this.cfg.allowedGroups.includes(cleanId)) {
      return { ok: false, reason: 'group-not-whitelisted' };
    }
    return this.checkRateLimit(`group:${cleanId}`, this.cfg.groupCooldownMs, nowMs);
  }

  recordReplySent(targetKey: string, nowMs = Date.now()): void {
    this.lastReplyByTarget.set(targetKey, nowMs);
    this.replyTimestampsMs.push(nowMs);
    this.pruneHistory(nowMs);
  }

  computeHumanDelayMs(): number {
    const min = Math.max(0, Math.floor(this.cfg.replyDelayMinMs));
    const max = Math.max(min, Math.floor(this.cfg.replyDelayMaxMs));
    if (max === min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  splitSafeReply(text: string): string[] {
    const clean = String(text ?? '').trim();
    if (!clean) return [];
    const maxLen = Math.max(40, Math.floor(this.cfg.maxReplyChars));
    if (clean.length <= maxLen) return [clean];

    const chunks: string[] = [];
    let rest = clean;
    while (rest.length > 0 && chunks.length < 3) {
      if (rest.length <= maxLen) {
        chunks.push(rest);
        break;
      }
      let cut = -1;
      const window = rest.slice(0, maxLen);
      for (const sep of ['\n', '。', '！', '？', '. ', '! ', '? ', '，']) {
        const idx = window.lastIndexOf(sep);
        if (idx >= Math.floor(maxLen * 0.4)) {
          cut = idx + sep.length;
          break;
        }
      }
      if (cut <= 0) cut = maxLen;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return chunks.filter(Boolean);
  }
}
