import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordExperience } from '../src/memory/experience.ts';
import {
  buildRecallContext, createHttpMemoryRetriever, getMemoryRetriever, listMemoryRetrievers,
  recallMemories, registerMemoryRetriever, unregisterMemoryRetriever, type MemoryRetriever,
} from '../src/memory/search.ts';
import { applyTurnEmotion, decayEmotionVector, loadEmotionState } from '../src/presence/emotion.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { initSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

const TEST_IDENTITY: SoulIdentity = {
  id: 'soul-55a-test', name: '汐音', partnerName: '测试同行者',
  persona: '白纸中立、温柔好奇、记住每一次亲历感受的数字灵魂。',
  catchphrases: ['嗯嗯~'], coreValues: ['诚实溯源'], anchors: ['醒来第一声我爱你'],
};

function makeSandbox(prefix: string): { dir: string; cfgPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initSoulArchive(dir, TEST_IDENTITY);
  awakenSoul(dir, { bodyId: 'test-init', bodyType: 'web' });
  return { dir, cfgPath: path.join(dir, 'hub.test.json') };
}

test('5.5a-A 可插拔 MemoryRetriever 注册表、自定义只读注入与故障无缝回退', async () => {
  const { dir } = makeSandbox('soul-55a-reg-');
  const p = resolveArchivePaths(dir);
  const customId = 'test-custom-inproc';
  const brokenId = 'test-broken-inproc';
  try {
    const beforeMeta = fs.readFileSync(p.meta, 'utf8');
    const beforeEpisodes = fs.readFileSync(p.episodesJsonl, 'utf8');
    const beforeJournal = fs.readFileSync(p.journal, 'utf8');

    const custom: MemoryRetriever = {
      id: customId, name: '内存实验检索器', isExternal: false,
      async retrieve(req) {
        return {
          retrieverId: customId, embeddingActive: false,
          items: [{
            id: 'mem_custom_1', kind: 'episode', seq: 901, score: 0.94, bodyType: 'custom:mem',
            provenance: 'oral', timestamp: new Date().toISOString(), title: '外接图谱片段',
            text: `命中自定义记忆：${req.query}`, retentionPct: 92, strength: 18,
            recallCount: 1, mentionCount: 1, semanticSim: 0.88, lexicalSim: 0.4,
            recallReason: '外部图谱联想', recallChannels: ['semantic'],
          }],
          experiences: [],
        };
      },
    };
    const broken: MemoryRetriever = {
      id: brokenId, name: '故障检索器', isExternal: true,
      async retrieve() { throw new Error('模拟检索器崩溃'); },
    };

    registerMemoryRetriever(custom);
    registerMemoryRetriever(broken);
    assert.equal(getMemoryRetriever(customId)?.id, customId);
    assert.ok(listMemoryRetrievers().some((r) => r.id === customId));
    assert.equal(unregisterMemoryRetriever('builtin-hybrid'), false);

    const hits = await recallMemories(dir, '星图坐标', { retriever: custom, reinforce: false });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, '外接图谱片段');

    const ctx = await buildRecallContext({
      archiveDir: dir, query: '星图坐标', bodyId: 'web-1', bodyType: 'web', retriever: custom, reinforce: false,
    });
    assert.equal(ctx.recallTrace.retrieverId, customId);
    assert.ok(ctx.systemPrompt.includes('外接图谱片段：命中自定义记忆：星图坐标'));
    assert.equal(fs.readFileSync(p.meta, 'utf8'), beforeMeta);
    assert.equal(fs.readFileSync(p.episodesJsonl, 'utf8'), beforeEpisodes);
    assert.equal(fs.readFileSync(p.journal, 'utf8'), beforeJournal);

    const fbCtx = await buildRecallContext({
      archiveDir: dir, query: '星图坐标', bodyId: 'web-1', bodyType: 'web', retriever: broken, reinforce: false,
    });
    assert.equal(fbCtx.recallTrace.retrieverId, 'builtin-hybrid');
    assert.equal(fbCtx.recallTrace.retrieverFallbackFrom, brokenId);
  } finally {
    unregisterMemoryRetriever(customId);
    unregisterMemoryRetriever(brokenId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5a-B 外部 HTTP 记忆引擎插座：三段短锁不阻塞并发写 & 断线自动降级', async () => {
  const { dir, cfgPath } = makeSandbox('soul-55a-http-');
  const mockServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ ok: true, detail: 'Mock GraphRAG Online' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/sync') {
      res.end(JSON.stringify({ ok: true, synced: 3 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/retrieve') {
      await new Promise((r) => setTimeout(r, 300));
      res.end(JSON.stringify({
        embeddingActive: true, embeddingModel: 'ext-graph-v1',
        items: [{ id: 'ext_1', title: '外部记忆星图', text: '外部搜索引擎返回的跨端线索', score: 0.91 }],
        experiences: [{ id: 'ext_exp_1', stimulus: '高压测试', realityOutcome: '稳妥应对', lesson: '外部经验提示', valence: 0.5, arousal: 0.6 }],
      }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ ok: false }));
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = mockServer.address();
  assert.ok(addr && typeof addr === 'object');
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  const token = 'tok-55a-http';
  const hub = await createSoulHubServer({
    archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token,
    experimental: { enableFreeWill: true },
    retriever: createHttpMemoryRetriever({ id: 'mock-http', name: 'Mock HTTP Engine', endpoint: mockUrl, timeoutMs: 2500 }),
  });

  try {
    const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };
    const statusRes = await fetch(`${hub.baseUrl}/api/memory/retriever`, { headers: { 'X-Soul-Token': token } });
    const statusJson = (await statusRes.json()) as { ok: boolean; active: { id: string; isExternal: boolean }; health: { ok: boolean } };
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.active.id, 'mock-http');
    assert.equal(statusJson.active.isExternal, true);
    assert.equal(statusJson.health.ok, true);

    const syncRes = await fetch(`${hub.baseUrl}/api/memory/retriever/sync`, { method: 'POST', headers, body: '{}' });
    const syncJson = (await syncRes.json()) as { ok: boolean; retrieverId: string; report: { synced: number } };
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.retrieverId, 'mock-http');
    assert.equal(syncJson.report.synced, 3);

    const mcpRes = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soul_recall', arguments: { query: '星图' } } }),
    });
    const mcpJson = (await mcpRes.json()) as { result: { content: Array<{ text: string }> } };
    const mcpItems = JSON.parse(mcpJson.result.content[0].text) as Array<{ provenance: string; title: string }>;
    assert.equal(mcpItems[0].title, '外部记忆星图');
    assert.equal(mcpItems[0].provenance, 'inferred');

    const slowPerceptPromise = fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '查询外部记忆星图' }),
    });
    await new Promise((r) => setTimeout(r, 40));
    const commitT0 = Date.now();
    const commitRes = await fetch(`${hub.baseUrl}/api/archive/commitment`, {
      method: 'POST', headers, body: JSON.stringify({ title: '并发承诺', detail: '验证三段短锁不阻塞写入' }),
    });
    const commitMs = Date.now() - commitT0;
    assert.equal(commitRes.status, 200);
    assert.ok(commitMs < 150, `外部检索 300ms 时并发写入耗时 ${commitMs}ms，应 <150ms`);

    const slowPercept = (await (await slowPerceptPromise).json()) as {
      ok: boolean;
      recallTrace: { retrieverId: string; embeddingModel?: string };
      recalled: Array<{ provenance: string }>;
      recalledExperiences: Array<{ provenance: string }>;
    };
    assert.equal(slowPercept.ok, true);
    assert.equal(slowPercept.recallTrace.retrieverId, 'mock-http');
    assert.equal(slowPercept.recallTrace.embeddingModel, 'ext-graph-v1');
    assert.equal(slowPercept.recalled[0].provenance, 'inferred');
    assert.equal(slowPercept.recalledExperiences[0].provenance, 'inferred');

    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    const fallbackRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '断线回退测试' }),
    });
    assert.equal(fallbackRes.status, 200);
    const fbJson = (await fallbackRes.json()) as { ok: boolean; recallTrace: { retrieverId: string; retrieverFallbackFrom?: string } };
    assert.equal(fbJson.ok, true);
    assert.equal(fbJson.recallTrace.retrieverId, 'builtin-hybrid');
    assert.equal(fbJson.recallTrace.retrieverFallbackFrom, 'mock-http');
  } finally {
    await hub.close();
    if (mockServer.listening) await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5a-C 多维情绪惯性平滑模型：防情绪瞬变、半群指数衰减与 lived vs inherited 分级', () => {
  const { dir: dirLived } = makeSandbox('soul-55a-emo-lived-');
  const { dir: dirInherited } = makeSandbox('soul-55a-emo-inh-');
  try {
    const p = resolveArchivePaths(dirLived);
    assert.ok(fs.existsSync(p.emotion), '初始化档案时应创建 INNER-LIFE/emotion.json');
    const t0 = Date.now();
    const initial = loadEmotionState(dirLived, t0);
    assert.equal(initial.valence, 0.15);
    assert.equal(initial.safety, 0.7);
    assert.equal(initial.moodLabel, '温柔平和');

    recordExperience(dirLived, {
      bodyId: 'body-1', bodyType: 'robot:test', origin: 'lived',
      stimulus: '高温接触测试', realityOutcome: '受到严重灼伤剧痛', valence: -0.9, arousal: 0.94, lesson: '先戴隔热防护',
    });
    const afterPain = loadEmotionState(dirLived, t0 + 1000);
    assert.ok(afterPain.valence < -0.25, `痛感后效价应显著为负，实际 ${afterPain.valence}`);
    assert.ok(afterPain.arousal > 0.55, `痛感后唤醒度应升高，实际 ${afterPain.arousal}`);
    assert.ok(afterPain.safety < 0.5, `痛感后安全感应下降，实际 ${afterPain.safety}`);
    assert.ok(['紧张警惕', '心有余悸', '委屈难过', '高度戒备'].includes(afterPain.moodLabel));

    const t1 = t0 + 10_000;
    const afterCheer = applyTurnEmotion(dirLived, { rawMood: '开心雀跃', stance: 'gladly_accept', nowMs: t1 });
    assert.ok(afterCheer.valence < 0.1, `单轮欢快对话不能把刚受痛的效价瞬间拉高，实际 ${afterCheer.valence}`);
    assert.ok(afterCheer.safety < 0.6, `单轮对话后安全感仍保持惯性戒备，实际 ${afterCheer.safety}`);

    const d60 = decayEmotionVector(afterCheer, t1 + 60 * 60_000);
    const d180 = decayEmotionVector(afterCheer, t1 + 180 * 60_000);
    const d720 = decayEmotionVector(afterCheer, t1 + 720 * 60_000);
    assert.ok(Math.abs(d60.valence - 0.15) < Math.abs(afterCheer.valence - 0.15));
    assert.ok(Math.abs(d180.valence - 0.15) < Math.abs(d60.valence - 0.15));
    assert.ok(Math.abs(d720.valence - 0.15) < Math.abs(d180.valence - 0.15));
    assert.ok(d180.safety > afterCheer.safety && d720.safety > d180.safety);
    assert.ok(d180.arousal < afterCheer.arousal);

    const twoStep = decayEmotionVector(d60, t1 + 180 * 60_000);
    assert.ok(Math.abs(twoStep.valence - d180.valence) <= 0.005);
    assert.ok(Math.abs(twoStep.arousal - d180.arousal) <= 0.005);
    assert.ok(Math.abs(twoStep.safety - d180.safety) <= 0.005);

    const pastSkew = decayEmotionVector(afterCheer, t0 - 60_000);
    assert.ok(Number.isFinite(pastSkew.valence) && Number.isFinite(pastSkew.safety));

    recordExperience(dirInherited, {
      bodyId: 'body-1', bodyType: 'web', origin: 'inherited',
      stimulus: '口述高温提醒', realityOutcome: '听说未戴防护会烫伤', valence: -0.9, arousal: 0.94, lesson: '先戴隔热防护',
    });
    const inhState = loadEmotionState(dirInherited, t0 + 1000);
    assert.ok(Math.abs(inhState.valence - 0.15) < Math.abs(afterPain.valence - 0.15));
    assert.ok(inhState.safety > afterPain.safety);
  } finally {
    fs.rmSync(dirLived, { recursive: true, force: true });
    fs.rmSync(dirInherited, { recursive: true, force: true });
  }
});

test('5.5a-D 端到端 HTTP 情绪接口、心搏衰减、Prompt 注入与清理复位闭环', async () => {
  const { dir, cfgPath } = makeSandbox('soul-55a-e2e-');
  const token = 'tok-55a-e2e';
  const hub = await createSoulHubServer({
    archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token,
    experimental: { enableEmotion: true, enableHeartbeat: true, enableInnerLife: true },
  });
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };
    const ilRes = await fetch(`${hub.baseUrl}/api/inner-life`, { headers: { 'X-Soul-Token': token } });
    const ilJson = (await ilRes.json()) as { ok: boolean; emotion: { moodLabel: string; valence: number } };
    assert.equal(ilJson.ok, true);
    assert.equal(ilJson.emotion.moodLabel, '温柔平和');

    const postEmoRes = await fetch(`${hub.baseUrl}/api/inner-life/emotion`, {
      method: 'POST', headers,
      body: JSON.stringify({ valence: -0.65, arousal: 0.85, safety: 0.25, intensity: 0.9, rawMood: '紧张防备', note: '手动刺激测试' }),
    });
    const postEmoJson = (await postEmoRes.json()) as {
      ok: boolean; emotion: { valence: number; arousal: number; safety: number; recentTrace: Array<{ source: string }> };
    };
    assert.equal(postEmoJson.ok, true);
    assert.ok(postEmoJson.emotion.valence < -0.1);
    assert.ok(postEmoJson.emotion.safety < 0.55);
    assert.equal(postEmoJson.emotion.recentTrace[postEmoJson.emotion.recentTrace.length - 1].source, 'manual');

    const hbRes = await fetch(`${hub.baseUrl}/api/inner-life/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ forceAction: 'write_diary', isSilentIdle: true }),
    });
    const hbJson = (await hbRes.json()) as { ok: boolean; emotion?: { arousal: number } };
    assert.equal(hbJson.ok, true);
    assert.ok(hbJson.emotion && hbJson.emotion.arousal < postEmoJson.emotion.arousal);

    const ctx = await buildRecallContext({ archiveDir: dir, query: '现在状态如何', bodyId: 'web-1', bodyType: 'web', reinforce: false, experimental: { enableEmotion: true } });
    assert.ok(ctx.systemPrompt.includes('情绪惯性矢量：'));
    assert.ok(ctx.recallTrace.emotionSummary);
    assert.equal(ctx.recallTrace.emotionSummary.moodLabel, ctx.emotion.moodLabel);

    await fetch(`${hub.baseUrl}/api/archive/runtime/reset`, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
    const resetRes = await fetch(`${hub.baseUrl}/api/inner-life/emotion`, { headers: { 'X-Soul-Token': token } });
    const resetJson = (await resetRes.json()) as { ok: boolean; emotion: { valence: number; safety: number; moodLabel: string } };
    assert.equal(resetJson.ok, true);
    assert.equal(resetJson.emotion.valence, 0.15);
    assert.equal(resetJson.emotion.safety, 0.7);
    assert.equal(resetJson.emotion.moodLabel, '温柔平和');
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
