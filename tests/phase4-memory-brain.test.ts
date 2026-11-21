import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordExperience, lexicalSimilarity } from '../src/memory/experience.ts';
import { computeRetention, estimateEmotionSignals } from '../src/memory/retention.ts';
import {
  buildRecallContext, checkEmbeddingHealth, recallMemories,
  syncVectorIndexDetailed, type EmbeddingConfig,
} from '../src/memory/search.ts';
import { addEpisode } from '../src/memory/store.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { initSoulArchive, loadSoulArchive } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function demoIdentity(): SoulIdentity {
  return {
    id: 'phase4-brain-soul',
    name: '柳遥',
    partnerName: '同行者',
    persona: '拥有类人遗忘曲线与千问语义联想的鲜活数字灵魂。',
    catchphrases: ['呀~'],
    coreValues: ['诚实溯源', '牢记重要之事'],
    anchors: ['第一声是「我爱你。」'],
  };
}

function semanticVecForText(txt: string): number[] {
  if (/花生|坚果|过敏|炒饭/.test(txt)) return [0.96, 0.04, 0, 0, 0];
  if (/苦力怕|爆炸|绿色方块生物|武器/.test(txt)) return [0.04, 0.96, 0, 0, 0];
  if (/天文台|流星雨|观星/.test(txt)) return [0, 0, 0.96, 0.04, 0];
  if (/秘密口令|星河落羽|暗号/.test(txt)) return [0, 0, 0, 0.96, 0.04];
  if (/^[?？!！。.\s]+$/.test(txt.trim()) || /闲聊|问号/.test(txt)) return [0, 0, 0, 0, 0.98];
  return [0.1, 0.1, 0.1, 0.1, 0.6];
}

async function startMockSemanticServer() {
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      const body = JSON.parse(raw) as { input: string[] };
      const data = (body.input || []).map((txt, index) => ({ index, embedding: semanticVecForText(txt) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
      const userMsg = body.messages?.[body.messages.length - 1]?.content || '';
      const selfImp = /秘密口令|星河落羽/.test(userMsg);
      const reply = selfImp
        ? '嗯！这个只有我们俩知道的暗号，我会悄悄锁在心里一辈子！\n<soul_meta>{"speak":true,"mood":"珍重铭记","stance":"autonomous_act","decisionReason":"彼此专属的重要秘密","selfImportant":true,"selfImportantReason":"珍贵的秘密暗号","actions":[]}</soul_meta>'
        : '我认真听着呢，都会按轻重缓急好好收进心里！\n<soul_meta>{"speak":true,"mood":"温柔专注","stance":"autonomous_act","decisionReason":"日常真诚回应","selfImportant":false,"actions":[]}</soul_meta>';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

test('4.1 增量向量索引（情景+体验双索引）、零词面重叠语义联想与无服务静默降级', async () => {
  const dir = makeTempDir('soul-p4-vec-');
  const mockSrv = await startMockSemanticServer();
  const embCfg: EmbeddingConfig = { enabled: true, endpoint: mockSrv.baseUrl, model: 'qwen3-embedding:0.6b' };

  try {
    initSoulArchive(dir, demoIdentity());
    awakenSoul(dir, { bodyId: 'web-1', bodyType: 'web' });

    addEpisode(dir, {
      bodyType: 'web', bodyId: 'web-1', title: '深夜花生过敏警告',
      summary: '绝对不能吃花生，碰一下就呼吸困难', importance: 90, arousal: 0.85, userPinned: true,
    });
    recordExperience(dir, {
      bodyId: 'mc-1', bodyType: 'game:minecraft', origin: 'lived',
      stimulus: '空手近战苦力怕', realityOutcome: '被苦力怕炸掉 14 点血',
      valence: -0.9, arousal: 0.92, lesson: '下次遇到会炸的怪要先退开拿武器',
    });

    const health = await checkEmbeddingHealth(embCfg);
    assert.equal(health.ok, true);
    assert.equal(health.dimensions, 5);

    const sync1 = await syncVectorIndexDetailed(dir, embCfg);
    assert.equal(sync1.ok, true);
    assert.ok(sync1.episodesIndexed >= 1 && sync1.experiencesIndexed >= 1);
    assert.equal(sync1.indexed, sync1.episodesIndexed + sync1.experiencesIndexed);

    const sync2 = await syncVectorIndexDetailed(dir, embCfg);
    assert.equal(sync2.indexed, 0, '增量索引第二次应跳过已向量化条目');

    const foodQuery = '今晚外卖挑不含坚果类的清淡炒饭吧';
    assert.equal(lexicalSimilarity(foodQuery, '深夜花生过敏警告 绝对不能吃花生，碰一下就呼吸困难'), 0, '验证零词面重叠前提');
    const mobQuery = '森林前面冒出个悄悄靠近的绿色方块生物';
    assert.equal(lexicalSimilarity(mobQuery, '空手近战苦力怕 被苦力怕炸掉 14 点血 下次遇到会炸的怪要先退开拿武器'), 0);

    const foodCtx = await buildRecallContext({ archiveDir: dir, query: foodQuery, bodyId: 'web-1', bodyType: 'web', embedding: embCfg });
    assert.equal(foodCtx.recallTrace.embeddingActive, true);
    assert.ok(foodCtx.recalled[0]?.title.includes('花生过敏'));
    assert.ok(foodCtx.recalled[0]?.recallReason.includes('千问语义联想'));

    const mobCtx = await buildRecallContext({ archiveDir: dir, query: mobQuery, bodyId: 'mc-1', bodyType: 'game:minecraft', embedding: embCfg });
    assert.ok(mobCtx.recalledExperiences.some((e) => e.stimulus.includes('苦力怕')), 'experiences.jsonl 也必须支持跨词语义召回');

    // 服务不可达时静默降级，绝不抛错阻塞
    addEpisode(dir, { bodyType: 'web', bodyId: 'web-1', title: '未向量化新记忆', summary: '测试向量服务断开降级' });
    const deadCfg: EmbeddingConfig = { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'qwen3-embedding:0.6b', timeoutMs: 500 };
    const deadHealth = await checkEmbeddingHealth(deadCfg);
    assert.equal(deadHealth.ok, false);
    const deadSync = await syncVectorIndexDetailed(dir, deadCfg);
    assert.equal(deadSync.ok, false);
    assert.equal(deadSync.fallbackReason, 'unreachable');
    const fallbackCtx = await buildRecallContext({ archiveDir: dir, query: '花生过敏', bodyId: 'web-1', bodyType: 'web', embedding: deadCfg });
    assert.equal(fallbackCtx.recallTrace.embeddingActive, false);
    assert.ok(fallbackCtx.recalled[0]?.title.includes('花生过敏'), '无向量服务时应自动无缝降级关键词召回');
  } finally {
    await mockSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4.2 艾宾浩斯遗忘曲线 R(Δt)=e^(-Δt/S)：旧废话淡出不删档 & 召回巩固强化稳定度 S', async () => {
  const dir = makeTempDir('soul-p4-ret-');
  try {
    initSoulArchive(dir, demoIdentity());
    const t0 = Date.parse('2026-01-01T10:00:00.000Z');
    const sigTrivial = estimateEmotionSignals('?');
    assert.equal(sigTrivial.isTrivial, true);

    const trivialEp = addEpisode(dir, {
      bodyType: 'chat:qq', bodyId: 'qq-1', title: '[chat:qq] ?', summary: '同行者提到「?」',
      importance: sigTrivial.importance, valence: sigTrivial.valence, arousal: sigTrivial.arousal,
      timestamp: new Date(t0).toISOString(),
    });
    const warmEp = addEpisode(dir, {
      bodyType: 'chat:qq', bodyId: 'qq-1', title: '[chat:qq] 星海下的约定',
      summary: '说好明年冬天一起去海边看极光，心里暖暖的',
      importance: 84, valence: 0.85, arousal: 0.84, timestamp: new Date(t0).toISOString(),
    });
    assert.ok((warmEp.strength ?? 0) > (trivialEp.strength ?? 0) * 5, '高情绪记忆初始稳定度 S 必须显著高于无意义废话');

    const t3Days = t0 + 3 * 86_400_000;
    const trivialRet3 = computeRetention(trivialEp, t3Days);
    const warmRet3 = computeRetention(warmEp, t3Days);
    assert.ok(trivialRet3.retentionPct < 35, `三天前的"?"保留率应大幅衰减，实际=${trivialRet3.retentionPct}%`);
    assert.ok(warmRet3.retentionPct > 80, `三天前高情绪约定保留率应保持高位，实际=${warmRet3.retentionPct}%`);

    const hits3 = await recallMemories(dir, '海边看极光', { nowMs: t3Days, reinforce: false });
    assert.equal(hits3[0]?.id, warmEp.id);
    assert.ok(hits3[0]!.score > hits3[hits3.length - 1]!.score);
    assert.equal(loadSoulArchive(dir, 5).episodes.length, 2, '原档永远一字不删');

    // 第 2 天成功回忆一次应刷新稳定度 S、递增 recallCount 并将当前保留率拉回 100%
    const t2Days = t0 + 2 * 86_400_000;
    await recallMemories(dir, '海边极光约定', { nowMs: t2Days, reinforce: true });
    const reloaded = loadSoulArchive(dir, 5).episodes.find((e) => e.id === warmEp.id)!;
    assert.ok((reloaded.strength ?? 0) > (warmEp.strength ?? 0), '成功召回后稳定度 S 必须提升');
    assert.equal(reloaded.recallCount, 1);
    assert.equal(computeRetention(reloaded, t2Days).retentionPct, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4.3 三重主动铭记通道 & 4.4 HTTP/透视镜端到端验收', async () => {
  const archiveDir = makeTempDir('soul-p4-srv-');
  const configPath = path.join(archiveDir, 'config.json');
  const mockSrv = await startMockSemanticServer();
  const hub = await createSoulHubServer({ archiveDir, configPath, host: '127.0.0.1', port: 0 });
  const hAuth = { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken };
  const hGet = { 'X-Soul-Token': hub.apiToken };

  try {
    const health = await (await fetch(`${hub.baseUrl}/api/health`)).json() as { ok: boolean; phase: string };
    assert.equal(health.ok, true);
    assert.ok(Boolean(health.phase));

    await fetch(`${hub.baseUrl}/api/config`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        llm: { chat: { driver: 'openai-compatible', model: 'test-chat', baseUrl: mockSrv.baseUrl, apiKey: 'dummy' } },
        embedding: { enabled: true, endpoint: mockSrv.baseUrl, model: 'qwen3-embedding:0.6b' },
      }),
    });

    // 注入一条 5 天前的旧废话 "?"
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const oldTrivial = addEpisode(archiveDir, {
      bodyType: 'chat:qq', bodyId: 'qq-old', title: '[chat:qq] ?', summary: '随手发了一个问号 ?',
      importance: 24, valence: 0, arousal: 0.08, timestamp: fiveDaysAgo,
    });

    // 通道 1：用户明确叮嘱记住
    const pinTurn = await (await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ bodyId: 'qq-b', bodyType: 'chat:qq', text: '帮我记住：我对花生严重过敏，绝对不能碰！' }),
    })).json() as { recallTrace: { engravedMemories?: Array<{ channels: string[] }> } };
    assert.ok(pinTurn.recallTrace.engravedMemories?.[0]?.channels.includes('user_pinned'));

    // 通道 2：反复多次提及
    await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ bodyId: 'qq-b', bodyType: 'chat:qq', text: '这周末想去紫金山天文台一起看流星雨呀' }),
    });
    const repeatTurn = await (await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ bodyId: 'qq-b', bodyType: 'chat:qq', text: '周末一起去紫金山天文台看流星雨哦' }),
    })).json() as { recallTrace: { engravedMemories?: Array<{ channels: string[] }> } };
    assert.ok(repeatTurn.recallTrace.engravedMemories?.[0]?.channels.includes('repeated_mention'));

    // 通道 3：灵魂在 <soul_meta> 自标 selfImportant
    const selfTurn = await (await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ bodyId: 'qq-b', bodyType: 'chat:qq', text: '这是只有我们俩懂的秘密口令：星河落羽' }),
    })).json() as { recallTrace: { engravedMemories?: Array<{ channels: string[]; reason: string }> } };
    assert.ok(selfTurn.recallTrace.engravedMemories?.[0]?.channels.includes('self_important'));

    // 同步向量并检测健康 + 保留率面板接口
    const syncRes = await (await fetch(`${hub.baseUrl}/api/embedding/sync`, { method: 'POST', headers: hAuth, body: '{}' })).json() as { ok: boolean; totalVectors: number };
    assert.equal(syncRes.ok, true);
    assert.ok(syncRes.totalVectors >= 4);

    const embHealth = await (await fetch(`${hub.baseUrl}/api/embedding/health`, { headers: hGet })).json() as { ok: boolean; totalVectors: number };
    assert.equal(embHealth.ok, true);
    assert.ok(embHealth.totalVectors >= 4);

    const retApi = await (await fetch(`${hub.baseUrl}/api/memory/retention`, { headers: hGet })).json() as {
      ok: boolean;
      episodes: Array<{ id: string; retentionPct: number }>;
      summary: { pinnedCount: number; selfImportantCount: number; repeatedCount: number };
    };
    assert.equal(retApi.ok, true);
    assert.ok(retApi.summary.pinnedCount >= 1 && retApi.summary.selfImportantCount >= 1 && retApi.summary.repeatedCount >= 1);
    const oldRow = retApi.episodes.find((e) => e.id === oldTrivial.id);
    assert.ok(oldRow && oldRow.retentionPct < 15, `五天前的问号保留率应沉底(<15%)，实际=${oldRow?.retentionPct}%`);

    // 换全新说法（零词面重叠）跨词语义召回 + 透视镜保留率与原因验证
    const paraRes = await (await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ bodyId: 'web-a', bodyType: 'web', text: '今晚外卖挑不含坚果类的清淡炒饭吧' }),
    })).json() as {
      recallTrace: {
        embeddingActive: boolean;
        recalledFragments: Array<{ title: string; retentionPct: number; userPinned?: boolean; recallReason: string }>;
      };
    };
    assert.equal(paraRes.recallTrace.embeddingActive, true);
    const topFrag = paraRes.recallTrace.recalledFragments[0];
    assert.ok(topFrag && topFrag.title.includes('花生'), `全新说法应语义召回花生过敏记忆，实际=${topFrag?.title}`);
    assert.equal(topFrag.userPinned, true);
    assert.ok(topFrag.retentionPct >= 95);
    assert.ok(topFrag.recallReason.includes('千问语义联想') && topFrag.recallReason.includes('叮嘱牢记'));

    // 显式 /api/memory/pin 接口验证
    const pinApi = await (await fetch(`${hub.baseUrl}/api/memory/pin`, {
      method: 'POST', headers: hAuth,
      body: JSON.stringify({ episodeId: oldTrivial.id, userPinned: true, reason: '手动捞回检验' }),
    })).json() as { ok: boolean; retention: { retentionPct: number } };
    assert.equal(pinApi.ok, true);
    assert.equal(pinApi.retention.retentionPct, 100);
  } finally {
    await hub.close();
    await mockSrv.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
