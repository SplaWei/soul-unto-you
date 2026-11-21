import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { WebhookSubscription } from '../soul/types.ts';

interface StoredWebhook extends WebhookSubscription {
  bodyId?: string;
}

const METADATA_HOSTS = new Set([
  '0.0.0.0',
  '::',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);
const BODY_SCOPED_EVENTS = new Set([
  'proactive',
  'percept',
  'observe',
  'memory.engraved',
  'experience.recorded',
  'body.registered',
]);

function extractRawAuthorityHost(raw: string): string {
  const m = raw.trim().match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return '';
  const noUserInfo = m[1].replace(/^[^@]*@/, '');
  if (noUserInfo.startsWith('[')) {
    const end = noUserInfo.indexOf(']');
    return end > 0 ? noUserInfo.slice(1, end).toLowerCase() : '';
  }
  return noUserInfo.replace(/:\d+$/, '').toLowerCase();
}

function isObfuscatedIpHost(rawHost: string): boolean {
  if (!rawHost) return true;
  if (/^\d+$/.test(rawHost)) return true;
  if (/^0x[0-9a-f]+(\.|$)/i.test(rawHost)) return true;
  if (/(?:^|\.)0\d+(?:\.|$)/.test(rawHost)) return true;
  return /^\d+\.\d+(?:\.\d+)?$/.test(rawHost);
}

function parseIpv4OrMapped(host: string): [number, number, number, number] | null {
  const target = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
    const parts = target.split('.').map(Number);
    return parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ? [parts[0], parts[1], parts[2], parts[3]]
      : null;
  }
  if (!host.startsWith('::ffff:')) return null;
  const hexPair = target.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexPair) {
    const hi = Number.parseInt(hexPair[1], 16);
    const lo = Number.parseInt(hexPair[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  if (/^[0-9a-f]{1,4}$/i.test(target)) {
    const lo = Number.parseInt(target, 16);
    return [0, 0, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function isBlockedIpv4Octets(octets: [number, number, number, number], mappedFromV6: boolean): boolean {
  const [a, b] = octets;
  if (mappedFromV6 && a === 127) return true;
  return a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

/**
 * 校验出站 Webhook 地址：允许标准回环（127.0.0.1 / localhost / [::1]）用于本机躯体适配桥接，
 * 严格拦截非规范数字/十六进制混淆地址、云元数据、IPv6 链路本地/私有段、私网及 ::ffff: 映射地址。
 */
export function isValidWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const rawHost = extractRawAuthorityHost(raw);
    if (isObfuscatedIpHost(rawHost)) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || METADATA_HOSTS.has(host) || host.endsWith('.metadata.internal')) return false;
    if (host === '::' || /^fe[89ab][0-9a-f]?:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host) || /^ff[0-9a-f]{2}:/i.test(host)) {
      return false;
    }
    const v4 = parseIpv4OrMapped(host);
    if (v4 && isBlockedIpv4Octets(v4, host.startsWith('::ffff:'))) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveTargetBodyId(eventName: string, payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const obj = payload as Record<string, unknown>;
  if (eventName === 'body.action' && typeof obj.targetBodyId === 'string') return obj.targetBodyId.trim();
  if (BODY_SCOPED_EVENTS.has(eventName) && typeof obj.bodyId === 'string') return obj.bodyId.trim();
  return '';
}

export class SoulEventBus {
  private readonly sseClients: Map<ServerResponse, string>;
  private readonly webhooks: Map<string, StoredWebhook>;

  constructor() {
    this.sseClients = new Map<ServerResponse, string>();
    this.webhooks = new Map<string, StoredWebhook>();
  }

  subscribeSse(res: ServerResponse, bodyId = ''): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, ts: new Date().toISOString() })}\n\n`);
    this.sseClients.set(res, bodyId.trim());
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  getOnlineBodyIds(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.sseClients.values()) {
      if (id) ids.add(id);
    }
    return ids;
  }

  addWebhook(input: { url: string; events?: string[]; bodyId?: string }): WebhookSubscription {
    const url = String(input.url ?? '').trim();
    if (!isValidWebhookUrl(url)) {
      throw new Error('Webhook URL 必须是合法且安全的 http:// 或 https:// 地址（禁止元数据或链路本地地址）');
    }
    const events = Array.isArray(input.events) && input.events.length
      ? input.events.map((e) => String(e).trim()).filter(Boolean)
      : ['*'];
    const bodyId = String(input.bodyId ?? '').trim();
    const sub: StoredWebhook = {
      id: `wh_${crypto.randomUUID().slice(0, 8)}`,
      url,
      events,
      createdAt: new Date().toISOString(),
      ...(bodyId ? { bodyId } : {}),
    };
    this.webhooks.set(sub.id, sub);
    return sub;
  }

  removeWebhook(id: string): boolean {
    return this.webhooks.delete(id);
  }

  listWebhooks(): WebhookSubscription[] {
    return Array.from(this.webhooks.values());
  }

  emit(eventName: string, payload: unknown): void {
    const envelope = {
      event: eventName,
      timestamp: new Date().toISOString(),
      payload,
    };
    const targetBodyId = resolveTargetBodyId(eventName, payload);
    const sseChunk = `event: ${eventName}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const [res, clientBodyId] of this.sseClients.entries()) {
      if (targetBodyId && clientBodyId && clientBodyId !== targetBodyId) continue;
      try {
        if (!res.writableEnded) res.write(sseChunk);
      } catch {
        this.sseClients.delete(res);
      }
    }

    for (const sub of this.webhooks.values()) {
      if (!sub.events.includes('*') && !sub.events.includes(eventName)) continue;
      if (targetBodyId && sub.bodyId && sub.bodyId !== targetBodyId) continue;
      void fetch(sub.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-soul-event': eventName },
        body: JSON.stringify(envelope),
        redirect: 'manual',
        signal: AbortSignal.timeout(4000),
      }).catch(() => {
        // 静默容错，绝不阻塞灵魂主循环
      });
    }
  }

  closeAll(): void {
    for (const res of this.sseClients.keys()) {
      try {
        if (!res.writableEnded) res.end();
      } catch {}
    }
    this.sseClients.clear();
  }
}
