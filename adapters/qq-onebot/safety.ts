import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

export function escapeCqOutbound(text: string): string {
  return String(text ?? '').replace(/\[(CQ:)/gi, '&#91;$1');
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const clean = String(ipRaw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  const unwrapped = clean.startsWith('::ffff:') ? clean.slice(7) : clean;
  if (net.isIPv4(unwrapped)) {
    const parts = unwrapped.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(clean)) return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(clean)) return true;
    return false;
  }
  return true;
}

export function isSafePublicImageUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIP(host) !== 0 && isPrivateOrReservedIp(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function verifyHostnamePublicIps(hostname: string): Promise<boolean> {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(clean) !== 0) return !isPrivateOrReservedIp(clean);
  const records = await dns.lookup(clean, { all: true });
  if (!records.length) return false;
  return records.every((r) => !isPrivateOrReservedIp(r.address));
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const lenHeader = Number(res.headers.get('content-length') || 0);
  if (lenHeader > maxBytes) return null;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks, total);
}

export async function fetchSafeHttpsImageBase64(
  urls: string[],
  onWarn?: (msg: string) => void,
): Promise<Array<{ base64: string; mimeType: string }>> {
  const out: Array<{ base64: string; mimeType: string }> = [];
  for (const rawUrl of urls.slice(0, 2)) {
    if (!isSafePublicImageUrl(rawUrl)) {
      onWarn?.(`跳过非安全公网 HTTPS 图片地址: ${rawUrl.slice(0, 80)}`);
      continue;
    }
    try {
      const u = new URL(rawUrl);
      if (!(await verifyHostnamePublicIps(u.hostname))) {
        onWarn?.(`拦截解析至内网或保留 IP 的图片域名: ${u.hostname}`);
        continue;
      }
      const res = await fetch(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (res.status >= 300 && res.status < 400) {
        onWarn?.('图片请求返回重定向，安全策略已拒绝跟随');
        continue;
      }
      if (!res.ok) {
        onWarn?.(`下载 QQ 图片失败 [HTTP ${res.status}]`);
        continue;
      }
      const buf = await readBodyCapped(res, MAX_IMAGE_BYTES);
      if (!buf || !buf.length) continue;
      const ct = res.headers.get('content-type') || 'image/jpeg';
      out.push({ base64: buf.toString('base64'), mimeType: ct.split(';')[0].trim() });
    } catch (err) {
      onWarn?.(`下载 QQ 图片异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
