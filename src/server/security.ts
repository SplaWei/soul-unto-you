import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PUBLIC_STATIC_PATHS = new Set([
  '/',
  '/index.html',
  '/style.css',
  '/theme.css',
  '/app.js',
  '/workspace.js',
  '/inner-life.js',
  '/phase2.js',
  '/cosmos.js',
  '/i18n-en.js',
  '/i18n.js',
  '/favicon.svg',
  '/favicon.ico',
]);

export const SESSION_COOKIE_NAME = 'soul_session';

export function isPublicStaticPath(pathname: string): boolean {
  return PUBLIC_STATIC_PATHS.has(pathname);
}

function headerVal(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return String(raw ?? '').trim();
}

/** 获取或生成本地守护令牌（默认存于配置文件同目录的 .soul-hub.token）。 */
export function resolveOrCreateApiToken(configPath: string, explicitToken?: string): string {
  const manual = String(explicitToken || process.env.SOUL_API_TOKEN || '').trim();
  if (manual) return manual;
  const tokenPath = path.join(path.dirname(path.resolve(configPath)), '.soul-hub.token');
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
  } catch {}
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {}
  return fresh;
}

export function isLoopbackHost(hostHeader?: string): boolean {
  const host = String(hostHeader || '').trim();
  return /^(?:127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)|localhost|\[::1\])(:\d{1,5})?$/i.test(host);
}

export function isLoopbackBindHost(host?: string): boolean {
  const norm = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return norm === '::1' || norm === 'localhost'
    || /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(norm);
}

export function isLoopbackRemoteAddress(addr?: string): boolean {
  const raw = String(addr || '').trim().toLowerCase();
  if (!raw) return false;
  const norm = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return norm === '::1' || norm === 'localhost'
    || /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(norm);
}

export function isLoopbackOrigin(originHeader?: string): boolean {
  const raw = String(originHeader || '').trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return isLoopbackBindHost(u.hostname);
  } catch {
    return false;
  }
}

export function safeParseRequestUrl(req: IncomingMessage): URL | null {
  const rawHost = headerVal(req.headers.host) || '127.0.0.1';
  try {
    return new URL(req.url || '/', `http://${rawHost}`);
  } catch {
    return null;
  }
}

export function deriveSessionCookieToken(apiToken: string): string {
  return crypto.createHmac('sha256', apiToken).update('soul-web-session-v1').digest('hex');
}

export function extractSessionCookie(req: IncomingMessage): string {
  const raw = headerVal(req.headers.cookie);
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return '';
}

export function buildSessionCookieHeader(apiToken: string): string {
  return `${SESSION_COOKIE_NAME}=${deriveSessionCookieToken(apiToken)}; HttpOnly; SameSite=Strict; Path=/`;
}

export function extractRequestToken(req: IncomingMessage, url: URL): string {
  const xTok = headerVal(req.headers['x-soul-token']);
  if (xTok) return xTok;
  const auth = headerVal(req.headers.authorization);
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(url.searchParams.get('token') || '').trim();
}

export function tokensEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthorizedRequest(req: IncomingMessage, url: URL, expectedToken: string): boolean {
  if (tokensEqual(extractRequestToken(req, url), expectedToken)) return true;
  if (isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
    const sess = extractSessionCookie(req);
    if (sess && tokensEqual(sess, deriveSessionCookieToken(expectedToken))) return true;
  }
  return false;
}

export function checkHttpSecurity(
  req: IncomingMessage,
  url: URL,
  expectedToken: string,
  opts: { allowLan?: boolean } = {},
): { ok: true } | { ok: false; status: number; error: string } {
  const host = headerVal(req.headers.host);
  if (!opts.allowLan && !isLoopbackHost(host)) {
    return { ok: false, status: 403, error: '非法 Host 请求头已拦截' };
  }
  const secFetch = headerVal(req.headers['sec-fetch-site']).toLowerCase();
  const origin = headerVal(req.headers.origin);
  if (secFetch === 'cross-site' || (origin && !opts.allowLan && !isLoopbackOrigin(origin))) {
    return { ok: false, status: 403, error: '跨站 Origin 请求已拦截' };
  }

  const method = String(req.method || 'GET').toUpperCase();
  const pathname = url.pathname;
  if (method === 'GET' && (pathname === '/api/health' || PUBLIC_STATIC_PATHS.has(pathname))) {
    return { ok: true };
  }

  const isProtected = pathname.startsWith('/api/') || pathname === '/mcp' || pathname.startsWith('/v1/');
  if (isProtected) {
    if (!isAuthorizedRequest(req, url, expectedToken)) {
      return { ok: false, status: 401, error: '缺少或无效的本地访问令牌 (X-Soul-Token / Authorization: Bearer / 会话 Cookie)' };
    }
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const ctype = headerVal(req.headers['content-type']).toLowerCase();
      if (!ctype.includes('application/json')) {
        return { ok: false, status: 415, error: '写操作必须使用 Content-Type: application/json' };
      }
    }
  }
  return { ok: true };
}

export function checkWsSecurity(
  req: IncomingMessage,
  url: URL,
  expectedToken: string,
  opts: { allowLan?: boolean } = {},
): boolean {
  const host = headerVal(req.headers.host);
  if (!opts.allowLan && !isLoopbackHost(host)) return false;
  const secFetch = headerVal(req.headers['sec-fetch-site']).toLowerCase();
  const origin = headerVal(req.headers.origin);
  if (secFetch === 'cross-site' || (origin && !opts.allowLan && !isLoopbackOrigin(origin))) return false;
  return isAuthorizedRequest(req, url, expectedToken);
}

function resolveRealPathWithFallback(targetPath: string, depth = 0): string {
  if (depth > 16) return path.resolve(targetPath);
  let cur = path.resolve(targetPath);
  const trailing: string[] = [];
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink() && !fs.existsSync(cur)) {
        const linkTarget = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        const resolvedTarget = resolveRealPathWithFallback(linkTarget, depth + 1);
        return trailing.length ? path.join(resolvedTarget, ...trailing) : resolvedTarget;
      }
      if (fs.existsSync(cur)) break;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(targetPath);
    trailing.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    const realBase = fs.realpathSync(cur);
    return trailing.length ? path.join(realBase, ...trailing) : realBase;
  } catch {
    return path.resolve(targetPath);
  }
}

function isWithinDir(candidate: string, parentDir: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(path.resolve(parentDir)), norm(path.resolve(candidate)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 限制档案写入/切换目录在受信任白名单内（解析 symlink/junction 真实路径），防止任意目录覆写。 */
export function assertSafeArchiveDir(targetDir: string, currentArchiveDir: string, repoRoot: string): string {
  const raw = String(targetDir || '').trim();
  if (!raw) throw new Error('目标档案目录超出安全白名单范围：路径为空');
  const resolved = path.resolve(raw);
  const realResolved = resolveRealPathWithFallback(resolved);

  for (const checkPath of [resolved, realResolved]) {
    const parsed = path.parse(checkPath);
    if (checkPath === parsed.root) {
      throw new Error('目标档案目录超出安全白名单范围：禁止使用磁盘根目录');
    }
    if (/[\\/](Windows|System32|Program Files|Program Files \(x86\))([\\/]|$)/i.test(checkPath) || /^\/(bin|etc|usr|var|sys|proc|dev)(\/|$)/i.test(checkPath)) {
      throw new Error('目标档案目录超出安全白名单范围：禁止系统目录');
    }
  }

  const allowedRoots = [
    path.resolve(currentArchiveDir),
    path.join(os.homedir(), 'SoulArchive'),
    path.join(os.homedir(), '.soul-unto-you'),
    path.resolve(os.tmpdir()),
    path.join(path.resolve(repoRoot), 'examples'),
    path.join(path.resolve(repoRoot), 'private-souls'),
  ];
  const inside = allowedRoots.some((root) => {
    const realRoot = resolveRealPathWithFallback(root);
    return isWithinDir(resolved, root) && isWithinDir(realResolved, realRoot);
  });
  if (!inside) {
    throw new Error(`目标档案目录超出安全白名单范围: ${resolved}`);
  }
  return resolved;
}
