import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveArchivePaths } from '../soul/storage.ts';
import {
  DOC_SELECT_COLS,
  INDEX_SCHEMA_VERSION,
  initIndexSchema,
  insertDocAndFts,
  isCorruptSqliteError,
  openIndexDb,
  removeDbAndSidecars,
  renameWithRetry,
  resolveTrackedFilePath,
  statAndHashFile,
  syncSourceFileInTx,
  writeMetaRow,
  type FileSnapshotStat,
  type IndexedDocRow,
  type IndexedFtsHit,
  type MemoryIndexSearchResult,
  type MemoryIndexSyncReport,
  type MetaDbRow,
} from './sqlite-schema.ts';
import {
  TRACKED_MEMORY_FILES,
  buildFtsQueryExpressions,
  normalizeMemoryRow,
  type TrackedMemoryFile,
} from './sqlite-tokenizer.ts';

export {
  INDEX_SCHEMA_VERSION,
  type IndexedDocRow,
  type IndexedFtsHit,
  type MemoryIndexSearchResult,
  type MemoryIndexSyncReport,
};

function runInImmediateTx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

/** 从纯文本 MEMORIES/*.jsonl 100% 无损重建 .cache/memory-index.sqlite（原子替换）。 */
export function rebuildMemoryIndex(dir: string): MemoryIndexSyncReport {
  const p = resolveArchivePaths(dir);
  fs.mkdirSync(p.cache, { recursive: true });
  const tmp = path.join(p.cache, `.memory-index.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sqlite`);
  const db = new DatabaseSync(tmp);
  let totalDocs = 0;
  try {
    initIndexSchema(db);
    runInImmediateTx(db, () => {
      for (const sourceFile of TRACKED_MEMORY_FILES) syncSourceFileInTx(db, dir, sourceFile);
    });
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM memory_docs').get() as { cnt?: number } | undefined;
    totalDocs = Number(row?.cnt ?? 0);
  } finally {
    try { db.close(); } catch {}
  }
  try {
    removeDbAndSidecars(p.memoryIndexDb);
    renameWithRetry(tmp, p.memoryIndexDb);
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${tmp}${suffix}`, { force: true });
  } catch (err) {
    removeDbAndSidecars(tmp);
    throw err;
  }
  return { ok: true, rebuilt: true, syncedFiles: [...TRACKED_MEMORY_FILES], totalDocs, dbPath: p.memoryIndexDb };
}

/** 校验索引完整性与纯文本一致性；缺失或损坏时静默无损重建。 */
export function ensureMemoryIndex(dir: string, options: { verifyHash?: boolean } = {}): MemoryIndexSyncReport {
  const p = resolveArchivePaths(dir);
  if (!fs.existsSync(p.root)) {
    return { ok: true, rebuilt: false, syncedFiles: [], totalDocs: 0, dbPath: p.memoryIndexDb };
  }
  if (!fs.existsSync(p.memoryIndexDb)) return rebuildMemoryIndex(dir);

  const verifyHash = Boolean(options.verifyHash);
  let db: DatabaseSync | null = null;
  try {
    db = openIndexDb(p.memoryIndexDb);
    const metaRows = db.prepare(
      'SELECT source_file, schema_version, file_size, mtime_ms, line_count, sha256 FROM index_meta',
    ).all() as unknown as MetaDbRow[];
    const metaMap = new Map<string, MetaDbRow>(metaRows.map((r) => [r.source_file, r]));
    const dirty: Array<{ file: TrackedMemoryFile; stat: FileSnapshotStat }> = [];

    for (const sourceFile of TRACKED_MEMORY_FILES) {
      const prev = metaMap.get(sourceFile);
      const fp = resolveTrackedFilePath(dir, sourceFile);
      const st = statAndHashFile(fp, verifyHash);
      if (!prev || prev.schema_version !== INDEX_SCHEMA_VERSION) {
        dirty.push({ file: sourceFile, stat: st.lineCount >= 0 ? st : statAndHashFile(fp, true) });
      } else if (verifyHash) {
        if (prev.sha256 !== st.sha256 || prev.line_count !== st.lineCount || prev.file_size !== st.size) {
          dirty.push({ file: sourceFile, stat: st });
        }
      } else if (prev.file_size !== st.size || prev.mtime_ms !== st.mtimeMs) {
        const hashed = statAndHashFile(fp, true);
        if (prev.sha256 !== hashed.sha256 || prev.line_count !== hashed.lineCount) {
          dirty.push({ file: sourceFile, stat: hashed });
        } else {
          db.prepare('UPDATE index_meta SET mtime_ms = ?, updated_at = ? WHERE source_file = ?')
            .run(hashed.mtimeMs, new Date().toISOString(), sourceFile);
        }
      }
    }

    if (dirty.length) {
      runInImmediateTx(db, () => {
        for (const item of dirty) syncSourceFileInTx(db!, dir, item.file, item.stat);
      });
    }
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM memory_docs').get() as { cnt?: number } | undefined;
    return {
      ok: true, rebuilt: false, syncedFiles: dirty.map((d) => d.file),
      totalDocs: Number(row?.cnt ?? 0), dbPath: p.memoryIndexDb,
    };
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      try { db?.close(); } catch {}
      db = null;
      removeDbAndSidecars(p.memoryIndexDb);
      return rebuildMemoryIndex(dir);
    }
    throw err;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** 按 doc_id 增量更新少量变更记录；仅行数不符或缺失/损坏时才整文件同步或重建。 */
export function updateMemoryIndexRecords(
  dir: string,
  sourceFile: TrackedMemoryFile,
  rawRecords: Array<Record<string, unknown>>,
  isAppend = false,
): void {
  if (!rawRecords.length) return;
  const p = resolveArchivePaths(dir);
  if (!fs.existsSync(p.memoryIndexDb)) {
    rebuildMemoryIndex(dir);
    return;
  }
  const st = statAndHashFile(resolveTrackedFilePath(dir, sourceFile), true);
  const docs = rawRecords
    .map((r, i) => normalizeMemoryRow(sourceFile, r, Math.max(1, st.lineCount - rawRecords.length + i + 1)))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));
  if (!docs.length) return;

  let db: DatabaseSync | null = null;
  try {
    db = openIndexDb(p.memoryIndexDb);
    const prev = db.prepare('SELECT schema_version, line_count FROM index_meta WHERE source_file = ?')
      .get(sourceFile) as { schema_version?: number; line_count?: number } | undefined;
    const expectedLines = (prev?.line_count ?? 0) + (isAppend ? rawRecords.length : 0);

    runInImmediateTx(db, () => {
      if (prev && prev.schema_version === INDEX_SCHEMA_VERSION && st.lineCount === expectedLines) {
        const findOld = db!.prepare('SELECT rowid FROM memory_docs WHERE doc_id = ?');
        const delFts = db!.prepare('DELETE FROM memory_fts WHERE rowid = ?');
        const delDoc = db!.prepare('DELETE FROM memory_docs WHERE rowid = ?');
        const insDoc = db!.prepare(`
          INSERT INTO memory_docs (
            doc_id, source_file, kind, seq, timestamp, body_type, body_id,
            speaker, role, provenance, status, title, text, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insFts = db!.prepare('INSERT INTO memory_fts (rowid, doc_id, bigrams, unigrams) VALUES (?, ?, ?, ?)');
        for (const doc of docs) {
          const oldRow = findOld.get(doc.docId) as { rowid?: number } | undefined;
          if (oldRow?.rowid !== undefined) {
            delFts.run(oldRow.rowid);
            delDoc.run(oldRow.rowid);
          }
          insertDocAndFts(insDoc, insFts, doc);
        }
        writeMetaRow(db!, sourceFile, st);
      } else {
        syncSourceFileInTx(db!, dir, sourceFile, st);
      }
    });
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      try { db?.close(); } catch {}
      db = null;
      removeDbAndSidecars(p.memoryIndexDb);
      rebuildMemoryIndex(dir);
      return;
    }
    throw err;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** 单条纯文本追加落盘后增量更新索引；若行数跳变或索引损坏则自动修复。 */
export function upsertMemoryIndexRecord(
  dir: string,
  sourceFile: TrackedMemoryFile,
  rawRecord: Record<string, unknown>,
): void {
  updateMemoryIndexRecords(dir, sourceFile, [rawRecord], true);
}

/** 整文件覆写后同步对应 sourceFile 的索引分片；缺失或损坏时自动整库重建。 */
export function syncMemoryIndexFile(dir: string, sourceFile: TrackedMemoryFile): void {
  const p = resolveArchivePaths(dir);
  if (!fs.existsSync(p.memoryIndexDb)) {
    rebuildMemoryIndex(dir);
    return;
  }
  let db: DatabaseSync | null = null;
  try {
    db = openIndexDb(p.memoryIndexDb);
    runInImmediateTx(db, () => syncSourceFileInTx(db!, dir, sourceFile));
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      try { db?.close(); } catch {}
      db = null;
      removeDbAndSidecars(p.memoryIndexDb);
      rebuildMemoryIndex(dir);
      return;
    }
    throw err;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function getMemoryIndexStatus(dir: string): { exists: boolean; dbPath: string; docCount: number } {
  const p = resolveArchivePaths(dir);
  if (!fs.existsSync(p.memoryIndexDb)) return { exists: false, dbPath: p.memoryIndexDb, docCount: 0 };
  let db: DatabaseSync | null = null;
  try {
    db = openIndexDb(p.memoryIndexDb);
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM memory_docs').get() as { cnt?: number } | undefined;
    return { exists: true, dbPath: p.memoryIndexDb, docCount: Number(row?.cnt ?? 0) };
  } catch (err) {
    if (isCorruptSqliteError(err)) return { exists: false, dbPath: p.memoryIndexDb, docCount: 0 };
    throw err;
  } finally {
    try { db?.close(); } catch {}
  }
}

function hasStrongBigramHit(rows: IndexedFtsHit[], queryBigrams: string[]): boolean {
  if (!rows.length || !queryBigrams.length) return false;
  const threshold = queryBigrams.length <= 3 ? 0.4 : 0.25;
  for (const row of rows) {
    const hay = `${row.title} ${row.text} ${row.speaker}`.toLowerCase();
    let hits = 0;
    for (const tok of queryBigrams) {
      if (hay.includes(tok)) hits += 1;
    }
    if (hits / queryBigrams.length >= threshold) return true;
  }
  return false;
}

/** 使用 SQLite FTS5 进行亚 50ms 万级检索（bigram 优先 + 中文实义单字回退 + 近期情景兜底）。 */
export function searchMemoryIndex(
  dir: string,
  query: string,
  options: { candidateLimit?: number; recentEpisodeLimit?: number; extraDocIds?: string[] } = {},
): MemoryIndexSearchResult {
  ensureMemoryIndex(dir, { verifyHash: false });
  const p = resolveArchivePaths(dir);
  const { bigramMatch, unigramMatch, queryBigrams, queryUnigrams } = buildFtsQueryExpressions(query);
  const candidateLimit = Math.max(10, options.candidateLimit ?? 60);
  const recentEpisodeLimit = Math.max(0, options.recentEpisodeLimit ?? 16);

  const runSearch = (): MemoryIndexSearchResult => {
    const db = openIndexDb(p.memoryIndexDb);
    try {
      const ftsSql = `
        SELECT ${DOC_SELECT_COLS}, bm25(memory_fts) AS rank
        FROM memory_fts f JOIN memory_docs d ON d.rowid = f.rowid
        WHERE memory_fts MATCH ? AND d.kind IN ('episode', 'journal') AND d.status = 'active'
        ORDER BY rank LIMIT ?
      `;
      const hitMap = new Map<string, IndexedFtsHit>();
      if (bigramMatch) {
        const rows = db.prepare(ftsSql).all(bigramMatch, candidateLimit) as unknown as Array<IndexedDocRow & { rank: number }>;
        for (const r of rows) hitMap.set(r.docId, { ...r, matchedBy: 'bigram' });
      }
      const stage1 = [...hitMap.values()];
      if (unigramMatch && !hasStrongBigramHit(stage1, queryBigrams)) {
        const uniRows = db.prepare(ftsSql).all(unigramMatch, 40) as unknown as Array<IndexedDocRow & { rank: number }>;
        for (const r of uniRows) {
          if (!hitMap.has(r.docId)) hitMap.set(r.docId, { ...r, matchedBy: 'unigram' });
        }
      }

      const recentEpisodes = recentEpisodeLimit > 0
        ? (db.prepare(`
            SELECT ${DOC_SELECT_COLS} FROM memory_docs d
            WHERE d.kind = 'episode' AND d.status = 'active'
            ORDER BY d.seq DESC LIMIT ?
          `).all(recentEpisodeLimit) as unknown as IndexedDocRow[])
        : [];

      const extraIds = (options.extraDocIds ?? []).filter(Boolean).slice(0, 200);
      let extraDocs: IndexedDocRow[] = [];
      if (extraIds.length) {
        const placeholders = extraIds.map(() => '?').join(', ');
        extraDocs = db.prepare(`SELECT ${DOC_SELECT_COLS} FROM memory_docs d WHERE d.doc_id IN (${placeholders})`)
          .all(...extraIds) as unknown as IndexedDocRow[];
      }
      return { hits: [...hitMap.values()], recentEpisodes, extraDocs, queryBigrams, queryUnigrams };
    } finally {
      db.close();
    }
  };

  try {
    return runSearch();
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      removeDbAndSidecars(p.memoryIndexDb);
      rebuildMemoryIndex(dir);
      return runSearch();
    }
    throw err;
  }
}
