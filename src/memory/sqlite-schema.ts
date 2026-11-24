import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveArchivePaths } from '../soul/storage.ts';
import {
  buildFtsColumns,
  normalizeMemoryRow,
  type IndexedMemoryDoc,
  type TrackedMemoryFile,
} from './sqlite-tokenizer.ts';

export const INDEX_SCHEMA_VERSION = 3;

export interface SkippedJsonlLine {
  sourceFile: TrackedMemoryFile;
  lineNumber: number;
  reason: string;
}

export interface IndexedDocRow {
  docId: string;
  sourceFile: string;
  kind: string;
  seq: number;
  timestamp: string;
  bodyType: string;
  bodyId: string;
  speaker: string;
  role: string;
  provenance: string;
  status: string;
  title: string;
  text: string;
  metaJson: string;
}

export interface IndexedFtsHit extends IndexedDocRow {
  rank: number;
  matchedBy: 'bigram' | 'unigram';
}

export interface MemoryIndexSyncReport {
  ok: boolean;
  rebuilt: boolean;
  syncedFiles: string[];
  totalDocs: number;
  skippedCount: number;
  skippedLines: SkippedJsonlLine[];
  dbPath: string;
}

export interface MemoryIndexSearchResult {
  hits: IndexedFtsHit[];
  recentEpisodes: IndexedDocRow[];
  extraDocs: IndexedDocRow[];
  queryBigrams: string[];
  queryUnigrams: string[];
}

export interface FileSnapshotStat {
  exists: boolean;
  size: number;
  mtimeMs: number;
  lineCount: number;
  sha256: string;
}

export interface MetaDbRow {
  source_file: string;
  schema_version: number;
  file_size: number;
  mtime_ms: number;
  line_count: number;
  sha256: string;
}

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const RETRY_DELAYS_MS = [5, 15, 30, 50];
const RETRY_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export const DOC_SELECT_COLS = `
  d.doc_id AS docId, d.source_file AS sourceFile, d.kind AS kind, d.seq AS seq,
  d.timestamp AS timestamp, d.body_type AS bodyType, d.body_id AS bodyId,
  d.speaker AS speaker, d.role AS role, d.provenance AS provenance, d.status AS status,
  d.title AS title, d.text AS text, d.meta_json AS metaJson
`;

export function removeDbAndSidecars(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

export function renameWithRetry(src: string, dest: string): void {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (i < RETRY_DELAYS_MS.length && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        Atomics.wait(RETRY_SLEEP_BUF, 0, 0, RETRY_DELAYS_MS[i]);
        continue;
      }
      throw err;
    }
  }
}

export function isCorruptSqliteError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { errcode?: number; code?: string } | null)?.code;
  return /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database|no such table|no such column|has no column named/i.test(`${code ?? ''} ${msg}`);
}

export function resolveTrackedFilePath(dir: string, sourceFile: TrackedMemoryFile): string {
  return path.join(resolveArchivePaths(dir).memories, sourceFile);
}

function countPhysicalLines(buf: Buffer): number {
  if (!buf.length) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) count += 1;
  }
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

export function statAndHashFile(filePath: string, computeHash: boolean): FileSnapshotStat {
  if (!fs.existsSync(filePath)) {
    return { exists: false, size: 0, mtimeMs: 0, lineCount: 0, sha256: EMPTY_SHA256 };
  }
  const st = fs.statSync(filePath);
  const mtimeMs = Math.trunc(st.mtimeMs);
  if (!computeHash) return { exists: true, size: st.size, mtimeMs, lineCount: -1, sha256: '' };
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { exists: true, size: buf.length, mtimeMs, lineCount: countPhysicalLines(buf), sha256 };
}

function parseJsonlDocs(
  filePath: string,
  sourceFile: TrackedMemoryFile,
): { docs: IndexedMemoryDoc[]; skippedLines: SkippedJsonlLine[] } {
  if (!fs.existsSync(filePath)) return { docs: [], skippedLines: [] };
  const raw = fs.readFileSync(filePath, 'utf8');
  const docs: IndexedMemoryDoc[] = [];
  const skippedLines: SkippedJsonlLine[] = [];
  let lineIndex = 0;
  for (let start = 0; start < raw.length;) {
    const nl = raw.indexOf('\n', start);
    const end = nl < 0 ? raw.length : nl;
    const line = raw.slice(start, end).trim();
    lineIndex += 1;
    if (line) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          skippedLines.push({ sourceFile, lineNumber: lineIndex, reason: 'JSON 行不是对象' });
        } else {
          const doc = normalizeMemoryRow(sourceFile, parsed as Record<string, unknown>, lineIndex);
          if (doc) docs.push(doc);
          else skippedLines.push({ sourceFile, lineNumber: lineIndex, reason: '记录规范化失败' });
        }
      } catch (err) {
        skippedLines.push({
          sourceFile,
          lineNumber: lineIndex,
          reason: err instanceof Error ? err.message : 'JSON 解析失败',
        });
      }
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return { docs, skippedLines };
}

export function initIndexSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 1500;
    CREATE TABLE IF NOT EXISTS index_meta (
      source_file TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
      file_size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
      line_count INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL,
      skipped_count INTEGER NOT NULL DEFAULT 0, skipped_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS memory_docs (
      doc_id TEXT PRIMARY KEY, source_file TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL, body_type TEXT NOT NULL, body_id TEXT NOT NULL, speaker TEXT NOT NULL,
      role TEXT NOT NULL, provenance TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      text TEXT NOT NULL, meta_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_kind_status_seq ON memory_docs(kind, status, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_docs_source ON memory_docs(source_file);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(doc_id UNINDEXED, bigrams, unigrams, tokenize='unicode61');
  `);
}

export function openIndexDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 1500; PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;');
    return db;
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
}

export function insertDocAndFts(
  insDoc: ReturnType<DatabaseSync['prepare']>,
  insFts: ReturnType<DatabaseSync['prepare']>,
  doc: IndexedMemoryDoc,
): void {
  const res = insDoc.run(
    doc.docId, doc.sourceFile, doc.kind, doc.seq, doc.timestamp, doc.bodyType, doc.bodyId,
    doc.speaker, doc.role, doc.provenance, doc.status, doc.title, doc.text, doc.metaJson,
  );
  const cols = buildFtsColumns(doc.title, doc.text, doc.speaker, doc.extraFtsText);
  insFts.run(res.lastInsertRowid, doc.docId, cols.bigrams, cols.unigrams);
}

export function writeMetaRow(
  db: DatabaseSync,
  sourceFile: TrackedMemoryFile,
  st: FileSnapshotStat,
  skippedLines: SkippedJsonlLine[] = [],
): void {
  db.prepare(`
    INSERT OR REPLACE INTO index_meta (
      source_file, schema_version, file_size, mtime_ms, line_count, sha256, updated_at, skipped_count, skipped_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceFile, INDEX_SCHEMA_VERSION, st.size, st.mtimeMs, st.lineCount, st.sha256,
    new Date().toISOString(), skippedLines.length, JSON.stringify(skippedLines.slice(0, 50)),
  );
}

export function readSkippedSummary(db: DatabaseSync): { skippedCount: number; skippedLines: SkippedJsonlLine[] } {
  const rows = db.prepare('SELECT skipped_count, skipped_json FROM index_meta')
    .all() as unknown as Array<{ skipped_count?: number; skipped_json?: string }>;
  let skippedCount = 0;
  const skippedLines: SkippedJsonlLine[] = [];
  for (const r of rows) {
    skippedCount += Number(r.skipped_count ?? 0);
    if (r.skipped_json) {
      try {
        const parsed = JSON.parse(r.skipped_json) as unknown;
        if (Array.isArray(parsed)) skippedLines.push(...(parsed as SkippedJsonlLine[]));
      } catch {}
    }
  }
  return { skippedCount, skippedLines };
}

export function syncSourceFileInTx(
  db: DatabaseSync,
  dir: string,
  sourceFile: TrackedMemoryFile,
  preStat?: FileSnapshotStat,
): SkippedJsonlLine[] {
  const filePath = resolveTrackedFilePath(dir, sourceFile);
  const st = preStat && preStat.lineCount >= 0 ? preStat : statAndHashFile(filePath, true);
  const { docs, skippedLines } = parseJsonlDocs(filePath, sourceFile);
  if (skippedLines.length > 0) {
    console.warn(`[soul-index] 跳过损坏 JSONL 行: ${skippedLines.map((s) => `${s.sourceFile}:${s.lineNumber}`).join(', ')}`);
  }

  db.prepare('DELETE FROM memory_fts WHERE rowid IN (SELECT rowid FROM memory_docs WHERE source_file = ?)').run(sourceFile);
  db.prepare('DELETE FROM memory_docs WHERE source_file = ?').run(sourceFile);

  const insDoc = db.prepare(`
    INSERT OR REPLACE INTO memory_docs (
      doc_id, source_file, kind, seq, timestamp, body_type, body_id,
      speaker, role, provenance, status, title, text, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insFts = db.prepare('INSERT INTO memory_fts (rowid, doc_id, bigrams, unigrams) VALUES (?, ?, ?, ?)');
  for (const doc of docs) insertDocAndFts(insDoc, insFts, doc);
  writeMetaRow(db, sourceFile, st, skippedLines);
  return skippedLines;
}
