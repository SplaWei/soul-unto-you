import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { buildDreamConsolidationPrompt } from '../src/memory/dream-parser.ts';
import { runDreamConsolidation } from '../src/memory/dream.ts';
import {
  applyFactOperations, formatActiveFactsPromptSection, listActiveFacts, listFacts, parseDreamFactOps,
} from '../src/memory/facts.ts';
import { appendJournal, initSoulArchive, readMetaOrRecover } from '../src/soul/archive.ts';
import type { MemoryFact } from '../src/soul/types.ts';
import { createTestIdentity, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

async function startOmittedFactsLlmServer() {
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              episodes: [{ title: '闲聊记录', summary: '聊到日常琐事', bodyType: 'web' }],
              commitments: [],
              completedCommitments: [],
              relations: [],
            }),
          },
        }],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

test('P0-1 离线做梦阻断电影/朋友第三方句，且离线正则产出 provenance 标记为 inferred', async () => {
  await withSandboxArchive('soul-p0-thirdparty-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    applyFactOperations(dir, [
      { action: 'ADD', category: 'residence', fact: '同行者住在成都', provenance: 'verified' },
      { action: 'ADD', category: 'drink_preference', fact: '同行者爱喝美式', provenance: 'verified' },
    ]);
    appendJournal(dir, {
      bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner',
      text: '昨天看电影里男主搬去上海了，我朋友也爱喝可乐', provenance: 'verified',
    });
    const rep = await runDreamConsolidation(dir);
    assert.equal(rep.factsAdded + rep.factsUpdated + rep.factsDeleted, 0);
    const active = listActiveFacts(dir);
    assert.equal(active.length, 2);
    assert.equal(active.some((f) => f.fact === '同行者住在成都'), true);
    assert.equal(active.some((f) => f.fact === '同行者爱喝美式'), true);
    assert.equal(listFacts(dir).some((f) => f.fact.includes('上海') || f.fact.includes('可乐')), false);

    appendJournal(dir, {
      bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner',
      text: '我换工作做摄影师了', provenance: 'verified',
    });
    await runDreamConsolidation(dir);
    const workFact = listActiveFacts(dir).find((f) => f.category === 'work');
    assert.ok(workFact);
    assert.equal(workFact.provenance, 'inferred');
  });
});

test('P0-2 自然搬家否定句“我搬去成都了，已经不住在上海了”后 active 住址仅留成都', async () => {
  await withSandboxArchive('soul-p0-neg1-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    applyFactOperations(dir, [{ action: 'ADD', category: 'residence', fact: '同行者住在上海', provenance: 'verified' }]);
    appendJournal(dir, {
      bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner',
      text: '我搬去成都了，已经不住在上海了', provenance: 'verified',
    });
    await runDreamConsolidation(dir);
    const activeRes = listActiveFacts(dir).filter((f) => f.category === 'residence');
    assert.equal(activeRes.length, 1);
    assert.equal(activeRes[0]?.fact, '同行者住在成都');
  });
});

test('P0-3 自然搬家否定句“我搬去成都了，不再住在上海”后 active 住址仍是成都且不复活上海', async () => {
  await withSandboxArchive('soul-p0-neg2-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    appendJournal(dir, {
      bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner',
      text: '我搬去成都了，不再住在上海', provenance: 'verified',
    });
    await runDreamConsolidation(dir);
    const activeRes = listActiveFacts(dir).filter((f) => f.category === 'residence');
    assert.equal(activeRes.length, 1);
    assert.equal(activeRes[0]?.fact, '同行者住在成都');
    assert.equal(listActiveFacts(dir).some((f) => f.fact.includes('上海')), false);
  });
});

test('P0-4 真实 LLM 响应漏写 facts 字段时绝不回退正则提取器，并丢弃仅带 category 的 DELETE', async () => {
  const dropped = parseDreamFactOps([
    { action: 'DELETE', category: 'residence' },
    { action: 'DELETE', targetId: 'fact_1', category: 'residence' },
    { action: 'DELETE', fact: '同行者住在上海', category: 'residence' },
  ]);
  assert.equal(dropped?.length, 2);

  await withSandboxArchive('soul-p0-order-', ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    const rep = applyFactOperations(dir, [
      { action: 'ADD', category: 'residence', fact: '同行者住在成都' },
      { action: 'DELETE', category: 'residence', fact: '同行者住在成都' },
    ]);
    assert.equal(rep.added, 1);
    assert.equal(rep.deleted, 0);
    assert.equal(listActiveFacts(dir)[0]?.fact, '同行者住在成都');
  });

  const srv = await startOmittedFactsLlmServer();
  try {
    await withTestHub({ prefix: 'soul-p0-omit-facts-', llmBaseUrl: `${srv.origin}/v1` }, async ({ hub, dir }) => {
      await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken },
        body: JSON.stringify({ bodyId: 'w1', bodyType: 'web', text: '我住在上海浦东，爱喝冰美式' }),
      });
      const dream = await runDreamConsolidation(dir, { llm: hub.ctx.llm, lock: hub.ctx.presence });
      assert.equal(dream.factsAdded + dream.factsUpdated + dream.factsDeleted, 0);
      assert.equal(listFacts(dir).length, 0);
    });
  } finally {
    await srv.close();
  }
});

test('P2-1/2/3/4 超长梦境截断游标、validFrom 透传、缺字段容错与评测失败退出码', async () => {
  const ops = parseDreamFactOps([
    { action: 'ADD', category: 'residence', fact: '同行者住在成都', validFrom: '2025-05-01T10:00:00.000Z' },
    { action: 'ADD', category: 'work', fact: '同行者是设计师', validFrom: 'not-a-date' },
  ]);
  assert.equal(ops?.[0]?.validFrom, '2025-05-01T10:00:00.000Z');
  assert.equal(ops?.[1]?.validFrom, undefined);

  const malformed = [
    { id: 'f1', seq: 1, fact: '同行者住在成都', status: 'active', superseded_by: null, provenance: 'verified', updated_at: '' } as unknown as MemoryFact,
    { id: 'f2', seq: 2, status: 'active', superseded_by: null, provenance: 'verified', updated_at: '', valid_from: '2025-01-01' } as unknown as MemoryFact,
  ];
  const sec = formatActiveFactsPromptSection(malformed);
  assert.ok(sec.includes('同行者住在成都 (valid_from: 未知)'));
  assert.equal(sec.includes('f2'), false);

  const srv = await startOmittedFactsLlmServer();
  try {
    await withTestHub({ prefix: 'soul-p2-trunc-', llmBaseUrl: `${srv.origin}/v1` }, async ({ hub, dir }) => {
      const longText = '今天散步聊了很久的日常风景。'.repeat(650);
      const j1 = appendJournal(dir, { bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner', text: longText, provenance: 'verified' });
      const j2 = appendJournal(dir, { bodyId: 'w1', bodyType: 'web', speaker: '同行者', role: 'partner', text: longText, provenance: 'verified' });
      const built = buildDreamConsolidationPrompt(readMetaOrRecover(dir), [j1, j2], []);
      assert.equal(built.includedCount, 1);
      assert.equal(built.lastIncludedSeq, j1.seq);

      const d1 = await runDreamConsolidation(dir, { llm: hub.ctx.llm, lock: hub.ctx.presence });
      assert.equal(d1.processedEntries, 2);
      assert.equal(d1.lastDreamSeq, j1.seq);
      const d2 = await runDreamConsolidation(dir, { llm: hub.ctx.llm, lock: hub.ctx.presence });
      assert.equal(d2.processedEntries, 1);
      assert.equal(d2.lastDreamSeq, j2.seq);
    });
  } finally {
    await srv.close();
  }

  const cli = spawnSync(process.execPath, ['scripts/eval-real-llm.ts', '--no-save'], { encoding: 'utf8' });
  assert.equal(cli.status, 1, '存在 FAIL 检查点时 CLI 必须返回非零退出码');
});
