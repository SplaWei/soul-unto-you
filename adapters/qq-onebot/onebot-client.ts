import crypto from 'node:crypto';
import type { OneBotMessageEvent, OneBotSegment, ParsedQqMessage, QqOneBotEndpointConfig } from './types.ts';

function unescapeCq(raw: string): string {
  return raw
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

function parseCqParams(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = unescapeCq(part.slice(eq + 1));
  }
  return out;
}

export function parseOneBotMessage(
  raw: string | OneBotSegment[] | undefined,
  selfId?: string | number,
): ParsedQqMessage {
  const selfStr = selfId !== undefined && selfId !== null ? String(selfId).trim() : '';
  const textParts: string[] = [];
  const mentionedIds: string[] = [];
  const imageUrls: string[] = [];
  let isAtSelf = false;

  if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text') {
        const t = String(seg.data?.text ?? '');
        if (t) textParts.push(t);
      } else if (seg.type === 'at') {
        const qq = String(seg.data?.qq ?? '').trim();
        if (qq) {
          mentionedIds.push(qq);
          if (selfStr && qq === selfStr) isAtSelf = true;
          else if (qq !== 'all') textParts.push(`@${qq} `);
        }
      } else if (seg.type === 'image') {
        const url = String(seg.data?.url ?? seg.data?.file ?? '').trim();
        if (/^https?:\/\//i.test(url)) imageUrls.push(url);
      }
    }
    return {
      text: textParts.join('').replace(/\s+/g, ' ').trim(),
      isAtSelf,
      mentionedIds,
      imageUrls,
    };
  }

  const str = String(raw ?? '');
  const cqRe = /\[CQ:([a-zA-Z0-9_-]+)(?:,([^\]]*))?\]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = cqRe.exec(str)) !== null) {
    if (m.index > lastIndex) {
      textParts.push(unescapeCq(str.slice(lastIndex, m.index)));
    }
    const kind = m[1];
    const params = parseCqParams(m[2] || '');
    if (kind === 'at') {
      const qq = String(params.qq ?? '').trim();
      if (qq) {
        mentionedIds.push(qq);
        if (selfStr && qq === selfStr) isAtSelf = true;
        else if (qq !== 'all') textParts.push(`@${qq} `);
      }
    } else if (kind === 'image') {
      const url = String(params.url ?? params.file ?? '').trim();
      if (/^https?:\/\//i.test(url)) imageUrls.push(url);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < str.length) {
    textParts.push(unescapeCq(str.slice(lastIndex)));
  }

  return {
    text: textParts.join('').replace(/\s+/g, ' ').trim(),
    isAtSelf,
    mentionedIds,
    imageUrls,
  };
}

export function stripMarkdownForQq(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toOneBotId(id: string | number): string | number {
  const s = String(id).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

function buildAuthWsUrl(rawUrl: string, token?: string): string {
  const t = String(token ?? '').trim();
  if (!t) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has('access_token')) {
      u.searchParams.set('access_token', t);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export interface OneBotClientOptions {
  endpoint: QqOneBotEndpointConfig;
  onMessage: (ev: OneBotMessageEvent) => void | Promise<void>;
  onConnected?: (nowMs: number) => void;
  onError?: (err: Error) => void;
}

export class OneBotClient {
  private readonly opts: OneBotClientOptions;
  private socket: WebSocket | null;
  private closed: boolean;
  private reconnectAttempts: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private readonly pending: Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;

  constructor(opts: OneBotClientOptions) {
    this.opts = opts;
    this.socket = null;
    this.closed = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pending = new Map();
  }

  connect(): void {
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const token = String(this.opts.endpoint.wsAccessToken ?? '').trim();
    const wsUrl = buildAuthWsUrl(this.opts.endpoint.wsUrl, token);
    let sock: WebSocket;
    try {
      sock = token
        ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[])
        : new WebSocket(wsUrl);
    } catch {
      sock = new WebSocket(wsUrl);
    }
    this.socket = sock;

    sock.addEventListener('open', () => {
      if (this.socket !== sock) return;
      this.reconnectAttempts = 0;
      this.opts.onConnected?.(Date.now());
    });

    sock.addEventListener('message', (ev) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const echo = typeof payload.echo === 'string' ? payload.echo : '';
      if (echo && this.pending.has(echo)) {
        const entry = this.pending.get(echo)!;
        this.pending.delete(echo);
        clearTimeout(entry.timer);
        if (payload.status === 'failed' || (typeof payload.retcode === 'number' && payload.retcode !== 0)) {
          entry.reject(new Error(String(payload.wording || payload.message || `OneBot retcode ${payload.retcode}`)));
        } else {
          entry.resolve(payload.data);
        }
        return;
      }
      if (payload.post_type === 'message') {
        void Promise.resolve(this.opts.onMessage(payload as unknown as OneBotMessageEvent)).catch((err) => {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });

    sock.addEventListener('error', () => {
      if (this.socket !== sock) return;
      this.opts.onError?.(new Error('OneBot WebSocket 连接异常'));
    });

    sock.addEventListener('close', () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.rejectAllPending(new Error('OneBot WebSocket 已断开'));
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(err);
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const base = Math.max(500, this.opts.endpoint.reconnectBaseMs ?? 2000);
    const max = Math.max(base, this.opts.endpoint.reconnectMaxMs ?? 30000);
    const delay = Math.min(max, base * 2 ** Math.min(6, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.opts.onError?.(
      new Error(`暂未连上本地 QQ 协议端 (${this.opts.endpoint.wsUrl})，请确认 SnowLuma/NapCat 已启动并登录小号，${Math.round(delay / 1000)} 秒后自动重试…`),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delay);
  }

  async callAction<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const echo = crypto.randomUUID().slice(0, 12);
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(echo);
          reject(new Error(`OneBot WS 调用 ${action} 超时`));
        }, timeoutMs);
        this.pending.set(echo, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });
        this.socket!.send(JSON.stringify({ action, params, echo }));
      });
    }
    const httpBase = String(this.opts.endpoint.httpUrl ?? '').trim().replace(/\/+$/, '');
    if (!httpBase) {
      throw new Error('OneBot WS 未连接且未配置 httpUrl 回退接口');
    }
    const token = String(this.opts.endpoint.httpAccessToken || this.opts.endpoint.wsAccessToken || '').trim();
    const res = await fetch(`${httpBase}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new Error(`OneBot HTTP ${action} 返回 ${res.status}${snippet ? `: ${snippet}` : ''}`);
    }
    let body: { status?: string; retcode?: number; wording?: string; data?: T };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new Error(`OneBot HTTP ${action} (${res.status}) 返回非 JSON 响应: ${raw.slice(0, 160)}`);
    }
    if (body.status === 'failed' || (typeof body.retcode === 'number' && body.retcode !== 0)) {
      throw new Error(body.wording || `OneBot retcode ${body.retcode}`);
    }
    return body.data as T;
  }

  getLoginInfo(): Promise<{ user_id?: number | string; nickname?: string }> {
    return this.callAction('get_login_info', {});
  }

  sendPrivateMsg(userId: string | number, message: string | OneBotSegment[]): Promise<{ message_id?: number | string }> {
    return this.callAction('send_private_msg', { user_id: toOneBotId(userId), message });
  }

  sendGroupMsg(groupId: string | number, message: string | OneBotSegment[]): Promise<{ message_id?: number | string }> {
    return this.callAction('send_group_msg', { group_id: toOneBotId(groupId), message });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('OneBot 客户端已关闭'));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}
