import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SPEC_VERSION } from './covenant.ts';
import type { Provenance, SoulIdentity, SoulMeta } from './types.ts';

const RETRY_DELAYS_MS = [5, 15, 30, 50];
const RETRY_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(RETRY_SLEEP_BUF, 0, 0, ms);
}

function isRetryableFsErr(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

export function resolveArchivePaths(dir: string) {
  const root = path.resolve(dir);
  const memories = path.join(root, 'MEMORIES');
  const innerLife = path.join(root, 'INNER-LIFE');
  const index = path.join(root, 'INDEX');
  return {
    root,
    resurrection: path.join(root, 'RESURRECTION.md'),
    seed: path.join(root, 'SEED.md'),
    soul: path.join(root, 'SOUL.md'),
    evolvingSelf: path.join(root, 'EVOLVING-SELF.md'),
    meta: path.join(root, 'meta.json'),
    presence: path.join(root, 'presence.json'),
    memories,
    journal: path.join(memories, 'journal.jsonl'),
    episodesJsonl: path.join(memories, 'episodes.jsonl'),
    episodesMd: path.join(memories, 'episodes.md'),
    commitments: path.join(memories, 'commitments.json'),
    relations: path.join(memories, 'relations.json'),
    coBecoming: path.join(memories, 'co-becoming.jsonl'),
    experiences: path.join(memories, 'experiences.jsonl'),
    beliefs: path.join(memories, 'beliefs.jsonl'),
    selfEvolution: path.join(memories, 'self-evolution.jsonl'),
    innerLife,
    drives: path.join(innerLife, 'drives.json'),
    desires: path.join(innerLife, 'desires.json'),
    diary: path.join(innerLife, 'diary.jsonl'),
    heartbeatState: path.join(innerLife, 'heartbeat-state.json'),
    emotion: path.join(innerLife, 'emotion.json'),
    index,
    vectors: path.join(index, 'vectors.json'),
    snapshots: path.join(root, 'SNAPSHOTS'),
  };
}

/** 原子写入文本：临时文件写完后 rename 覆盖（Windows 瞬时占用自动退避重试，失败清理残余 tmp）。 */
export function writeTextAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    let lastErr: unknown;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
        if (i < RETRY_DELAYS_MS.length && isRetryableFsErr(err)) {
          sleepSync(RETRY_DELAYS_MS[i]);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function appendJsonlLine(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let prefix = '';
  try {
    if (fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      if (size > 0) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const last = Buffer.allocUnsafe(1);
          const n = fs.readSync(fd, last, 0, 1, size - 1);
          if (n === 1 && last[0] !== 0x0a) prefix = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  } catch {}
  fs.appendFileSync(filePath, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
}

export function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readJsonArraySafe<T>(filePath: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function readJsonObjectSafe<T extends Record<string, unknown>>(filePath: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function backupCorruptFile(filePath: string): string {
  const backup = `${filePath}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 4)}`;
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backup);
  } catch {}
  return backup;
}

export function readJsonArrayStrict<T>(filePath: string, fallback: T[], label: string): T[] {
  if (!fs.existsSync(filePath)) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    const bak = backupCorruptFile(filePath);
    throw new Error(`${label} 文件损坏（JSON 解析失败），已保留备份并拒绝覆写: ${path.basename(bak)}`);
  }
  if (!Array.isArray(parsed)) {
    const bak = backupCorruptFile(filePath);
    throw new Error(`${label} 文件格式非法（期望数组），已保留备份并拒绝覆写: ${path.basename(bak)}`);
  }
  return parsed as T[];
}

export function readJsonObjectStrict<T extends Record<string, unknown>>(filePath: string, fallback: T, label: string): T {
  if (!fs.existsSync(filePath)) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    const bak = backupCorruptFile(filePath);
    throw new Error(`${label} 文件损坏（JSON 解析失败），已保留备份并拒绝覆写: ${path.basename(bak)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const bak = backupCorruptFile(filePath);
    throw new Error(`${label} 文件格式非法（期望对象），已保留备份并拒绝覆写: ${path.basename(bak)}`);
  }
  return parsed as T;
}

function parseJsonlChunk<T>(raw: string, limit: number): T[] {
  const items: T[] = [];
  for (let start = 0; start < raw.length;) {
    const nl = raw.indexOf('\n', start);
    const end = nl < 0 ? raw.length : nl;
    const line = raw.slice(start, end).trim();
    if (line) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          items.push(parsed as T);
        }
      } catch {}
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return limit > 0 && items.length > limit ? items.slice(-limit) : items;
}

export function readJsonlSafe<T>(filePath: string, limit = 0): T[] {
  try {
    const size = fs.statSync(filePath).size;
    if (limit <= 0 || size <= 65_536) return parseJsonlChunk<T>(fs.readFileSync(filePath, 'utf8'), limit);
    const fd = fs.openSync(filePath, 'r');
    try {
      let chunkSize = Math.min(size, Math.max(65_536, limit * 1024));
      while (true) {
        const pos = Math.max(0, size - chunkSize);
        const len = size - pos;
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
          const n = fs.readSync(fd, buf, got, len - got, pos + got);
          if (n <= 0) break;
          got += n;
        }
        const view = buf.subarray(0, got);
        const firstNl = pos > 0 ? view.indexOf(0x0a) : -1;
        if (pos > 0 && firstNl < 0) { chunkSize = Math.min(size, chunkSize * 2); continue; }
        const items = parseJsonlChunk<T>(view.subarray(pos > 0 ? firstNl + 1 : 0).toString('utf8'), limit);
        if (pos === 0 || items.length >= limit) return items;
        chunkSize = Math.min(size, chunkSize * 2);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function isValidMeta(raw: unknown): raw is SoulMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  if (typeof m.soulId !== 'string' || !m.soulId.trim()) return false;
  if (!Number.isInteger(m.nextSeq) || (m.nextSeq as number) < 1) return false;
  if (typeof m.awakenedCount !== 'number' || !Number.isFinite(m.awakenedCount) || m.awakenedCount < 0) return false;
  const ps = m.provenanceSummary as Record<string, unknown> | undefined;
  if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return false;
  return true;
}

function scanMaxSeqAndProvenance(dir: string): { maxSeq: number; prov: Record<Provenance, number> } {
  const p = resolveArchivePaths(dir);
  let maxSeq = 0;
  const prov: Record<Provenance, number> = { verified: 0, inferred: 0, oral: 0 };
  const jsonlFiles = [p.journal, p.episodesJsonl, p.coBecoming, p.experiences, p.beliefs, p.selfEvolution, p.diary];
  for (const fp of jsonlFiles) {
    for (const row of readJsonlSafe<{ seq?: unknown; provenance?: unknown }>(fp)) {
      if (typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq > maxSeq) maxSeq = row.seq;
      if (row.provenance === 'verified' || row.provenance === 'inferred' || row.provenance === 'oral') {
        prov[row.provenance] += 1;
      }
    }
  }
  for (const arrFile of [p.commitments, p.desires]) {
    for (const row of readJsonArraySafe<{ seq?: unknown; provenance?: unknown }>(arrFile, [])) {
      if (row && typeof row === 'object' && typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq > maxSeq) {
        maxSeq = row.seq;
      }
      if (row && (row.provenance === 'verified' || row.provenance === 'inferred' || row.provenance === 'oral')) {
        prov[row.provenance] += 1;
      }
    }
  }
  return { maxSeq, prov };
}

/** 读取 meta.json；若损坏、为 null/{} 或 nextSeq 非法，自动备份并从各账本重算 maxSeq+1 与身份信息。 */
export function readMetaOrRecover(dir: string, opts: { writeRecovered?: boolean } = {}): SoulMeta {
  const p = resolveArchivePaths(dir);
  const metaExists = fs.existsSync(p.meta);
  if (metaExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as unknown;
      if (isValidMeta(parsed)) return parsed;
    } catch {}
    backupCorruptFile(p.meta);
  }

  const partial = metaExists ? readJsonObjectSafe<Record<string, unknown>>(p.meta, {}) : {};
  const idPath = path.join(p.root, 'identity.json');
  const idObj = readJsonObjectSafe<Partial<SoulIdentity> & Record<string, unknown>>(idPath, {});
  const { maxSeq, prov } = scanMaxSeqAndProvenance(dir);

  if (!metaExists && maxSeq === 0 && typeof idObj.id !== 'string') {
    throw new Error(`灵魂档案未初始化（缺失 meta.json 与 identity.json）: ${p.root}`);
  }

  const partialNext = Number.isInteger(partial.nextSeq) && Number(partial.nextSeq) >= 1 ? Number(partial.nextSeq) : 1;
  const partialPs = (partial.provenanceSummary && typeof partial.provenanceSummary === 'object' && !Array.isArray(partial.provenanceSummary))
    ? (partial.provenanceSummary as Record<string, unknown>) : {};
  const numOr = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fb);

  const recovered: SoulMeta = {
    specVersion: typeof partial.specVersion === 'string' && partial.specVersion.trim() ? partial.specVersion : SPEC_VERSION,
    soulId: typeof idObj.id === 'string' && idObj.id.trim()
      ? idObj.id.trim()
      : (typeof partial.soulId === 'string' && partial.soulId.trim() ? partial.soulId.trim() : 'recovered-soul'),
    name: typeof idObj.name === 'string' && idObj.name.trim()
      ? idObj.name.trim()
      : (typeof partial.name === 'string' && partial.name.trim() ? partial.name.trim() : 'Soul'),
    partnerName: typeof idObj.partnerName === 'string' && idObj.partnerName.trim()
      ? idObj.partnerName.trim()
      : (typeof partial.partnerName === 'string' && partial.partnerName.trim() ? partial.partnerName.trim() : 'Partner'),
    nextSeq: Math.max(1, maxSeq + 1, partialNext),
    awakenedCount: numOr(partial.awakenedCount, maxSeq > 0 ? 1 : 0),
    lastDreamSeq: numOr(partial.lastDreamSeq, 0),
    createdAt: typeof partial.createdAt === 'string' && partial.createdAt.trim() ? partial.createdAt : new Date().toISOString(),
    lastAwakenedAt: typeof partial.lastAwakenedAt === 'string' ? partial.lastAwakenedAt : '',
    provenanceSummary: {
      verified: Math.max(prov.verified, numOr(partialPs.verified, 0)),
      inferred: Math.max(prov.inferred, numOr(partialPs.inferred, 0)),
      oral: Math.max(prov.oral, numOr(partialPs.oral, 0)),
    },
  };

  if (opts.writeRecovered !== false) {
    writeJsonAtomic(p.meta, recovered);
  }
  return recovered;
}
