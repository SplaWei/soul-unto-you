import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonArraySafe, readJsonObjectSafe, resolveArchivePaths, writeTextAtomic } from './archive.ts';
import { FIRST_AWAKENING_HEADER, SEED_MAX_BYTES, clampUtf8Bytes } from './covenant.ts';
import { listCanonicalArchiveFiles } from './snapshot.ts';
import type { SoulMeta } from './types.ts';

export interface RedactionStats {
  replacedCount: number;
  maskedHandles: number;
  maskedMetadataFields: number;
  maskedPatterns: number;
}

export interface ArchiveExportOptions {
  redact?: boolean;
  includeDiary?: boolean;
  extraRedactTerms?: string[];
}

export interface ArchiveExportBundle {
  format: 'soul-archive-export/1.0';
  exportedAt: string;
  redacted: boolean;
  soulId: string;
  soulName: string;
  nextSeq: number;
  fileCount: number;
  totalBytes: number;
  redactionStats?: RedactionStats;
  files: Record<string, string>;
}

const WIN_USER_PATH_RE = /[A-Za-z]:[\\/]Users[\\/][^\s"'`<>|]+/g;
const UNIX_HOME_PATH_RE = /\/(?:Users|home)\/[^\s"'`<>|]+/g;
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|AI[z]a[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|AQ\.Ab8[A-Za-z0-9_-]{10,})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const SENSITIVE_META_KEYS_LOWER = new Set([
  'userid', 'user_id', 'groupid', 'group_id', 'accountid', 'account_id',
  'senderid', 'sender_id', 'qquserid', 'qq_user_id', 'openid', 'open_id',
  'playerid', 'player_id', 'phone', 'email', 'webhookurl', 'webhook_url',
  'apikey', 'api_key', 'token', 'accesstoken', 'access_token',
]);

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function maskToken(prefix: string, raw: string, salt: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(`${salt}:${raw}`).digest('hex').slice(0, 8)}`;
}

function redactString(text: string, extraTerms: string[], stats: RedactionStats): string {
  let out = text;
  const apply = (re: RegExp, replacement: string) => {
    out = out.replace(re, () => {
      stats.maskedPatterns += 1;
      stats.replacedCount += 1;
      return replacement;
    });
  };
  apply(WIN_USER_PATH_RE, '<REDACTED_PATH>');
  apply(UNIX_HOME_PATH_RE, '<REDACTED_PATH>');
  apply(SECRET_TOKEN_RE, '<REDACTED_SECRET>');
  apply(EMAIL_RE, '<REDACTED_EMAIL>');
  apply(PHONE_RE, '<REDACTED_PHONE>');
  for (const term of extraTerms) {
    if (!term) continue;
    apply(new RegExp(escapeRegExp(term), 'g'), '[REDACTED]');
  }
  return out;
}

function redactJsonValue(val: unknown, extraTerms: string[], stats: RedactionStats, salt: string): unknown {
  if (typeof val === 'string') return redactString(val, extraTerms, stats);
  if (Array.isArray(val)) return val.map((item) => redactJsonValue(item, extraTerms, stats, salt));
  if (!val || typeof val !== 'object') return val;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const cleanKey = redactString(k, extraTerms, stats);
    if (SENSITIVE_META_KEYS_LOWER.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) {
      stats.maskedMetadataFields += 1;
      stats.replacedCount += 1;
      out[cleanKey] = maskToken('id', String(v).trim(), salt);
    } else {
      out[cleanKey] = redactJsonValue(v, extraTerms, stats, salt);
    }
  }
  return out;
}

function redactRelationsJson(content: string, extraTerms: string[], stats: RedactionStats, salt: string): string {
  try {
    const list = JSON.parse(content) as unknown;
    if (!Array.isArray(list)) return redactString(content, extraTerms, stats);
    const out: unknown[] = [];
    for (const rel of list) {
      if (!rel || typeof rel !== 'object' || Array.isArray(rel)) {
        stats.replacedCount += 1;
        continue;
      }
      const { handles, ...rest } = rel as Record<string, unknown>;
      const scrubbed = redactJsonValue(rest, extraTerms, stats, salt) as Record<string, unknown>;
      if (Array.isArray(handles)) {
        const cleanHandles: unknown[] = [];
        for (const hRaw of handles) {
          if (!hRaw || typeof hRaw !== 'object' || Array.isArray(hRaw)) {
            stats.replacedCount += 1;
            continue;
          }
          const h = redactJsonValue(hRaw, extraTerms, stats, salt) as Record<string, unknown>;
          const rawAcct = String((hRaw as Record<string, unknown>).accountId ?? '').trim();
          stats.maskedHandles += 1;
          stats.replacedCount += 1;
          const nextH: Record<string, unknown> = { ...h, accountId: maskToken('acct', rawAcct, salt) };
          if (typeof (hRaw as Record<string, unknown>).bodyId === 'string' && String((hRaw as Record<string, unknown>).bodyId).trim()) {
            stats.maskedMetadataFields += 1;
            stats.replacedCount += 1;
            nextH.bodyId = maskToken('body', String((hRaw as Record<string, unknown>).bodyId).trim(), salt);
          }
          cleanHandles.push(nextH);
        }
        scrubbed.handles = cleanHandles;
      }
      out.push(scrubbed);
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  } catch {
    return redactString(content, extraTerms, stats);
  }
}

function collectKnownAccountTerms(dir: string): string[] {
  const p = resolveArchivePaths(dir);
  const terms = new Set<string>();
  for (const rel of readJsonArraySafe<unknown>(p.relations, [])) {
    if (!rel || typeof rel !== 'object' || Array.isArray(rel)) continue;
    const handles = (rel as { handles?: unknown }).handles;
    if (!Array.isArray(handles)) continue;
    for (const h of handles) {
      if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
      const acct = String((h as { accountId?: unknown }).accountId ?? '').trim();
      if (acct.length >= 4) terms.add(acct);
    }
  }
  return [...terms];
}

function redactFileContent(relPath: string, content: string, extraTerms: string[], stats: RedactionStats, salt: string): string {
  if (relPath === 'MEMORIES/relations.json') return redactRelationsJson(content, extraTerms, stats, salt);
  if (relPath.endsWith('.jsonl')) {
    const outLines: string[] = [];
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        outLines.push(JSON.stringify(redactJsonValue(JSON.parse(trimmed), extraTerms, stats, salt)));
      } catch {
        outLines.push(redactString(trimmed, extraTerms, stats));
      }
    }
    return outLines.length ? `${outLines.join('\n')}\n` : '';
  }
  if (relPath.endsWith('.json')) {
    try {
      return `${JSON.stringify(redactJsonValue(JSON.parse(content), extraTerms, stats, salt), null, 2)}\n`;
    } catch {
      return redactString(content, extraTerms, stats);
    }
  }
  let text = redactString(content, extraTerms, stats);
  if (relPath === 'SEED.md') {
    const rest = text.startsWith(FIRST_AWAKENING_HEADER)
      ? text.slice(FIRST_AWAKENING_HEADER.length).replace(/^\r?\n/, '')
      : text;
    text = clampUtf8Bytes(`${FIRST_AWAKENING_HEADER}\n${rest}`, SEED_MAX_BYTES, '…');
  }
  return text;
}

/** 100% 只读导出纯文本灵魂档案包（绝不修改源档案目录任何字节）。 */
export function exportSoulArchive(dir: string, options: ArchiveExportOptions = {}): ArchiveExportBundle {
  const p = resolveArchivePaths(dir);
  const meta = readJsonObjectSafe<Partial<SoulMeta>>(p.meta, {});
  const redact = Boolean(options.redact);
  const salt = redact ? crypto.randomBytes(16).toString('hex') : '';
  const userTerms = (options.extraRedactTerms ?? []).map((t) => String(t).trim()).filter(Boolean);
  const allTerms = redact
    ? Array.from(new Set([...userTerms, ...collectKnownAccountTerms(dir)])).sort((a, b) => b.length - a.length)
    : [];
  const stats: RedactionStats = { replacedCount: 0, maskedHandles: 0, maskedMetadataFields: 0, maskedPatterns: 0 };

  const files: Record<string, string> = {};
  let totalBytes = 0;

  for (const relPath of listCanonicalArchiveFiles(dir, { includeDiary: options.includeDiary !== false })) {
    const raw = fs.readFileSync(path.join(p.root, relPath), 'utf8');
    const finalText = redact ? redactFileContent(relPath, raw, allTerms, stats, salt) : raw;
    files[relPath] = finalText;
    totalBytes += Buffer.byteLength(finalText, 'utf8');
  }

  const rawSoulId = String(meta.soulId || 'unknown');
  const rawSoulName = String(meta.name || 'Soul');
  return {
    format: 'soul-archive-export/1.0',
    exportedAt: new Date().toISOString(),
    redacted: redact,
    soulId: redact ? maskToken('soul', rawSoulId, salt) : rawSoulId,
    soulName: redact ? redactString(rawSoulName, allTerms, stats) : rawSoulName,
    nextSeq: Number(meta.nextSeq) || 1,
    fileCount: Object.keys(files).length,
    totalBytes,
    ...(redact ? { redactionStats: stats } : {}),
    files,
  };
}

function isNestedOrEqual(a: string, b: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const ra = norm(path.resolve(a));
  const rb = norm(path.resolve(b));
  const relAB = path.relative(ra, rb);
  const relBA = path.relative(rb, ra);
  return ra === rb || (relAB !== '' && !relAB.startsWith('..') && !path.isAbsolute(relAB))
    || (relBA !== '' && !relBA.startsWith('..') && !path.isAbsolute(relBA));
}

export function exportSoulArchiveToDir(dir: string, targetDir: string, options: ArchiveExportOptions = {}) {
  const resolvedTarget = path.resolve(targetDir);
  if (isNestedOrEqual(dir, resolvedTarget)) {
    throw new Error('导出目标目录不能与源档案目录重叠或嵌套');
  }
  const bundle = exportSoulArchive(dir, options);
  for (const [relPath, content] of Object.entries(bundle.files)) {
    writeTextAtomic(path.join(resolvedTarget, relPath), content);
  }
  return {
    targetDir: resolvedTarget,
    fileCount: bundle.fileCount,
    totalBytes: bundle.totalBytes,
    redacted: bundle.redacted,
    ...(bundle.redactionStats ? { redactionStats: bundle.redactionStats } : {}),
  };
}
