import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runJsonl10kBenchmark } from '../scripts/bench-jsonl-10k.ts';
import { recordExperience } from '../src/memory/experience.ts';
import {
  BUILTIN_HYBRID_RETRIEVER,
  buildRecallContext,
  ensureMemoryIndex,
  getMemoryIndexStatus,
  recallMemories,
  rebuildMemoryIndex,
  searchMemoryIndex,
} from '../src/memory/search.ts';
import { syncMemoryIndexFile } from '../src/memory/sqlite-index.ts';
import { addCoBecoming, addEpisode } from '../src/memory/store.ts';
import { REPO_ROOT } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { appendJournal, initSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { recordSelfEvolution, upsertTemporalBelief } from '../src/soul/living-self.ts';
import { createSnapshot, rollbackToSnapshot } from '../src/soul/snapshot.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

const TEST_IDENTITY: SoulIdentity = {
  id: 'soul-a3-test',
  name: '柳遥',
  partnerName: '同行者',
  persona: '纯文本真相源与 SQLite FTS5 派生索引测试灵魂。',
  catchphrases: ['呀~'],
  coreValues: ['诚实溯源'],
  anchors: ['醒来第一声我爱你'],
};

function makeSandbox(prefix: string): { dir: string; cfgPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initSoulArchive(dir, TEST_IDENTITY);
  awakenSoul(dir, { bodyId: 'test-init', bodyType: 'web' });
  return { dir, cfgPath: path.join(dir, 'hub.test.json') };
}

test('A3-1 纯文本先行落盘、六类 JSONL 字段同步与 .gitignore 校验', () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\.cache\/$/m.test(gitignore), '.gitignore 必须忽略 .cache/');

  const { dir } = makeSandbox('soul-a3-sync-');
  const p = resolveArchivePaths(dir);
  try {
    const j = appendJournal(dir, {
      bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '小夏', role: 'partner',
      text: '今天在植物园看到一株罕见的蓝雪花。', provenance: 'verified',
    });
    const ep = addEpisode(dir, {
      bodyType: 'chat:qq', bodyId: 'qq-1', title: '植物园散步',
      summary: '在温室里看到蓝雪花并拍了照片。', participants: ['小夏', '柳遥'], importance: 82,
    });
    const exp = recordExperience(dir, {
      bodyId: 'web-1', bodyType: 'web', origin: 'lived',
      stimulus: '整理照片分类', realityOutcome: '顺利完成归档', valence: 0.6, lesson: '按地点分类最快',
    });
    upsertTemporalBelief(dir, { topic: '作息偏好', statement: '喜欢早睡早起', confidence: 0.7 });
    const latestBelief = upsertTemporalBelief(dir, { topic: '作息偏好', statement: '夜猫子更专注', confidence: 0.9 });
    const cb = addCoBecoming(dir, {
      soulShift: '学会温柔记住细节', partnerShift: '更愿意分享日常', reflection: '陪伴变深',
    });
    const evo = recordSelfEvolution(dir, {
      trigger: 'practice', previousTrait: '随性记事', evolvedTrait: '细致归档', reason: '日常实践养成',
    });

    assert.ok(fs.readFileSync(p.journal, 'utf8').includes(j.text));
    assert.ok(fs.readFileSync(p.episodesJsonl, 'utf8').includes(ep.id));
    assert.ok(fs.readFileSync(p.experiences, 'utf8').includes(exp.id));
    assert.ok(fs.readFileSync(p.beliefs, 'utf8').includes(latestBelief.id));
    assert.ok(fs.readFileSync(p.coBecoming, 'utf8').includes(cb.soulShift));
    assert.ok(fs.readFileSync(p.selfEvolution, 'utf8').includes(evo.id));
    assert.equal(fs.existsSync(p.memoryIndexDb), true);

    const db = new DatabaseSync(p.memoryIndexDb);
    try {
      const jRow = db.prepare('SELECT seq, speaker, body_type, status FROM memory_docs WHERE doc_id = ?').get(`journal:${j.seq}`) as {
        seq: number; speaker: string; body_type: string; status: string;
      };
      assert.equal(jRow.seq, j.seq);
      assert.equal(jRow.speaker, '小夏');
      assert.equal(jRow.body_type, 'chat:qq');
      assert.equal(jRow.status, 'active');

      const beliefs = db.prepare("SELECT status, title FROM memory_docs WHERE kind = 'belief' AND title = '作息偏好' ORDER BY seq ASC").all() as Array<{
        status: string; title: string;
      }>;
      assert.equal(beliefs.length, 2);
      assert.equal(beliefs[0].status, 'superseded');
      assert.equal(beliefs[1].status, 'active');
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-2 主人验收闭环：记住橘猫土豆 -> 顶出近期窗口 -> 删库重启自动重建并单字召回', async () => {
  const { dir, cfgPath } = makeSandbox('soul-a3-cat-');
  const p = resolveArchivePaths(dir);
  const token = 'tok-a3-cat';
  const hub1 = await createSoulHubServer({ archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token });
  const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };

  try {
    const firstTurn = await fetch(`${hub1.baseUrl}/api/body/percept`, {
      method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '我养了一只叫土豆的橘猫' }),
    });
    assert.equal(firstTurn.status, 200);

    for (let i = 1; i <= 10; i += 1) {
      await fetch(`${hub1.baseUrl}/api/body/percept`, {
        method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: `今天第 ${i} 次聊起日常天气和晚饭菜单。` }),
      });
    }
  } finally {
    await hub1.close();
  }

  assert.equal(fs.existsSync(p.memoryIndexDb), true);
  fs.rmSync(p.memoryIndexDb, { force: true });
  assert.equal(fs.existsSync(p.memoryIndexDb), false, '测试前提：必须先删掉 .cache/memory-index.sqlite');

  const hub2 = await createSoulHubServer({ archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token });
  try {
    assert.equal(fs.existsSync(p.memoryIndexDb), true, '重启后必须静默自动重建 .cache/memory-index.sqlite');
    const askRes = await fetch(`${hub2.baseUrl}/api/body/percept`, {
      method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '我的猫叫什么？' }),
    });
    assert.equal(askRes.status, 200);
    const askJson = (await askRes.json()) as { ok: boolean; reply: string; recalled: Array<{ text: string }> };
    assert.equal(askJson.ok, true);
    assert.ok(askJson.recalled.some((r) => r.text.includes('土豆') && r.text.includes('橘猫')), '必须召回橘猫土豆记录');
    assert.ok(askJson.reply.includes('土豆') || askJson.reply.includes('橘猫'), `真实回复必须包含土豆或橘猫，实际=${askJson.reply}`);

    const sysPrompt = hub2.ctx.lastPrompt?.systemPrompt || '';
    assert.ok(sysPrompt.includes('按当前对话唤醒的相关片段'), '应从全量历史碎片中唤醒而非依赖最近14条时间线');
    assert.ok(sysPrompt.includes('土豆') && sysPrompt.includes('橘猫'));
  } finally {
    await hub2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-3 损坏缓存静默重建 & 外部修改纯文本等长篡改 SHA-256 校验恢复', async () => {
  const { dir } = makeSandbox('soul-a3-corrupt-');
  const p = resolveArchivePaths(dir);
  try {
    addEpisode(dir, {
      bodyType: 'web', bodyId: 'web-1', title: '星海天文台约定',
      summary: '说好晴朗夜晚一起去观星并带上热可可。', importance: 88,
    });

    fs.mkdirSync(p.cache, { recursive: true });
    fs.writeFileSync(p.memoryIndexDb, 'CORRUPT_SQLITE_BYTES_!@#$%^&*', 'utf8');
    const rep = ensureMemoryIndex(dir, { verifyHash: true });
    assert.equal(rep.ok, true);
    assert.equal(rep.rebuilt, true);

    const hits = await recallMemories(dir, '星海天文台约定', { reinforce: false });
    assert.equal(hits[0]?.title, '星海天文台约定');

    const statBefore = fs.statSync(p.episodesJsonl);
    const rawBefore = fs.readFileSync(p.episodesJsonl, 'utf8');
    const rawReplaced = rawBefore.replace('星海天文台约定', '月球环形山基地');
    assert.equal(Buffer.byteLength(rawReplaced, 'utf8'), Buffer.byteLength(rawBefore, 'utf8'), '构造等长纯文本修改');
    fs.writeFileSync(p.episodesJsonl, rawReplaced, 'utf8');
    fs.utimesSync(p.episodesJsonl, statBefore.atime, statBefore.mtime);

    const syncRep = ensureMemoryIndex(dir, { verifyHash: true });
    assert.ok(syncRep.syncedFiles.includes('episodes.jsonl'), '启动哈希校验必须识别等长/同时间戳纯文本变化');
    const updatedHits = await recallMemories(dir, '月球环形山基地', { reinforce: false });
    assert.equal(updatedHits[0]?.title, '月球环形山基地');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-4 快照回滚清缓存防幽灵记忆 & FTS5 特殊字符/注入防护', async () => {
  const { dir } = makeSandbox('soul-a3-rb-');
  const p = resolveArchivePaths(dir);
  try {
    addEpisode(dir, { bodyType: 'web', bodyId: 'web-1', title: '初版记忆', summary: '回滚后仍应保留的记忆。' });
    const snap = createSnapshot(dir, { label: 'before-extra' });

    addEpisode(dir, { bodyType: 'web', bodyId: 'web-1', title: '幽灵实验片段', summary: '这是回滚后必须彻底消失的记忆。' });
    assert.equal((await recallMemories(dir, '幽灵实验片段', { reinforce: false }))[0]?.title, '幽灵实验片段');

    rollbackToSnapshot(dir, snap.id);
    assert.equal(fs.existsSync(p.memoryIndexDb), false, '快照回滚后必须清除过期 SQLite 缓存');

    const afterRb = await buildRecallContext({ archiveDir: dir, query: '幽灵实验片段', bodyId: 'web-1', bodyType: 'web', reinforce: false });
    assert.equal(afterRb.recalled.some((r) => r.title.includes('幽灵实验片段')), false);
    assert.equal(fs.existsSync(p.memoryIndexDb), true);

    for (const q of ['', '???', 'OR NOT * () : " \' ; DROP TABLE memory_docs;']) {
      const idxRes = searchMemoryIndex(dir, q);
      assert.ok(Array.isArray(idxRes.hits));
      const rec = await recallMemories(dir, q, { reinforce: false });
      assert.ok(Array.isArray(rec));
    }
    const db = new DatabaseSync(p.memoryIndexDb);
    try {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM memory_docs').get() as { cnt: number };
      assert.ok(row.cnt >= 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-5 万级记忆 FTS5 检索耗时 < 50ms 与整轮 buildRecallContext 真实耗时验证', async () => {
  const bench = await runJsonl10kBenchmark(10_000);
  assert.equal(bench.fullCount, 10_000);
  assert.equal(bench.topRecalledTitle, '星海天文台约定');
  assert.ok(bench.recall10kMs < 50, `万级 FTS5 检索目标 <50ms，实测 ${bench.recall10kMs}ms`);
  assert.ok(bench.buildRecallContext10kMs < 250, `万级整轮 buildRecallContext(reinforce:true) 实测应 <250ms，实际 ${bench.buildRecallContext10kMs}ms`);
});

test('A3-6 坏行可见报告（纯文本不变）与 rebuild 失败零 .tmp 残留校验', async () => {
  const { dir } = makeSandbox('soul-a3-badline-');
  const p = resolveArchivePaths(dir);
  try {
    addEpisode(dir, { bodyType: 'web', bodyId: 'web-1', title: '正常记忆', summary: '完整 JSON 行。' });
    fs.appendFileSync(p.episodesJsonl, '{broken-json-line\n', 'utf8');
    const rawBytesBefore = fs.readFileSync(p.episodesJsonl, 'utf8');

    const rep = rebuildMemoryIndex(dir);
    assert.equal(rep.skippedCount, 1);
    assert.equal(rep.skippedLines[0]?.sourceFile, 'episodes.jsonl');
    assert.equal(rep.skippedLines[0]?.lineNumber, 2);
    assert.equal(fs.readFileSync(p.episodesJsonl, 'utf8'), rawBytesBefore, '重建绝不能改写纯文本');

    const status = getMemoryIndexStatus(dir);
    assert.equal(status.skippedCount, 1);
    const health = await BUILTIN_HYBRID_RETRIEVER.health(dir);
    assert.ok(health.detail?.includes('跳过 1 行') && health.detail?.includes('episodes.jsonl:2'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const { dir: dirFail } = makeSandbox('soul-a3-failtmp-');
  const pFail = resolveArchivePaths(dirFail);
  try {
    fs.rmSync(pFail.episodesJsonl, { force: true });
    fs.mkdirSync(pFail.episodesJsonl);
    assert.throws(() => rebuildMemoryIndex(dirFail));
    const leftTmp = fs.existsSync(pFail.cache)
      ? fs.readdirSync(pFail.cache).filter((n) => n.startsWith('.memory-index.tmp-'))
      : [];
    assert.deepEqual(leftTmp, [], 'rebuild 失败后 .cache 不得残留 .memory-index.tmp-* 文件');
  } finally {
    fs.rmSync(dirFail, { recursive: true, force: true });
  }
});

test('A3-7 旧版 Schema v1 缓存缺列（无 skipped_count）升级自动静默重建不崩溃', async () => {
  const { dir } = makeSandbox('soul-a3-legacy-');
  const p = resolveArchivePaths(dir);
  const writeLegacyV1Db = (dbPath: string) => {
    for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${dbPath}${s}`, { force: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE index_meta (source_file TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, file_size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, line_count INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE memory_docs (doc_id TEXT PRIMARY KEY, source_file TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, timestamp TEXT NOT NULL, body_type TEXT NOT NULL, body_id TEXT NOT NULL, speaker TEXT NOT NULL, role TEXT NOT NULL, provenance TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, meta_json TEXT NOT NULL);
        CREATE VIRTUAL TABLE memory_fts USING fts5(doc_id UNINDEXED, bigrams, unigrams, tokenize='unicode61');
        INSERT INTO index_meta VALUES ('episodes.jsonl', 1, 10, 10, 1, 'old', '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      db.close();
    }
  };
  try {
    addEpisode(dir, { bodyType: 'web', bodyId: 'web-1', title: '旧版升级记忆', summary: '确保旧缓存升级不崩溃且可召回蓝雪花。' });
    appendJournal(dir, { bodyId: 'web-1', bodyType: 'web', speaker: '同行者', role: 'partner', text: '测试旧版缓存升级', provenance: 'verified' });

    writeLegacyV1Db(p.memoryIndexDb);
    const rep = ensureMemoryIndex(dir, { verifyHash: true });
    assert.equal(rep.ok, true);
    assert.equal(rep.rebuilt, true);
    assert.ok(getMemoryIndexStatus(dir).docCount >= 2);
    assert.equal((await recallMemories(dir, '蓝雪花', { reinforce: false }))[0]?.title, '旧版升级记忆');

    writeLegacyV1Db(p.memoryIndexDb);
    assert.doesNotThrow(() => syncMemoryIndexFile(dir, 'episodes.jsonl'));
    assert.equal((await recallMemories(dir, '旧版升级记忆', { reinforce: false }))[0]?.title, '旧版升级记忆');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
