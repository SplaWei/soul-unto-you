import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordExperience } from '../src/memory/experience.ts';
import { buildRecallContext } from '../src/memory/search.ts';
import {
  inferEpistemicAttitude,
  listDesires,
  listDiary,
  loadDrives,
  runSoulHeartbeat,
  updateDrives,
} from '../src/presence/inner-life.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { initSoulArchive, loadSoulArchive, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { evolveSelfFromDream, listBeliefs, listSelfEvolution } from '../src/soul/living-self.ts';
import type { SoulIdentity } from '../src/soul/types.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function demoIdentity(): SoulIdentity {
  return {
    id: 'phase3-inner-test',
    name: '柳遥',
    partnerName: '同行者',
    persona: '拥有动态内驱力与自主目的的活体灵魂。',
    catchphrases: ['呀~'],
    coreValues: ['从实践中学习'],
    anchors: ['第一声是「我爱你。」'],
  };
}

test('3.3 先验认知态度(信/疑/忽)随内驱力演化 + 实践反馈自动升级为 verified / overturned 并生成微心愿', async () => {
  const dir = makeTempDir('soul-inner-');
  try {
    initSoulArchive(dir, demoIdentity());
    awakenSoul(dir, { bodyId: 'mc-1', bodyType: 'game:minecraft' });
    const p = resolveArchivePaths(dir);
    assert.ok(fs.existsSync(p.drives) && fs.existsSync(p.desires) && fs.existsSync(p.diary));

    // 默认：curiosity > safety -> skeptical (半信半疑)
    const d0 = loadDrives(dir);
    assert.equal(d0.epistemicTendency, 'skeptical');

    // 注入一条书本/口述先验警告，应标记为 skeptical
    const bookExp = recordExperience(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      origin: 'inherited',
      stimulus: '听主人说过苦力怕会爆炸',
      realityOutcome: '尚未亲手遇到过苦力怕',
      valence: -0.6,
      lesson: '书本提醒：别空手招惹苦力怕。',
    });
    assert.equal(bookExp.attitude, 'skeptical');

    // 切换高警觉 -> believed；高玩心低警觉 -> dismissed
    const highSafety = updateDrives(dir, { safety: 0.85, curiosity: 0.4 });
    assert.equal(inferEpistemicAttitude(highSafety, 'inherited'), 'believed');
    const highPlay = updateDrives(dir, { playfulness: 0.85, safety: 0.3, curiosity: 0.5 });
    assert.equal(inferEpistemicAttitude(highPlay, 'inherited'), 'dismissed');

    // 亲身被苦力怕炸伤后：safety 飙升、原先 skeptical 的书本认知转为 verified，并自动长出防身微心愿
    updateDrives(dir, { safety: 0.42, curiosity: 0.72, playfulness: 0.68 });
    recordExperience(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      origin: 'lived',
      stimulus: '好奇靠近并空手打苦力怕',
      realityOutcome: '被苦力怕炸掉 16 点生命值，差点倒下',
      valence: -0.92,
      lesson: '真被炸惨了，先去找剑和护甲再打！',
    });

    const dAfterPain = loadDrives(dir);
    assert.ok(dAfterPain.safety >= 0.65, `挨炸后安全警觉应显著升高，实际=${dAfterPain.safety}`);
    const archiveAfterPain = loadSoulArchive(dir, 10);
    const updatedBook = archiveAfterPain.experiences.find((e) => e.id === bookExp.id);
    assert.equal(updatedBook?.attitude, 'verified', '经历痛苦实践后，原先半信半疑的书本警告应转化为实践证实');
    const desires = listDesires(dir);
    assert.ok(desires.some((d) => d.status === 'active' && d.title.includes('防护准备') && d.triggerSource === 'practice'));

    // 拿到钻石剑并防爆走位击杀后：防身微心愿自动达成，并升级为探索实践新心愿
    recordExperience(dir, {
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      origin: 'lived',
      stimulus: '穿好铁甲持 diamond_sword 迎战苦力怕',
      realityOutcome: '成功击败苦力怕且血量无损',
      valence: 0.9,
      lesson: '拿着好剑配合拉扯走位可以战胜苦力怕！',
    });
    const desiresAfterWin = listDesires(dir);
    assert.ok(desiresAfterWin.some((d) => d.title.includes('防护准备') && d.status === 'fulfilled'));
    assert.ok(desiresAfterWin.some((d) => d.status === 'active' && d.title.includes('探索实践')));

    const recall = await buildRecallContext({
      archiveDir: dir,
      query: '现在去探索一下',
      bodyId: 'mc-1',
      bodyType: 'game:minecraft',
      experimental: { enableInnerLife: true, enableFreeWill: true },
    });
    assert.ok(recall.systemPrompt.includes('内在驱力场与先验认知态度'));
    assert.ok(recall.systemPrompt.includes('自主微心愿'));
    assert.ok((recall.recallTrace.activeDesires?.length ?? 0) >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3.3 静默灵魂心搏四选一 & /api/inner-life HTTP 端到端闭环', async () => {
  const archiveDir = makeTempDir('soul-hb-srv-');
  const configPath = path.join(archiveDir, 'config.json');
  const hub = await createSoulHubServer({
    archiveDir, configPath, host: '127.0.0.1', port: 0,
    experimental: { enableInnerLife: true, enableFreeWill: true, enableHeartbeat: true, enableEmotion: true },
  });
  const hAuth = { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken };
  const hGet = { 'X-Soul-Token': hub.apiToken };

  try {
    const initRes = await fetch(`${hub.baseUrl}/api/inner-life`, { headers: hGet });
    const initJson = (await initRes.json()) as { ok: boolean; drives: { epistemicTendency: string } };
    assert.equal(initJson.ok, true);
    assert.equal(initJson.drives.epistemicTendency, 'skeptical');

    // 调成高安全警觉 (believed) 时，即使没挨过炸，在 MC 面对苦力怕也应先找装备而非盲冲
    await fetch(`${hub.baseUrl}/api/inner-life/drives`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ safety: 0.88, curiosity: 0.4 }),
    });
    await fetch(`${hub.baseUrl}/api/body/register`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-cautious',
        bodyType: 'game:minecraft',
        actions: [
          { name: 'attack_mob_reckless', description: '空手直接冲上去' },
          { name: 'search_and_equip_gear', description: '先找武器护甲' },
          { name: 'equip_and_attack_mob', description: '持武器穿护甲走位攻击怪物' },
        ],
      }),
    });
    const cautiousRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ bodyId: 'mc-cautious', bodyType: 'game:minecraft', text: '快去打掉那只苦力怕！' }),
    });
    const cautiousJson = (await cautiousRes.json()) as { actions: Array<{ name: string }> };
    assert.equal(cautiousJson.actions[0]?.name, 'search_and_equip_gear', '高警觉 believed 态应听劝先备装备');

    // 测试静默心搏：write_diary / update_desire / reach_out / stay_quiet
    const hbDiary = await (await fetch(`${hub.baseUrl}/api/inner-life/heartbeat`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ forceAction: 'write_diary', isSilentIdle: true }),
    })).json() as { ok: boolean; action: string; diaryEntry: { thought: string } };
    assert.equal(hbDiary.ok, true);
    assert.equal(hbDiary.action, 'write_diary');
    assert.ok(hbDiary.diaryEntry.thought.length > 0);

    const hbReach = await (await fetch(`${hub.baseUrl}/api/inner-life/heartbeat`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ forceAction: 'reach_out', isSilentIdle: true }),
    })).json() as { ok: boolean; action: string; proactiveMessage?: string };
    assert.equal(hbReach.action, 'reach_out');
    assert.ok((hbReach.proactiveMessage || '').length > 0);

    const directQuiet = await runSoulHeartbeat(archiveDir, { forceAction: 'stay_quiet' });
    assert.equal(directQuiet.action, 'stay_quiet');
    assert.ok(listDiary(archiveDir, 20).length >= 3);

    // 验证 inner-life.js 静态资源可正常访问
    const jsRes = await fetch(`${hub.baseUrl}/inner-life.js`);
    assert.equal(jsRes.status, 200);

    // 3.4 验证活体自我演化与时序信念取代链 (beliefs.jsonl + self-evolution.jsonl + EVOLVING-SELF.md)
    await fetch(`${hub.baseUrl}/api/archive/runtime/reset`, { method: 'POST', headers: hAuth, body: JSON.stringify({ confirm: true }) });
    const visObsRes = await (await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-fresh',
        bodyType: 'game:minecraft',
        summary: '[视觉感知] 前方 4 格出现一只苦力怕！我还没亲身挨过它的炸，当前主手武器: none',
        allowSpeak: false,
        urgency: 'high',
      }),
    })).json() as { ok: boolean; recordedExperience: unknown };
    assert.equal(visObsRes.ok, true);
    assert.equal(visObsRes.recordedExperience, null, '纯视觉感知不得被误判写入痛感体验');

    await fetch(`${hub.baseUrl}/api/archive/experience`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyType: 'game:minecraft',
        origin: 'lived',
        stimulus: '空手近战苦力怕',
        realityOutcome: '被苦力怕炸掉 16 点生命值重伤',
        valence: -0.92,
        lesson: '绝不能空手硬刚苦力怕，必须先拿武器护甲',
      }),
    });
    const beliefsAfterPain = listBeliefs(archiveDir);
    assert.ok(beliefsAfterPain.some((b) => !b.supersededAtSeq && b.topic === '危险防备底线' && b.statement.includes('武器护甲')));

    await fetch(`${hub.baseUrl}/api/archive/experience`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyType: 'game:minecraft',
        origin: 'lived',
        stimulus: '手持钻石剑与护甲配合防爆走位迎战苦力怕',
        realityOutcome: '成功击败苦力怕无伤过关',
        valence: 0.9,
        lesson: '备好武器与走位即可安全击败苦力怕',
      }),
    });
    const beliefsAfterWin = listBeliefs(archiveDir);
    assert.ok(beliefsAfterWin.some((b) => !b.supersededAtSeq && b.topic === '危险防备底线' && b.statement.includes('绝不能空手')));
    assert.ok(beliefsAfterWin.some((b) => Boolean(b.supersededAtSeq) && b.topic === '实战破局信心'));
    assert.ok(beliefsAfterWin.some((b) => !b.supersededAtSeq && b.topic === '实战破局信心' && b.statement.includes('走位')));
    assert.equal(listSelfEvolution(archiveDir).length, 2);

    // 验证重复受伤与多次做梦反思不得生成重复年轮或退化回退
    await fetch(`${hub.baseUrl}/api/archive/experience`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyType: 'game:minecraft',
        origin: 'lived',
        stimulus: '遭遇僵尸抓伤',
        realityOutcome: '掉血 3 点',
        valence: -0.76,
        lesson: '继续注意防备走位',
      }),
    });
    await evolveSelfFromDream(archiveDir);
    await evolveSelfFromDream(archiveDir);
    assert.equal(listSelfEvolution(archiveDir).length, 2, '重复遭遇与做梦内省不得生成重复蜕变年轮或退化回退');

    const evolveRes = await fetch(`${hub.baseUrl}/api/inner-life/evolve`, { method: 'POST', headers: hAuth, body: '{}' });
    const evolveJson = (await evolveRes.json()) as { ok: boolean; evolvingSelfMarkdown: string };
    assert.equal(evolveJson.ok, true);
    assert.ok(evolveJson.evolvingSelfMarkdown.includes('已被') && evolveJson.evolvingSelfMarkdown.includes('扬弃'));

    // 验证 MC 躯体视觉感知 observe 直接由灵魂意识决定说话与动作（去人机化闭环）
    const obsDecision = await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-cautious',
        bodyType: 'game:minecraft',
        summary: '[视觉感知] 前方 6 格发现苦力怕，手里握着 diamond_sword 身上穿有 4 件护甲',
        allowSpeak: true,
        urgency: 'high',
        modalities: [{ kind: 'telemetry', label: 'minecraft-state', data: { equippedWeapon: 'diamond_sword', backpackWeapons: ['diamond_sword'] } }],
      }),
    });
    const obsDecJson = (await obsDecision.json()) as { ok: boolean; decidedToSpeak: boolean; reply: string; actions: Array<{ name: string }> };
    assert.equal(obsDecJson.ok, true);
    assert.equal(obsDecJson.decidedToSpeak, true);
    assert.equal(obsDecJson.actions[0]?.name, 'equip_and_attack_mob');
    assert.ok(obsDecJson.reply.includes('diamond_sword'));
  } finally {
    await hub.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
