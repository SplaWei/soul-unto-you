import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, readMetaOrRecover, resolveArchivePaths, writeJsonAtomic } from './archive.ts';
import type { SoulMeta } from './types.ts';

export interface SnapshotFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SnapshotManifest {
  format: 'soul-snapshot/1.0';
  id: string;
  label: string;
  reason: string;
  createdAt: string;
  soulId: string;
  soulName: string;
  nextSeq: number;
  fileCount: number;
  totalBytes: number;
  auto?: boolean;
  files: SnapshotFileEntry[];
}

export interface RollbackResult {
  ok: true;
  restoredSnapshotId: string;
  restoredFiles: number;
  removedExtraFiles: number;
  safetySnapshotId?: string;
  restoredNextSeq: number;
}

const SNAPSHOT_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const TOP_CANONICAL_FILES = [
  'RESURRECTION.md', 'SEED.md', 'SOUL.md', 'EVOLVING-SELF.md', 'identity.json', 'meta.json', 'presence.json',
];
const TOP_CANONICAL_SET = new Set(TOP_CANONICAL_FILES);
const SUBDIR_SAFE_RE = /^(?:MEMORIES|INNER-LIFE)\/[A-Za-z0-9._-]+$/;
const REQUIRED_SNAPSHOT_FILES = ['meta.json', 'SEED.md', 'identity.json'];
const RETRY_DELAYS_MS = [5, 15, 30, 50];
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export const sha256Bytes = (data: string | Buffer): string =>
  crypto.createHash('sha256').update(data).digest('hex');

function writeBytesAtomic(filePath: string, data: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (i < RETRY_DELAYS_MS.length && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          Atomics.wait(SLEEP_BUF, 0, 0, RETRY_DELAYS_MS[i]);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function collectSubdirFiles(root: string, subDir: string, out: string[]): void {
  const base = path.join(root, subDir);
  if (!fs.existsSync(base)) return;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.includes('.corrupt-')) continue;
    const rel = `${subDir}/${entry.name}`;
    if (entry.isDirectory()) collectSubdirFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

export function listCanonicalArchiveFiles(
  dir: string,
  options: { includeDiary?: boolean; includePresence?: boolean } = {},
): string[] {
  const root = path.resolve(dir);
  const out: string[] = [];
  for (const name of TOP_CANONICAL_FILES) {
    if (name === 'presence.json' && options.includePresence === false) continue;
    if (fs.existsSync(path.join(root, name))) out.push(name);
  }
  collectSubdirFiles(root, 'MEMORIES', out);
  collectSubdirFiles(root, 'INNER-LIFE', out);
  const filtered = options.includeDiary === false ? out.filter((f) => f !== 'INNER-LIFE/diary.jsonl') : out;
  return filtered.sort();
}

function resolveSnapshotDir(dir: string, snapshotId: string): string {
  const id = String(snapshotId || '').trim();
  if (!SNAPSHOT_ID_RE.test(id)) throw new Error('快照 ID 格式无效');
  const snapsRoot = resolveArchivePaths(dir).snapshots;
  const target = path.resolve(snapsRoot, id);
  const rel = path.relative(snapsRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error('快照路径非法');
  }
  return target;
}

function isSafeRelativeArchivePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('..') || path.isAbsolute(relPath)) {
    return false;
  }
  if (relPath !== path.posix.normalize(relPath)) return false;
  return TOP_CANONICAL_SET.has(relPath) || SUBDIR_SAFE_RE.test(relPath);
}

export function pruneOldSnapshots(dir: string, maxSnapshots: number, protectIds: Set<string> = new Set()): void {
  if (maxSnapshots < 1) return;
  const all = listSnapshots(dir);
  const removable = all.filter((s) => !protectIds.has(s.id));
  const overflow = all.length - maxSnapshots;
  if (overflow <= 0) return;
  const victims = [
    ...removable.filter((s) => s.auto).reverse(),
    ...removable.filter((s) => !s.auto).reverse(),
  ].slice(0, overflow);
  for (const v of victims) {
    fs.rmSync(resolveSnapshotDir(dir, v.id), { recursive: true, force: true });
  }
}

export function createSnapshot(
  dir: string,
  options: { label?: string; reason?: string; auto?: boolean; maxSnapshots?: number; skipPrune?: boolean; protectIds?: string[] } = {},
): SnapshotManifest {
  const p = resolveArchivePaths(dir);
  const meta: Partial<SoulMeta> = fs.existsSync(p.meta) ? readMetaOrRecover(dir, { writeRecovered: false }) : {};
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `snap_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
  const snapDir = resolveSnapshotDir(dir, id);
  const filesRoot = path.join(snapDir, 'files');
  fs.mkdirSync(filesRoot, { recursive: true });

  const relFiles = listCanonicalArchiveFiles(dir);
  const entries: SnapshotFileEntry[] = [];
  let totalBytes = 0;

  for (const relPath of relFiles) {
    const src = path.join(p.root, relPath);
    const buf = fs.readFileSync(src);
    const dst = path.join(filesRoot, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    entries.push({ path: relPath, bytes: buf.length, sha256: sha256Bytes(buf) });
    totalBytes += buf.length;
  }

  const manifest: SnapshotManifest = {
    format: 'soul-snapshot/1.0',
    id,
    label: String(options.label || 'manual').trim().slice(0, 60) || 'manual',
    reason: String(options.reason || '时间点备份快照').trim().slice(0, 160),
    createdAt: now.toISOString(),
    soulId: String(meta.soulId || 'unknown'),
    soulName: String(meta.name || 'Soul'),
    nextSeq: Number(meta.nextSeq) || 1,
    fileCount: entries.length,
    totalBytes,
    ...(options.auto ? { auto: true } : {}),
    files: entries,
  };
  writeJsonAtomic(path.join(snapDir, 'manifest.json'), manifest);
  if (!options.skipPrune) {
    const protect = new Set([id, ...(options.protectIds ?? [])]);
    pruneOldSnapshots(dir, options.maxSnapshots ?? 30, protect);
  }
  return manifest;
}

export function listSnapshots(dir: string): SnapshotManifest[] {
  const snapsRoot = resolveArchivePaths(dir).snapshots;
  if (!fs.existsSync(snapsRoot)) return [];
  const out: SnapshotManifest[] = [];
  for (const entry of fs.readdirSync(snapsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_ID_RE.test(entry.name)) continue;
    const manifest = readJsonSafe<SnapshotManifest | null>(path.join(snapsRoot, entry.name, 'manifest.json'), null);
    if (manifest?.format === 'soul-snapshot/1.0' && Array.isArray(manifest.files)) out.push(manifest);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function verifySnapshotIntegrity(
  dir: string,
  snapshotId: string,
): { ok: boolean; manifest?: SnapshotManifest; error?: string } {
  let snapDir: string;
  try {
    snapDir = resolveSnapshotDir(dir, snapshotId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const manifestPath = path.join(snapDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: `快照不存在: ${snapshotId}` };
  const manifest = readJsonSafe<SnapshotManifest | null>(manifestPath, null);
  if (!manifest || manifest.format !== 'soul-snapshot/1.0' || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, error: `快照清单损坏或为空: ${snapshotId}` };
  }
  if (manifest.id !== snapshotId || typeof manifest.soulId !== 'string' || !manifest.soulId.trim()) {
    return { ok: false, error: `快照元数据不一致: ${snapshotId}` };
  }
  const listedPaths = new Set<string>();
  const filesRoot = path.join(snapDir, 'files');
  for (const entry of manifest.files) {
    if (!isSafeRelativeArchivePath(entry.path)) return { ok: false, error: `快照内包含非法文件路径: ${entry.path}` };
    if (typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes) || entry.bytes < 0) {
      return { ok: false, error: `快照字节数校验失败: ${entry.path}` };
    }
    const fp = path.join(filesRoot, entry.path);
    if (!fs.existsSync(fp)) return { ok: false, error: `快照文件缺失: ${entry.path}` };
    const buf = fs.readFileSync(fp);
    if (sha256Bytes(buf) !== entry.sha256) {
      return { ok: false, error: `快照校验失败（SHA-256 不匹配）: ${entry.path}` };
    }
    if (buf.length !== entry.bytes) return { ok: false, error: `快照文件体积不匹配: ${entry.path}` };
    listedPaths.add(entry.path);
  }
  for (const reqFile of REQUIRED_SNAPSHOT_FILES) {
    if (!listedPaths.has(reqFile)) return { ok: false, error: `快照缺少核心必备文件: ${reqFile}` };
  }
  return { ok: true, manifest };
}

function applySnapshotFiles(dir: string, snapshotId: string, manifest: SnapshotManifest): number {
  const p = resolveArchivePaths(dir);
  const snapFilesRoot = path.join(resolveSnapshotDir(dir, snapshotId), 'files');
  const liveBefore = listCanonicalArchiveFiles(dir);
  const keepSet = new Set(manifest.files.map((f) => f.path));

  for (const entry of manifest.files) {
    writeBytesAtomic(path.join(p.root, entry.path), fs.readFileSync(path.join(snapFilesRoot, entry.path)));
  }
  let removedExtraFiles = 0;
  for (const rel of liveBefore) {
    if (!keepSet.has(rel)) {
      fs.rmSync(path.join(p.root, rel), { force: true });
      removedExtraFiles += 1;
    }
  }
  fs.rmSync(p.vectors, { force: true });
  return removedExtraFiles;
}

export function rollbackToSnapshot(
  dir: string,
  snapshotId: string,
  options: { createSafetySnapshot?: boolean } = {},
): RollbackResult {
  const check = verifySnapshotIntegrity(dir, snapshotId);
  if (!check.ok || !check.manifest) throw new Error(check.error || `快照不可用: ${snapshotId}`);

  const manifest = check.manifest;
  const safety = options.createSafetySnapshot === false
    ? undefined
    : createSnapshot(dir, {
        label: 'auto-pre-rollback',
        reason: `回滚至 ${snapshotId} 前的自动保护快照`,
        auto: true,
        skipPrune: true,
      });

  let removedExtraFiles = 0;
  try {
    removedExtraFiles = applySnapshotFiles(dir, snapshotId, manifest);
  } catch (err) {
    if (safety) {
      try { applySnapshotFiles(dir, safety.id, safety); } catch {}
    }
    throw err;
  }

  pruneOldSnapshots(dir, 30, new Set([snapshotId, ...(safety ? [safety.id] : [])]));

  return {
    ok: true,
    restoredSnapshotId: manifest.id,
    restoredFiles: manifest.files.length,
    removedExtraFiles,
    ...(safety ? { safetySnapshotId: safety.id } : {}),
    restoredNextSeq: manifest.nextSeq,
  };
}

export function deleteSnapshot(dir: string, snapshotId: string): boolean {
  const snapDir = resolveSnapshotDir(dir, snapshotId);
  if (!fs.existsSync(snapDir)) return false;
  fs.rmSync(snapDir, { recursive: true, force: true });
  return true;
}
