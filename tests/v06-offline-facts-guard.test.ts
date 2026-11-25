import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runDreamConsolidation } from '../src/memory/dream.ts';
import {
  applyFactOperations, listActiveFacts, listFacts, parseDreamFactOps,
} from '../src/memory/facts.ts';
import { appendJournal, initSoulArchive } from '../src/soul/archive.ts';
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
