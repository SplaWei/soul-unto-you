import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { runDreamConsolidation } from '../src/memory/dream.ts';
import {
  applyFactOperations, buildRecallContext, checkEmbeddingHealth, checkRerankHealth,
  createHttpMemoryRetriever, listActiveFacts, listFacts, recallMemories,
  rebuildMemoryIndex, rerankDocuments, syncVectorIndexDetailed,
  type EmbeddingConfig, type MemoryFact, type RerankConfig,
} from '../src/memory/search.ts';
import { addEpisode } from '../src/memory/store.ts';
import { initSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { authHeaders, createTestIdentity, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

async function startDualEngineTestServer(options: { rerankDelayMs?: number; lazySingleBatch?: boolean } = {}) {
  const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let chatCount = 0;
  const json = (res: http.ServerResponse, data: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
    calls.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body });

    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      const inputs = Array.isArray(body.input) ? body.input.map(String) : [];
      return json(res, {
        data: inputs.map((txt, index) => ({
          index,
          embedding: /高新区|成都|拿铁/.test(txt) ? [0.95, 0.05, 0, 0]
            : /浦东|上海|美式/.test(txt) ? [0.05, 0.95, 0, 0]
              : /猫|土豆/.test(txt) ? [0, 0, 0.95, 0.05] : [0.1, 0.1, 0.1, 0.9],
        })),
      });
    }
    if (req.url === '/v1/rerank' && req.method === 'POST') {
      if (options.rerankDelayMs) await new Promise((r) => setTimeout(r, options.rerankDelayMs));
      const docs = Array.isArray(body.documents) ? body.documents.map(String) : [];
      const query = String(body.query || '');
      return json(res, {
        results: docs.map((doc, index) => ({
          index,
          relevance_score: (/拿铁|高新区|成都/.test(query) && /拿铁|高新区|成都/.test(doc)) ? 0.92
            : (/猫|宠物/.test(query) && /猫|土豆/.test(doc)) ? 0.88 : 0.08,
        })),
      });
    }
    if (req.url === '/api/v1/services/rerank/text-rerank/text-rerank' && req.method === 'POST') {
      const docs = Array.isArray((body.input as { documents?: string[] } | undefined)?.documents)
        ? ((body.input as { documents: string[] }).documents).map(String) : [];
      return json(res, { output: { results: docs.map((d, index) => ({ index, relevance_score: /拿铁/.test(d) ? 0.95 : 0.12 })) } });
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      chatCount += 1;
      const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: string }>) : [];
      const sys = String(msgs.find((m) => m.role === 'system')?.content || '');
      const user = String(msgs[msgs.length - 1]?.content || '');
      if (sys.includes('记忆整理器') || user.includes('梦境记忆整理器')) {
        if (options.lazySingleBatch) {
          return json(res, {
            choices: [{ message: { content: JSON.stringify({
              episodes: [{ title: '搬家与饮品', summary: '近况整理', bodyType: 'web' }],
              commitments: [], completedCommitments: [], relations: [],
              facts: [
                { action: 'ADD', category: 'location', fact: '同行者居住在成都高新区' },
                { action: 'ADD', category: 'drink', fact: '同行者喜欢喝美式咖啡' },
                { action: 'ADD', category: 'other', fact: '同行者喜欢晴天的云' },
              ],
            }) } }],
          });
        }
        const oldAddr = user.match(/\[id:(fact_[a-z0-9-]+)\]\[residence\]/)?.[1];
        const oldDrink = user.match(/\[id:(fact_[a-z0-9-]+)\]\[drink_preference\]/)?.[1];
        const out = user.includes('搬去成都高新区')
          ? {
              episodes: [{ title: '搬去成都高新区并改喝拿铁', summary: '搬去成都高新区，改喝拿铁', bodyType: 'web' }],
              commitments: [], completedCommitments: [], relations: [],
              facts: [
                { action: 'UPDATE', ...(oldAddr ? { targetId: oldAddr } : {}), category: 'residence', fact: '同行者住在成都高新区' },
                { action: 'UPDATE', ...(oldDrink ? { targetId: oldDrink } : {}), category: 'drink_preference', fact: '同行者爱喝拿铁' },
              ],
            }
          : {
              episodes: [{ title: '上海浦东与美式咖啡', summary: '目前住上海浦东，爱喝美式', bodyType: 'web' }],
              commitments: [], completedCommitments: [], relations: [],
              facts: user.includes('上海浦东') && !user.includes('当前暂无已归档有效事实') && user.indexOf('当前已知有效长期事实') < user.indexOf('上海浦东')
                ? [
                    { action: 'ADD', category: 'residence', fact: '同行者住在上海浦东' },
                    { action: 'ADD', category: 'drink_preference', fact: '同行者爱喝美式' },
                  ]
                : [],
            };
        return json(res, { choices: [{ message: { content: JSON.stringify(out) } }] });
      }
      const factsBlock = sys.split('## 长期个人事实记忆')[1]?.split('\n## ')[0] || '';
      const reply = user.includes('住哪')
        ? (factsBlock.includes('成都高新区') && factsBlock.includes('拿铁') && !factsBlock.includes('上海浦东') && !factsBlock.includes('美式')
            ? '你现在住在成都高新区，平时最爱喝拿铁！' : '只记得零碎片段。')
        : `收到第 ${chatCount} 轮消息。`;
      return json(res, { choices: [{ message: { content: reply } }] });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

const postPercept = async (baseUrl: string, token: string, bodyId: string, text: string) =>
  (await fetch(`${baseUrl}/api/body/percept`, {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ bodyId, bodyType: 'web', text }),
  })).json();

const assertMoveFactsRows = (factsPath: string) => {
  const rows = fs.readFileSync(factsPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l) as MemoryFact);
  const oldRes = rows.find((r) => r.fact.includes('上海浦东'))!;
  const newRes = rows.find((r) => r.fact.includes('成都高新区'))!;
  const oldDrink = rows.find((r) => r.fact.includes('美式'))!;
  const newDrink = rows.find((r) => r.fact.includes('拿铁'))!;
  assert.equal(oldRes.status, 'superseded');
  assert.equal(oldRes.superseded_by, newRes.id);
  assert.equal(newRes.status, 'active');
  assert.equal(oldDrink.status, 'superseded');
  assert.equal(oldDrink.superseded_by, newDrink.id);
  assert.equal(newDrink.status, 'active');
  return rows;
};

test('A4-1 通用 Embedding(<=10分片) + 标准/DashScope Rerank 精排、TopK 阈值过滤与健康探针', async () => {
  const srv = await startDualEngineTestServer();
  try {
    await withSandboxArchive('soul-a4-rerank-', async ({ dir }) => {
      initSoulArchive(dir, createTestIdentity());
      awakenSoul(dir, { bodyId: 'web-1', bodyType: 'web' });
      for (let i = 1; i <= 12; i += 1) {
        addEpisode(dir, {
          bodyId: 'web-1', bodyType: 'web', title: i === 6 ? '咖啡店拿铁日记' : `日常天气杂记 #${i}`,
          summary: i === 6 ? '今天在成都高新区喝到一杯很香的拿铁。' : `普通日常记录 #${i}，只是随便走走。`,
          importance: i === 6 ? 60 : 95,
        });
      }
      const embCfg: EmbeddingConfig = { enabled: true, endpoint: `${srv.origin}/v1`, model: 'Qwen/Qwen3-Embedding-0.6B', apiKey: 'demo-emb-key-123456', dimensions: 4 };
      const rrCfg: RerankConfig = { enabled: true, endpoint: `${srv.origin}/v1`, model: 'Qwen/Qwen3-Reranker-0.6B', apiKey: 'demo-rerank-key-654321', topN: 2, minScore: 0.4 };
      const syncRep = await syncVectorIndexDetailed(dir, embCfg);
      assert.equal(syncRep.ok, true);
      assert.equal(syncRep.episodesIndexed, 12);
      const embBatches = srv.calls.filter((c) => c.url === '/v1/embeddings');
      assert.ok(embBatches.length >= 2 && embBatches.every((b) => Array.isArray(b.body.input) && b.body.input.length <= 10));
      assert.equal(embBatches[0].body.dimensions, 4);
      assert.equal(embBatches[0].auth, 'Bearer demo-emb-key-123456');

      const ctx = await buildRecallContext({
        archiveDir: dir, query: '成都高新区有什么爱喝的拿铁吗', bodyId: 'web-1', bodyType: 'web',
        embedding: embCfg, rerank: rrCfg, topK: 5, reinforce: false,
      });
      assert.equal(ctx.recallTrace.rerankActive, true);
      assert.equal(ctx.recallTrace.rerankModel, 'Qwen/Qwen3-Reranker-0.6B');
      assert.equal(ctx.recalled.length, 1);
      assert.equal(ctx.recalled[0]?.title, '咖啡店拿铁日记');
      assert.ok(ctx.recalled[0]?.recallChannels.includes('rerank'));

      const dsOut = await rerankDocuments('最近爱喝拿铁', ['今天喝了美式', '最近改喝拿铁了'], {
        enabled: true, endpoint: `${srv.origin}/api/v1/services/rerank/text-rerank/text-rerank`, model: 'qwen3-rerank', apiKey: 'demo-ds-key-999999',
      });
      assert.equal(dsOut.ok && dsOut.applied && dsOut.results[0]?.index === 1, true);
      assert.equal((await checkRerankHealth(rrCfg)).ok, true);
    });
  } finally {
    await srv.close();
  }
});

test('A4-2 云端未配 API Key 无缝回退离线 FTS5（零外发请求）与低相关噪音抑制', async () => {
  await withSandboxArchive('soul-a4-nokey-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    addEpisode(dir, { bodyId: 'web-1', bodyType: 'web', title: '蓝雪花盆栽养护', summary: '阳台那盆蓝雪花每周需要浇水两次。', importance: 98, userPinned: true });
    const noKeyEmb: EmbeddingConfig = { enabled: true, endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Embedding-0.6B', apiKey: '' };
    const noKeyRr: RerankConfig = { enabled: true, endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Reranker-0.6B', apiKey: '' };
    assert.equal((await checkEmbeddingHealth(noKeyEmb)).fallbackReason, 'missing_api_key');
    assert.equal((await checkRerankHealth(noKeyRr)).fallbackReason, 'missing_api_key');

    const ctxHit = await buildRecallContext({ archiveDir: dir, query: '阳台蓝雪花怎么浇水', bodyId: 'web-1', bodyType: 'web', embedding: noKeyEmb, rerank: noKeyRr, reinforce: false });
    assert.equal(ctxHit.recallTrace.embeddingActive, false);
    assert.equal(ctxHit.recallTrace.rerankActive, false);
    assert.equal(ctxHit.recallTrace.rerankFallbackReason, 'missing_api_key');
    assert.equal(ctxHit.recalled[0]?.title, '蓝雪花盆栽养护');
    assert.equal((await buildRecallContext({ archiveDir: dir, query: '量子力学薛定谔方程', bodyId: 'web-1', bodyType: 'web', embedding: noKeyEmb, rerank: noKeyRr, reinforce: false })).recalled.length, 0);
  });
});

test('A4-3 Mem0 状态机 ADD/UPDATE/DELETE/NONE、纯文本真相源与删库重建仅召回 active 事实', async () => {
  await withSandboxArchive('soul-a4-facts-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    const p = resolveArchivePaths(dir);
    assert.equal(applyFactOperations(dir, [
      { action: 'ADD', category: 'residence', fact: '同行者住在上海浦东', sourceSeqs: [2] },
      { action: 'ADD', category: 'pet', fact: '同行者养了一只叫土豆的橘猫', sourceSeqs: [3] },
    ]).added, 2);
    const shFact = listActiveFacts(dir).find((f) => f.category === 'residence')!;
    const petFact = listActiveFacts(dir).find((f) => f.category === 'pet')!;
    assert.equal(applyFactOperations(dir, [{ action: 'ADD', category: 'residence', fact: '同行者住在上海浦东' }]).none, 1);

    const r2 = applyFactOperations(dir, [
      { action: 'UPDATE', targetId: shFact.id, category: 'residence', fact: '同行者住在成都高新区', sourceSeqs: [10] },
      { action: 'DELETE', targetId: petFact.id },
    ]);
    assert.equal(r2.updated === 1 && r2.deleted === 1 && r2.totalRecords === 3, true);
    const allFacts = listFacts(dir);
    const oldSh = allFacts.find((f) => f.id === shFact.id)!;
    const newCd = allFacts.find((f) => f.fact.includes('成都高新区'))!;
    assert.equal(oldSh.status, 'superseded');
    assert.equal(oldSh.superseded_by, newCd.id);
    assert.equal(newCd.status, 'active');
    assert.equal(allFacts.find((f) => f.id === petFact.id)!.status, 'deleted');

    fs.rmSync(p.memoryIndexDb, { force: true });
    rebuildMemoryIndex(dir);
    assert.equal((await recallMemories(dir, '上海浦东', { topK: 5, minScore: 0.12, reinforce: false })).some((x) => x.text.includes('上海浦东')), false);
    assert.equal((await recallMemories(dir, '土豆 橘猫', { topK: 5, minScore: 0.12, reinforce: false })).some((x) => x.text.includes('土豆')), false);
    const cdRecall = await recallMemories(dir, '成都高新区', { topK: 5, minScore: 0.12, reinforce: false });
    assert.equal(cdRecall[0]?.kind, 'fact');
    assert.ok(cdRecall[0]?.text.includes('成都高新区'));
  });
});

test('A4-4 主人验收（搬家改口测试）：离线单次做梦 & 真LLM两次做梦均正确 superseded 旧事实', async () => {
  await withTestHub({ prefix: 'soul-a4-move-offline-' }, async ({ hub, dir }) => {
    const hAuth = authHeaders(hub.apiToken);
    const p = resolveArchivePaths(dir);
    await postPercept(hub.baseUrl, hub.apiToken, 'web-a4', '我住上海浦东，爱喝美式');
    for (let i = 1; i <= 5; i += 1) await postPercept(hub.baseUrl, hub.apiToken, 'web-a4', `第 ${i} 轮闲聊：今天云很漂亮。`);
    await postPercept(hub.baseUrl, hub.apiToken, 'web-a4', '我上周搬去成都高新区，改喝拿铁了');
    const dreamJson = (await (await fetch(`${hub.baseUrl}/api/dream`, { method: 'POST', headers: hAuth, body: '{}' })).json()) as {
      ok: boolean; factsAdded: number; factsUpdated: number;
    };
    assert.equal(dreamJson.ok && dreamJson.factsAdded === 2 && dreamJson.factsUpdated === 2, true);
    assertMoveFactsRows(p.facts);

    const askRes = (await postPercept(hub.baseUrl, hub.apiToken, 'web-a4-new', '我现在住哪、喝什么？')) as {
      ok: boolean; reply: string; recallTrace: { activeFacts?: Array<{ fact: string }> };
    };
    assert.equal(askRes.ok, true);
    assert.ok(askRes.reply.includes('成都高新区') && askRes.reply.includes('拿铁'));
    assert.equal(askRes.reply.includes('上海浦东') || askRes.reply.includes('美式'), false);
    assert.ok(askRes.recallTrace.activeFacts?.every((f) => !f.fact.includes('上海浦东') && !f.fact.includes('美式')));
    const factsApi = (await (await fetch(`${hub.baseUrl}/api/memory/facts?status=active`, { headers: { 'X-Soul-Token': hub.apiToken } })).json()) as {
      ok: boolean; summary: { active: number; superseded: number };
    };
    assert.equal(factsApi.ok && factsApi.summary.active === 2 && factsApi.summary.superseded === 2, true);
  });

  const srv = await startDualEngineTestServer();
  try {
    await withTestHub({ prefix: 'soul-a4-move-llm-', llmBaseUrl: `${srv.origin}/v1` }, async ({ hub, dir }) => {
      await postPercept(hub.baseUrl, hub.apiToken, 'w1', '我住上海浦东，爱喝美式');
      await runDreamConsolidation(dir, { llm: hub.ctx.llm, lock: hub.ctx.presence });
      assert.equal(listActiveFacts(dir).length, 2);
      await postPercept(hub.baseUrl, hub.apiToken, 'w1', '我上周搬去成都高新区，改喝拿铁了');
      const d2 = await runDreamConsolidation(dir, { llm: hub.ctx.llm, lock: hub.ctx.presence });
      assert.equal(d2.factsUpdated, 2);
      const ask = (await postPercept(hub.baseUrl, hub.apiToken, 'w2', '我现在住哪、喝什么？')) as { reply: string };
      assert.ok(ask.reply.includes('成都高新区') && ask.reply.includes('拿铁'));
      const factsSec = (hub.ctx.lastPrompt?.systemPrompt || '').split('## 长期个人事实记忆')[1]?.split('\n## ')[0] || '';
      assert.ok(factsSec.includes('成都高新区') && factsSec.includes('拿铁') && !factsSec.includes('上海浦东'));
    });
  } finally {
    await srv.close();
  }
});

test('A4-5 慢速 Rerank 锁外执行不阻塞并发写入 & HTTP 外部 MemoryRetriever 协议兼容', async () => {
  const srv = await startDualEngineTestServer({ rerankDelayMs: 260 });
  try {
    await withTestHub({ prefix: 'soul-a4-conc-' }, async ({ hub, dir }) => {
      const hAuth = authHeaders(hub.apiToken);
      addEpisode(dir, { bodyId: 'w1', bodyType: 'web', title: '土豆橘猫日记', summary: '我家宠物橘猫叫土豆。' });
      const cfgRes = await fetch(`${hub.baseUrl}/api/config`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({
          embedding: { enabled: true, endpoint: `${srv.origin}/v1`, model: 'Qwen/Qwen3-Embedding-0.6B', apiKey: 'demo-k-123456' },
          rerank: { enabled: true, endpoint: `${srv.origin}/v1`, model: 'Qwen/Qwen3-Reranker-0.6B', apiKey: 'demo-r-654321', minScore: 0.25 },
        }),
      });
      assert.equal(cfgRes.status, 200);
      const cfgMasked = (await (await fetch(`${hub.baseUrl}/api/config`, { headers: { 'X-Soul-Token': hub.apiToken } })).json()) as {
        config: { embedding: { apiKey: string }; rerank: { apiKey: string } };
      };
      assert.ok(cfgMasked.config.embedding.apiKey.includes('****') && cfgMasked.config.rerank.apiKey.includes('****'));
      assert.equal(((await (await fetch(`${hub.baseUrl}/api/rerank/health`, { method: 'POST', headers: hAuth, body: '{}' })).json()) as { ok: boolean }).ok, true);

      const slowPercept = postPercept(hub.baseUrl, hub.apiToken, 'w1', '我家宠物猫叫什么');
      await new Promise((r) => setTimeout(r, 40));
      const t0 = Date.now();
      const cmtRes = await fetch(`${hub.baseUrl}/api/archive/commitment`, {
        method: 'POST', headers: hAuth, body: JSON.stringify({ title: '并发承诺验证', detail: '慢 Rerank 不得持锁阻塞写入' }),
      });
      const writeMs = Date.now() - t0;
      assert.equal(cmtRes.status, 200);
      assert.ok(writeMs < 150, `Rerank 耗时 260ms 时并发写入耗时 ${writeMs}ms，应 <150ms`);
      assert.equal(((await slowPercept) as { recallTrace: { rerankActive?: boolean } }).recallTrace.rerankActive, true);
    });
  } finally {
    await srv.close();
  }

  const extSrv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { minScore?: number };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      embeddingActive: true, rerankActive: true, rerankModel: 'ext-rerank',
      items: [{ id: 'fact_ext_1', kind: 'fact', title: 'residence', text: `minScore=${parsed.minScore}`, score: 0.9, rerankScore: 0.91 }],
    }));
  });
  await new Promise<void>((resolve) => extSrv.listen(0, '127.0.0.1', resolve));
  const extPort = (extSrv.address() as { port: number }).port;
  try {
    const out = await createHttpMemoryRetriever({ endpoint: `http://127.0.0.1:${extPort}` }).retrieve({ archiveDir: '.', query: '住哪', topK: 5, minScore: 0.12 });
    assert.equal(out.items[0]?.kind === 'fact' && out.items[0]?.text === 'minScore=0.12' && out.rerankActive, true);
  } finally {
    await new Promise<void>((resolve) => extSrv.close(() => resolve()));
  }
});

test('A4-6 真实LLM单批做梦漏旧值/错留旧饮品时，时序对账自动补全 superseded 并保留自由事实', async () => {
  const srv = await startDualEngineTestServer({ lazySingleBatch: true });
  try {
    await withTestHub({ prefix: 'soul-a4-reconcile-', llmBaseUrl: `${srv.origin}/v1` }, async ({ hub, dir }) => {
      const p = resolveArchivePaths(dir);
      await postPercept(hub.baseUrl, hub.apiToken, 'w1', '我住上海浦东，爱喝美式');
      for (let i = 1; i <= 5; i += 1) await postPercept(hub.baseUrl, hub.apiToken, 'w1', `第 ${i} 轮闲聊：看云。`);
      await postPercept(hub.baseUrl, hub.apiToken, 'w1', '我上周搬去成都高新区，改喝拿铁了');
      const dRes = (await (await fetch(`${hub.baseUrl}/api/dream`, { method: 'POST', headers: authHeaders(hub.apiToken), body: '{}' })).json()) as {
        ok: boolean; factsUpdated: number;
      };
      assert.equal(dRes.ok, true);
      assert.equal(dRes.factsUpdated, 2);
      const rows = assertMoveFactsRows(p.facts);
      assert.equal(rows.find((r) => r.fact.includes('晴天的云'))?.status, 'active');
      assert.equal(listActiveFacts(dir).some((f) => f.fact.includes('上海浦东') || f.fact.includes('美式')), false);
    });
  } finally {
    await srv.close();
  }
});
