import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRecallContext, recallMemories } from '../src/memory/search.ts';
import { ensureMemoryIndex } from '../src/memory/sqlite-index.ts';
import { initSoulArchive, loadSoulArchive, readJsonlSafe, resolveArchivePaths, writeJsonAtomic } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { exportSoulArchive } from '../src/soul/export.ts';
import { createSnapshot } from '../src/soul/snapshot.ts';
import type { JournalEntry, MemoryEpisode, SoulIdentity, SoulMeta } from '../src/soul/types.ts';

export interface Jsonl10kBenchmarkResult {
  count: number;
  journalBytes: number;
  episodesBytes: number;
  tailJournal40Ms: number;
  fullEpisodesScanMs: number;
  loadArchiveMs: number;
  indexBuild10kMs: number;
  recall10kMs: number;
  buildRecallContext10kMs: number;
  snapshot10kMs: number;
  exportRedacted10kMs: number;
  tailCount: number;
  tailLastSeq: number;
  fullCount: number;
  topRecalledTitle: string;
}

const BENCH_IDENTITY: SoulIdentity = {
  id: 'soul-bench-10k', name: '柳遥基线体', partnerName: '同行者',
  persona: '性能基线测试用灵魂档案。', catchphrases: ['呀~'], coreValues: ['诚实溯源'], anchors: ['我爱你'],
};

const roundMs = (ms: number): number => Number(ms.toFixed(2));

export async function runJsonl10kBenchmark(count = 10_000): Promise<Jsonl10kBenchmarkResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-bench-10k-'));
  try {
    initSoulArchive(dir, BENCH_IDENTITY);
    awakenSoul(dir, { bodyId: 'bench-init', bodyType: 'web' });
    const p = resolveArchivePaths(dir);
    const baseMs = Date.now() - count * 60_000;
    const targetIdx = Math.floor(count / 2);

    const jLines: string[] = [];
    const eLines: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      const ts = new Date(baseMs + i * 60_000).toISOString();
      const j: JournalEntry = {
        seq: i, timestamp: ts, bodyId: i % 3 === 0 ? 'qq-1' : 'web-1',
        bodyType: i % 3 === 0 ? 'chat:qq' : 'web', speaker: '同行者', role: 'partner',
        text: `日常压测流水第 ${i} 条记录：散步听雨、检查系统状态与整理琐碎日常。`, provenance: 'verified',
      };
      jLines.push(JSON.stringify(j));

      const isTarget = i === targetIdx;
      const ep: MemoryEpisode = {
        id: `ep_bench_${i}`, seq: i, timestamp: ts, bodyType: i % 2 === 0 ? 'web' : 'chat:qq', bodyId: 'bench',
        title: isTarget ? '星海天文台约定' : `日常片段 #${i}`,
        summary: isTarget
          ? '我们约好晴朗夜晚一起去星海天文台看流星雨并带热可可。'
          : `常规日常记录第 ${i} 幕，记录了平时聊过的普通天气与琐事。`,
        participants: ['同行者'], importance: isTarget ? 95 : 42, provenance: 'verified',
        tags: isTarget ? ['约定'] : ['日常'], valence: isTarget ? 0.85 : 0.1, arousal: isTarget ? 0.8 : 0.2,
        userPinned: isTarget ? true : undefined,
      };
      eLines.push(JSON.stringify(ep));
    }

    fs.writeFileSync(p.journal, `${jLines.join('\n')}\n`, 'utf8');
    fs.writeFileSync(p.episodesJsonl, `${eLines.join('\n')}\n`, 'utf8');
    const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as SoulMeta;
    meta.nextSeq = count + 1;
    writeJsonAtomic(p.meta, meta);

    const journalBytes = fs.statSync(p.journal).size;
    const episodesBytes = fs.statSync(p.episodesJsonl).size;

    const t0 = performance.now();
    const tail = readJsonlSafe<JournalEntry>(p.journal, 40);
    const tailJournal40Ms = roundMs(performance.now() - t0);

    const t1 = performance.now();
    const full = readJsonlSafe<MemoryEpisode>(p.episodesJsonl, 0);
    const fullEpisodesScanMs = roundMs(performance.now() - t1);

    const t2 = performance.now();
    loadSoulArchive(dir, 40);
    const loadArchiveMs = roundMs(performance.now() - t2);

    const tIdx = performance.now();
    ensureMemoryIndex(dir, { verifyHash: true });
    const indexBuild10kMs = roundMs(performance.now() - tIdx);

    const t3 = performance.now();
    const hits = await recallMemories(dir, '星海天文台约定', { topK: 6, reinforce: false });
    const recall10kMs = roundMs(performance.now() - t3);

    const tCtx = performance.now();
    await buildRecallContext({ archiveDir: dir, query: '星海天文台约定', bodyId: 'web-1', bodyType: 'web', reinforce: true });
    const buildRecallContext10kMs = roundMs(performance.now() - tCtx);

    const t4 = performance.now();
    createSnapshot(dir, { label: 'bench-10k' });
    const snapshot10kMs = roundMs(performance.now() - t4);

    const t5 = performance.now();
    exportSoulArchive(dir, { redact: true });
    const exportRedacted10kMs = roundMs(performance.now() - t5);

    return {
      count, journalBytes, episodesBytes,
      tailJournal40Ms, fullEpisodesScanMs, loadArchiveMs, indexBuild10kMs, recall10kMs, buildRecallContext10kMs, snapshot10kMs, exportRedacted10kMs,
      tailCount: tail.length, tailLastSeq: tail[tail.length - 1]?.seq ?? 0,
      fullCount: full.length, topRecalledTitle: hits[0]?.title || '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runJsonl10kBenchmark(10_000).then((r) => {
    console.log(`=== 万级 JSONL 扫盘性能基线 (${r.count} 条 journal + ${r.count} 条 episodes) ===`);
    console.log(`- 文件体积: journal ${(r.journalBytes / 1024 / 1024).toFixed(2)} MB | episodes ${(r.episodesBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- 尾部40条读取 (tailRead): ${r.tailJournal40Ms} ms (返回 ${r.tailCount} 条, 末seq=${r.tailLastSeq})`);
    console.log(`- 万条情景全量扫盘 (fullScan): ${r.fullEpisodesScanMs} ms (返回 ${r.fullCount} 条)`);
    console.log(`- 完整档案加载 (loadSoulArchive): ${r.loadArchiveMs} ms`);
    console.log(`- 万条记忆建库耗时 (SQLite FTS5): ${r.indexBuild10kMs} ms`);
    console.log(`- 万条情景 FTS5 混合召回 (recallMemories): ${r.recall10kMs} ms (Top1: ${r.topRecalledTitle})`);
    console.log(`- 万条整轮上下文构建+巩固 (buildRecallContext): ${r.buildRecallContext10kMs} ms`);
    console.log(`- 万级档案打快照 (createSnapshot): ${r.snapshot10kMs} ms`);
    console.log(`- 万级档案脱敏导出 (exportSoulArchive): ${r.exportRedacted10kMs} ms`);
  });
}
