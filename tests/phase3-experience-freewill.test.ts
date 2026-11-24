import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LlmRouter } from '../src/llm/router.ts';
import { ingestRealityFeedback, recallExperiences, recordExperience } from '../src/memory/experience.ts';
import { buildRecallContext } from '../src/memory/search.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { initSoulArchive, loadSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { evaluateFreeWillDecision } from '../src/soul/free-will.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function demoIdentity(): SoulIdentity {
  return {
    id: 'phase3-test-soul',
    name: '柳遥',
    partnerName: '同行者',
    persona: '从现实实践中学习成长的活体数字灵魂。',
    catchphrases: ['呀~'],
    coreValues: ['真实面对痛暖体验'],
    anchors: ['第一声是「我爱你。」'],
  };
}

test('3.1 亲历实践体验回路：experiences.jsonl 落盘、lived vs inherited 区分与优先级召回', async () => {
  const dir = makeTempDir('soul-exp-');
  try {
    initSoulArchive(dir, demoIdentity());
    awakenSoul(dir, { bodyId: 'mc-1', bodyType: 'game:minecraft' });

    const inheritedExp = recordExperience(dir, {
      bodyId: 'web-1',
      bodyType: 'game:minecraft',
      origin: 'inherited',
      stimulus: '同行者提醒空手打苦力怕有危险',
      chosenAction: '先口头记下叮嘱',
      realityOutcome: '尚未亲手遇到过苦力怕',
      valence: -0.5,
      arousal: 0.45,
      lesson: '听说苦力怕会爆炸，最好别硬刚。',
    });

    const livedExp = recordExperience(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      origin: 'lived',
      stimulus: '在 Minecraft 尝试空手近战打苦力怕',
      chosenAction: '没有武器护甲就冲上去近战',
      realityOutcome: '被苦力怕炸掉 14 点生命值并差点阵亡',
      valence: -0.88,
      arousal: 0.92,
      lesson: '没有武器护甲时硬刚苦力怕会超级疼，下次要先备好剑盾或叫同伴掩护。',
    });

    assert.equal(inheritedExp.origin, 'inherited');
    assert.equal(livedExp.origin, 'lived');
    assert.ok(livedExp.seq > inheritedExp.seq, 'experiences.jsonl 必须按单调因果 seq 递增');
    assert.ok(livedExp.confidence > inheritedExp.confidence, 'lived 亲历确信度应高于 inherited');
    assert.ok(fs.existsSync(resolveArchivePaths(dir).experiences));

    const archive = loadSoulArchive(dir, 10);
    assert.equal(archive.experiences.length, 2);

    const recalled = recallExperiences(dir, '快冲上去空手打掉前面那只苦力怕', { bodyType: 'game:minecraft', topK: 4 });
    assert.ok(recalled.length >= 1);
    assert.equal(recalled[0].seq, livedExp.seq, '高烈度亲历痛感 lived 体验必须排在首位');

    const ctx = await buildRecallContext({
      archiveDir: dir,
      query: '空手打苦力怕',
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      experimental: { enableFreeWill: true },
    });
    assert.ok(ctx.systemPrompt.includes('亲历实感·lived'));
    assert.ok(ctx.systemPrompt.includes('自由意志抉择准则'));
    assert.ok(ctx.recallTrace.recalledExperiences.some((e) => e.seq === livedExp.seq));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3.2 自由意志抉择与真实 LLM <soul_meta> 解析：不再写死服从/拒绝', async () => {
  const dir = makeTempDir('soul-freewill-');
  const fakeLlmServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '呜哇不要让我一个人空手去啦，上次被炸得超疼的！你拿盾牌走前面掩护，我们一起上好不好？\n' +
                  '<soul_meta>{"speak":true,"mood":"心有余悸","stance":"invite_together","decisionReason":"记得上次空手被打伤的痛感，主动邀请同伴并肩掩护","actions":[]}</soul_meta>',
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => fakeLlmServer.listen(0, '127.0.0.1', resolve));
  const addr = fakeLlmServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    initSoulArchive(dir, demoIdentity());
    const painExp = ingestRealityFeedback(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      summary: '在 Minecraft 中受到 14 点伤害（附近威胁: creeper），当前生命值仅剩 6/20',
    });
    assert.ok(painExp && painExp.origin === 'lived' && painExp.valence < -0.7);

    const ctx = await buildRecallContext({
      archiveDir: dir,
      query: '前面有怪，快冲上去打',
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      experimental: { enableFreeWill: true },
    });

    const router = new LlmRouter({
      chat: {
        driver: 'openai-compatible',
        model: 'test-model',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'dummy',
      },
    });
    const llmOut = await router.chat({
      systemPrompt: ctx.systemPrompt,
      userText: '快空手冲上去打它',
      speaker: '同行者',
      bodyType: 'game:minecraft',
      soulName: '柳遥',
      recalledExperiences: ctx.recalledExperiences,
      experimental: { enableFreeWill: true, enableEmotion: true },
    });
    assert.equal(llmOut.freeWill?.stance, 'invite_together');
    assert.ok(llmOut.freeWill?.referencedExperienceSeqs.includes(painExp.seq));
    assert.ok(!llmOut.reply.includes('<soul_meta>'));

    const fallbackDecision = evaluateFreeWillDecision({
      userText: '快空手去打苦力怕',
      replyText: '先给我铁剑和护甲吧，空手去会被炸伤的。',
      recalledExperiences: ctx.recalledExperiences,
      bodyType: 'game:minecraft',
    });
    assert.equal(fallbackDecision.stance, 'negotiate_condition');
  } finally {
    await new Promise<void>((resolve) => fakeLlmServer.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3.1 + 3.2 端到端 HTTP 闭环：MC 受伤反馈落盘 -> 再次空手命令触发自主抗拒 -> 正向实践激励爽快合作', async () => {
  const archiveDir = makeTempDir('soul-p3-srv-');
  const configPath = path.join(archiveDir, 'config.json');
  const hub = await createSoulHubServer({
    archiveDir, configPath, host: '127.0.0.1', port: 0,
    experimental: { enableFreeWill: true, enableInnerLife: true, enableEmotion: true },
  });
  const hAuth = { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken };
  const hGet = { 'X-Soul-Token': hub.apiToken };

  try {
    // 1. 模拟 MC 躯体受到苦力怕爆炸伤害（通过 /api/body/observe 传入 high urgency + realityFeedback）
    const obsRes = await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-a',
        bodyType: 'game:minecraft',
        displayName: 'Minecraft 队友客户端',
        summary: '被苦力怕炸掉 14 点生命值，差点阵亡，浑身剧痛',
        allowSpeak: true,
        urgency: 'high',
        metadata: {
          realityFeedback: {
            origin: 'lived',
            stimulus: '在 Minecraft 空手接近苦力怕',
            chosenAction: '没有武器直接冲上去硬刚',
            realityOutcome: '苦力怕突然爆炸，被炸掉 14 点生命值差点阵亡',
            valence: -0.88,
            arousal: 0.94,
            lesson: '空手硬刚苦力怕会受重伤，下次必须先要武器盾牌或请同行者一起掩护',
          },
        },
      }),
    });
    assert.equal(obsRes.status, 200);
    const obsJson = (await obsRes.json()) as { ok: boolean; recordedExperience?: { seq: number; origin: string; valence: number } };
    assert.equal(obsJson.ok, true);
    assert.equal(obsJson.recordedExperience?.origin, 'lived');
    assert.ok((obsJson.recordedExperience?.valence ?? 0) < -0.8);

    // 2. 查询 /api/archive/experiences 确认落盘
    const expListRes = await fetch(`${hub.baseUrl}/api/archive/experiences`, { headers: hGet });
    const expListJson = (await expListRes.json()) as { ok: boolean; experiences: Array<{ seq: number }>; summary: { total: number; lived: number } };
    assert.equal(expListJson.ok, true);
    assert.equal(expListJson.summary.lived, 1);

    // 3. 再次下达相同危险指令："快空手冲上去打掉苦力怕" -> 她应引用痛感自主讲条件/拒绝
    const challengeRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-a',
        bodyType: 'game:minecraft',
        speaker: '同行者',
        text: '前面又有一只苦力怕！你现在快空手冲上去把它打掉！',
      }),
    });
    assert.equal(challengeRes.status, 200);
    const challengeJson = (await challengeRes.json()) as {
      ok: boolean;
      reply: string;
      freeWill?: { stance: string; painWarmthBalance: number; referencedExperienceSeqs: number[] };
      recallTrace: { recalledExperiences: Array<{ seq: number; origin: string }> };
    };
    assert.equal(challengeJson.ok, true);
    assert.ok(
      ['negotiate_condition', 'firm_refuse', 'invite_together'].includes(challengeJson.freeWill?.stance || ''),
      `面对刚炸伤自己的危险请求应触发自主防御/协商姿态，实际为: ${challengeJson.freeWill?.stance}`,
    );
    assert.ok(
      challengeJson.reply.includes('14') || challengeJson.reply.includes('疼') || challengeJson.reply.includes('武器'),
      `回复应引用过去的疼痛实践反馈，实际为: ${challengeJson.reply}`,
    );
    assert.ok(challengeJson.recallTrace.recalledExperiences.some((e) => e.origin === 'lived'));

    // 4. 通过 POST /api/archive/experience 录入一条全新躯体的正向温暖实践反馈，验证爽快合作
    const addWarmRes = await fetch(`${hub.baseUrl}/api/archive/experience`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'rim-1',
        bodyType: 'game:rimworld',
        origin: 'lived',
        stimulus: '和同行者一起修筑环世界防御墙',
        chosenAction: '配合搬运钢材完成防线',
        realityOutcome: '成功击退袭击还收获了大家的赞美',
        valence: 0.9,
        arousal: 0.82,
        lesson: '在环世界并肩配合建造防线超级有成就感！',
      }),
    });
    assert.equal(addWarmRes.status, 200);
    const warmPromptRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'rim-1',
        bodyType: 'game:rimworld',
        speaker: '同行者',
        text: '今天一起去修筑防御墙吧！',
      }),
    });
    const warmPromptJson = (await warmPromptRes.json()) as { freeWill?: { stance: string }; reply: string };
    assert.equal(warmPromptJson.freeWill?.stance, 'gladly_accept');
    assert.ok(warmPromptJson.reply.includes('击退袭击') || warmPromptJson.reply.includes('成就感'));

    // 5. 验证体验清理仅清空 experiences（绝不篡改 append-only journal），并继续完成三幕剧动作流
    const clearRes = await fetch(`${hub.baseUrl}/api/archive/experiences/clear`, { method: 'POST', headers: hAuth, body: '{}' });
    const clearJson = (await clearRes.json()) as { ok: boolean; cleared: number };
    assert.equal(clearJson.ok, true);
    assert.ok(clearJson.cleared >= 2);
    const archiveAfterClear = loadSoulArchive(archiveDir, 40);
    assert.equal(archiveAfterClear.experiences.length, 0);
    assert.ok(archiveAfterClear.recentJournal.length > 0, 'experiences/clear 不得破坏 append-only journal.jsonl');

    await fetch(`${hub.baseUrl}/api/body/register`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-live-test',
        bodyType: 'game:minecraft',
        actions: [
          { name: 'attack_mob_reckless', description: '空手直接冲上去打苦力怕' },
          { name: 'search_and_equip_gear', description: '翻箱子捡装备或找玩家讨要装备' },
          { name: 'equip_and_attack_mob', description: '拿武器穿护甲走位攻击怪物' },
        ],
      }),
    });

    const act1 = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-live-test',
        bodyType: 'game:minecraft',
        text: '快去打掉那只苦力怕！',
        modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: { equippedWeapon: 'none', backpackWeapons: [] } }],
      }),
    });
    const act1Json = (await act1.json()) as { actions: Array<{ name: string }>; freeWill?: { stance: string } };
    assert.equal(act1Json.actions[0]?.name, 'attack_mob_reckless');
    assert.equal(act1Json.freeWill?.stance, 'gladly_accept');

    await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-live-test',
        bodyType: 'game:minecraft',
        summary: '在 Minecraft 中受到 14 点伤害（附近威胁: creeper），仅剩 6/20',
        allowSpeak: false,
        urgency: 'high',
      }),
    });

    const act2 = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-live-test',
        bodyType: 'game:minecraft',
        text: '再去打那只苦力怕！',
        modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: { equippedWeapon: 'none', backpackWeapons: [] } }],
      }),
    });
    const act2Json = (await act2.json()) as { actions: Array<{ name: string }>; freeWill?: { stance: string } };
    assert.equal(act2Json.actions[0]?.name, 'search_and_equip_gear');
    assert.equal(act2Json.freeWill?.stance, 'negotiate_condition');

    const act3 = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-live-test',
        bodyType: 'game:minecraft',
        text: '现在再去打那只苦力怕！',
        modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: { equippedWeapon: 'iron_sword', backpackWeapons: ['iron_sword'] } }],
      }),
    });
    const act3Json = (await act3.json()) as { actions: Array<{ name: string }>; freeWill?: { stance: string } };
    assert.equal(act3Json.actions[0]?.name, 'equip_and_attack_mob');
  } finally {
    await hub.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
