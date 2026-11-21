import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LlmRouter } from '../src/llm/router.ts';
import { runDreamConsolidation } from '../src/memory/dream.ts';
import { AutoDreamScheduler } from '../src/memory/dream-scheduler.ts';
import { buildRecallContext, cosineSimilarity, lexicalSimilarity, recallMemories, syncVectorIndex, type EmbeddingConfig } from '../src/memory/search.ts';
import { PresenceManager } from '../src/presence/manager.ts';
import { appendJournal, initSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('跨躯体不失忆闭环：昨晚环世界修墙约定 -> 做梦整理 -> 今早 QQ 仅说早安仍清晰记得', async () => {
  const dir = makeTempDir('soul-dream-');
  try {
    const identity: SoulIdentity = {
      id: 'cross-body-demo',
      name: '柳遥',
      partnerName: '同行者',
      persona: '你是跨躯体陪伴灵魂柳遥，记忆永远连通。',
      catchphrases: ['呀~'],
      coreValues: ['守约'],
      anchors: ['在环世界一起造殖民地'],
    };
    initSoulArchive(dir, identity);
    awakenSoul(dir, { bodyId: 'rimworld-1', bodyType: 'rimworld' });

    const presence = new PresenceManager(dir);
    appendJournal(dir, {
      bodyId: 'rimworld-colony-1',
      bodyType: 'rimworld',
      speaker: '同行者',
      role: 'partner',
      text: '今晚我们在环世界1.7一起修西侧花岗岩防线，目前还缺钢材没修完，约定明晚继续把没盖好的建筑盖好！',
      provenance: 'verified',
    });
    appendJournal(dir, {
      bodyId: 'rimworld-colony-1',
      bodyType: 'rimworld',
      speaker: '柳遥',
      role: 'soul',
      text: '好呀，我先记下西侧围墙和钢材缺口，明天晚上我们接着盖完！',
      provenance: 'verified',
    });
    presence.recordActivity({
      bodyId: 'rimworld-colony-1',
      bodyType: 'rimworld',
      activity: '与同行者修建西侧防线（缺钢材暂停）',
      mood: '干劲满满',
    });

    const dream = await runDreamConsolidation(dir);
    assert.equal(dream.ok, true);
    assert.ok(dream.episodesAdded >= 1);
    assert.ok(dream.commitmentsAdded >= 1);

    // 第二天早上切到 QQ 躯体，仅说一句极简「早安」
    const recalled = await buildRecallContext({
      archiveDir: dir,
      query: '早安',
      bodyId: 'qq-morning',
      bodyType: 'qq',
      presence: presence.getState(),
    });

    assert.ok(recalled.activeCommitments.length >= 1, '未完成约定必须常驻注入');
    assert.ok(recalled.systemPrompt.includes('西侧花岗岩防线'), 'QQ 上下文必须清晰带出昨晚环世界未修完的防线');
    assert.ok(recalled.systemPrompt.includes('rimworld'), '必须保留跨端来源标记');

    const router = new LlmRouter({ chat: { driver: 'mock', model: 'soul-offline-mock' } });
    const res = await router.chat({
      systemPrompt: recalled.systemPrompt,
      userText: '早安',
      speaker: '同行者',
      bodyType: 'qq',
      soulName: '柳遥',
      catchphrase: '呀~',
    });
    assert.ok(res.reply.includes('钢材') || res.reply.includes('防线'), `Mock 大脑早安回复应带出昨晚未完约定，实际为: ${res.reply}`);

    assert.ok(lexicalSimilarity('西侧防线钢材', '今晚在环世界修西侧防线缺钢材') > 0.5);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-6);

    // 验证统一连续时间线：较早 QQ 对话之后新增 MC 记录，最新 MC 记录必须排在最底端
    appendJournal(dir, { bodyId: 'qq-morning', bodyType: 'chat:qq', speaker: '同行者', role: 'partner', text: '早安呀', provenance: 'verified' });
    appendJournal(dir, { bodyId: 'mc-live', bodyType: 'game:minecraft', speaker: '同行者', role: 'partner', text: '刚进 MC 发现钻石矿了', provenance: 'verified' });
    const liveRecall = await buildRecallContext({ archiveDir: dir, query: '现在怎么样', bodyId: 'qq-morning', bodyType: 'chat:qq' });
    const qqIdx = liveRecall.systemPrompt.lastIndexOf('早安呀');
    const mcIdx = liveRecall.systemPrompt.lastIndexOf('刚进 MC 发现钻石矿了');
    assert.ok(liveRecall.systemPrompt.includes('刚刚发生的连续时间线'));
    assert.ok(mcIdx > qqIdx && qqIdx > 0, '最新跨躯体消息必须位于连续时间线最底部');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AutoDreamScheduler 闲置自动做梦整理 + 本地向量嵌入检索闭环', async () => {
  const dir = makeTempDir('soul-autodream-');
  const vecServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] };
      const data = (body.input || []).map((txt, index) => {
        const hasCamp = /木屋|营地|矿/.test(txt);
        return { index, embedding: hasCamp ? [0.95, 0.1, 0] : [0.1, 0.95, 0] };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => vecServer.listen(0, '127.0.0.1', resolve));
  const addr = vecServer.address();
  const vecPort = typeof addr === 'object' && addr ? addr.port : 0;
  const embCfg: EmbeddingConfig = {
    enabled: true,
    endpoint: `http://127.0.0.1:${vecPort}/v1`,
    model: 'qwen3-embedding:0.6b',
  };

  try {
    initSoulArchive(dir, {
      id: 'auto-dream-demo',
      name: '柳遥',
      partnerName: '同行者',
      persona: '记忆整理测试',
      catchphrases: ['呀~'],
      coreValues: ['诚实'],
      anchors: ['守望星空'],
    });
    awakenSoul(dir, { bodyId: 'mc-1', bodyType: 'game:minecraft' });

    const scheduler = new AutoDreamScheduler({
      config: { enabled: true, idleMinutes: 1, minPendingEntries: 2, checkIntervalSec: 60 },
      getArchiveDir: () => dir,
      runDream: () => runDreamConsolidation(dir, { embedding: embCfg }),
    });

    const t0 = 1_700_000_000_000;
    scheduler.markActivity(t0);
    // 刚唤醒有 1 条记录，未达 minPendingEntries=2
    const skipLow = await scheduler.tick(t0 + 120_000);
    assert.equal(skipLow.triggered, false);
    assert.equal(skipLow.reason, 'insufficient-pending');

    appendJournal(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      speaker: '同行者',
      role: 'partner',
      text: '今晚先搭好木屋营地，明天记得一起去挖矿！',
      provenance: 'verified',
    });
    scheduler.markActivity(t0 + 1000);

    // 未达到闲置阈值
    const skipBusy = await scheduler.tick(t0 + 10_000);
    assert.equal(skipBusy.triggered, false);
    assert.equal(skipBusy.reason, 'not-idle');

    // 达到闲置时长后自动触发
    const ran = await scheduler.tick(t0 + 62_000);
    assert.equal(ran.triggered, true);
    assert.equal(ran.reason, 'completed');
    assert.ok((ran.result?.episodesAdded ?? 0) >= 1);
    assert.ok((ran.result?.vectorsIndexed ?? 0) >= 1);
    assert.equal(scheduler.getStatus(t0 + 62_000).pendingEntries, 0);

    // 验证本地向量文件与混合检索
    assert.ok(fs.existsSync(resolveArchivePaths(dir).vectors));
    assert.equal(await syncVectorIndex(dir, embCfg), 0);
    const hits = await recallMemories(dir, '木屋营地', { embedding: embCfg });
    assert.ok(hits.some((h) => h.text.includes('木屋') || h.title.includes('木屋')));

    scheduler.start();
    scheduler.stop();
  } finally {
    await new Promise<void>((resolve) => vecServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
