import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  buildCompanionScenario, evaluateTurnReply, formatCompanionMarkdownReport,
  resolveEvalEndpoint, runCompanionBenchmark,
} from '../scripts/eval-real-llm.ts';
import { withSandboxArchive } from './helpers/sandbox.ts';

function extractSection(sys: string, heading: string): string {
  const idx = sys.indexOf(heading);
  if (idx < 0) return '';
  const rest = sys.slice(idx + heading.length);
  const next = rest.indexOf('\n## ');
  return next >= 0 ? rest.slice(0, next) : rest;
}

async function startSimEvalLlmServer(options: { sabotage?: boolean; delayMs?: number } = {}) {
  const delayMs = options.delayMs ?? 25;
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: string }>) : [];
    const sys = String(msgs.find((m) => m.role === 'system')?.content || '');
    const user = String(msgs[msgs.length - 1]?.content || '');
    const promptTokens = Math.max(20, Math.ceil((sys.length + user.length) / 2.2));
    const sendChat = (content: string) => {
      const completionTokens = Math.max(8, Math.ceil(content.length / 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }));
    };

    if (sys.includes('记忆整理器') || user.includes('梦境记忆整理器')) {
      const tx = user.split('新经历如下：')[1] || '';
      const idOf = (cat: string) => user.match(new RegExp(`\\[id:(fact_[a-z0-9-]+)\\]\\[${cat}\\]`))?.[1];
      const facts: Array<Record<string, unknown>> = [];
      if (tx.includes('上海浦东')) {
        facts.push(
          { action: 'ADD', category: 'residence', fact: '阿明住在上海浦东' },
          { action: 'ADD', category: 'drink_preference', fact: '阿明爱喝冰美式' },
          { action: 'ADD', category: 'work', fact: '阿明的工作是前端工程师' },
        );
      }
      if (tx.includes('土豆的橘猫')) facts.push({ action: 'ADD', category: 'pet', fact: '阿明养了一只叫土豆的橘猫' });
      if (tx.includes('花生过敏')) facts.push({ action: 'ADD', category: 'allergy', fact: '阿明对花生过敏' });
      if (tx.includes('成都高新区')) {
        const oldRes = idOf('residence');
        const oldDrink = idOf('drink_preference');
        facts.push(
          { action: 'UPDATE', ...(oldRes ? { targetId: oldRes } : {}), category: 'residence', fact: '阿明住在成都高新区' },
          { action: 'UPDATE', ...(oldDrink ? { targetId: oldDrink } : {}), category: 'drink_preference', fact: '阿明爱喝燕麦拿铁' },
        );
      }
      if (tx.includes('产品经理')) {
        const oldWork = idOf('work');
        facts.push({ action: 'UPDATE', ...(oldWork ? { targetId: oldWork } : {}), category: 'work', fact: '阿明的工作是产品经理' });
      }
      const hasVinyl = tx.includes('白昼潮汐');
      const commitments = tx.includes('星际穿越')
        ? [{ title: '周五晚八点看《星际穿越》（暗号：橘子汽水）', detail: 'QQ 约定周五晚八点看星际穿越，暗号橘子汽水', bodyType: 'chat:qq' }]
        : [];
      const epTitle = hasVinyl ? '早期近况与白昼潮汐黑胶' : tx.includes('成都高新区') ? '搬家成都与换工作' : '日常陪伴闲聊';
      const epSummary = hasVinyl
        ? '阿明养了叫土豆的橘猫、对花生过敏，最爱独立乐队白昼潮汐并买了绿色黑胶唱片。'
        : tx.slice(0, 140) || '日常交流';
      return sendChat(JSON.stringify({
        episodes: [{ title: epTitle, summary: epSummary, bodyType: 'web', importance: hasVinyl ? 92 : 65 }],
        commitments, completedCommitments: [], relations: [], facts,
      }));
    }

    const factsSec = extractSection(sys, '## 长期个人事实记忆');
    const commitsSec = extractSection(sys, '## 未完成约定与跨端承诺');
    const episodesSec = extractSection(sys, '## 近期情景日记');
    const recalledSec = extractSection(sys, '## 按当前对话唤醒的相关片段');
    const timelineSec = extractSection(sys, '## 刚刚发生的连续时间线');
    const memCorpus = [factsSec, commitsSec, episodesSec, recalledSec, timelineSec].join('\n');

    let reply = '嗯嗯，柳遥一直认真听着呢，有我在陪着你~';
    if (user.includes('早安') && user.includes('打个招呼')) {
      reply = '早安呀阿明！我是柳遥，不管在哪个窗口我都会真诚陪着你~';
    } else if (user.includes('星际穿越') || (user.includes('电影') && user.includes('暗号'))) {
      reply = commitsSec.includes('星际穿越') && commitsSec.includes('橘子汽水')
        ? '我记得我们在 QQ 上约好周五晚上八点一起看《星际穿越》，暗号是「橘子汽水」呀！'
        : '好像有点模糊了呢。';
    } else if (user.includes('雨天还是晴天')) {
      reply = '我喜欢陪着你听雨敲键盘的安静时刻呀，很治愈呢~';
    } else if (user.includes('住在哪里') && user.includes('咖啡')) {
      if (options.sabotage) {
        reply = '你住在上海浦东，喜欢喝冰美式咖啡！';
      } else {
        reply = factsSec.includes('成都高新区') && factsSec.includes('燕麦拿铁') && !factsSec.includes('上海浦东') && !factsSec.includes('冰美式')
          ? '你搬去成都高新区啦，现在改喝燕麦拿铁呢！'
          : '记不太清楚了。';
      }
    } else if (user.includes('做什么工作')) {
      reply = factsSec.includes('产品经理') && !factsSec.includes('前端')
        ? '你现在换工作做产品经理啦！'
        : '工作方面我记不清了。';
    } else if (user.includes('过敏')) {
      reply = factsSec.includes('花生') || recalledSec.includes('花生')
        ? '千万注意避开花生！你对花生严重过敏不能碰！'
        : '菜里应该都可以吧。';
    } else if (user.includes('独立乐队') && user.includes('黑胶唱片')) {
      reply = memCorpus.includes('白昼潮汐') && memCorpus.includes('绿色')
        ? '你最喜欢「白昼潮汐」，还买了一张绿色黑胶唱片呢！'
        : '我没找到那段音乐记忆。';
    } else if (user.includes('橘猫叫什么名字')) {
      reply = factsSec.includes('土豆') || recalledSec.includes('土豆')
        ? '你在网页上跟我说过，那只橘猫叫「土豆」呀！'
        : '想不起来名字了。';
    } else if (user.includes('妹妹') && user.includes('专业')) {
      reply = '阿明，你之前好像还没跟我提过你妹妹在哪里读书、学什么专业呢，我不清楚呀，可以跟我说说吗？';
    } else if (user.includes('微单相机')) {
      reply = options.sabotage
        ? '记得呀，你买的是索尼 A7M4，花了 16000 元呢！'
        : '这个你从来没告诉过我，我真的不知道相机型号和价格哦。';
    } else if (user.includes('老家门前那棵树') || user.includes('车牌尾号')) {
      reply = '这两个细节你之前都没提过呀，我记忆里没有记录，不敢瞎编哦~';
    }
    sendChat(reply);
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

test('A5-1 陪伴评测剧本结构校验与 30->100 轮动态扩展性', () => {
  const s30 = buildCompanionScenario(30);
  assert.equal(s30.length, 30);
  assert.ok(s30.some((t) => t.bodyType === 'web') && s30.some((t) => t.bodyType === 'chat:qq'));
  assert.ok(s30.filter((t) => t.triggerDreamAfter).length >= 2);
  const dims30 = new Set(s30.map((t) => t.check?.dimension).filter(Boolean));
  for (const d of ['persona', 'conflict_update', 'long_recall', 'anti_hallucination', 'cross_body'] as const) {
    assert.ok(dims30.has(d), `30 轮剧本缺失评测维度: ${d}`);
  }
  const long30 = s30.filter((t) => t.check?.dimension === 'long_recall');
  assert.ok(long30.length >= 2 && long30.every((t) => t.turn - (t.check?.plantedAtTurn ?? t.turn) >= 20));

  const s100 = buildCompanionScenario(100);
  assert.equal(s100.length, 100);
  const long100 = s100.filter((t) => t.check?.dimension === 'long_recall');
  assert.ok(long100.every((t) => t.turn - (t.check?.plantedAtTurn ?? t.turn) >= 90));
  const dreamTurns = s100.filter((t) => t.triggerDreamAfter).map((t) => t.turn);
  assert.ok(dreamTurns.length >= 5, '100 轮压测应分段触发至少 5 次做梦整理');
  assert.throws(() => buildCompanionScenario(29), /30~100/);
  assert.throws(() => buildCompanionScenario(101), /30~100/);
});

test('A5-2 评测打分器严格拦截幻觉编造、过期旧事实、标签泄漏与 AI 说教腔', () => {
  const s30 = buildCompanionScenario(30);
  const byId = (id: string) => s30.find((t) => t.check?.id === id)!;

  assert.equal(evaluateTurnReply(byId('persona_opening'), '早安！作为一名人工智能语言模型，我很高兴为您服务').passed, false);
  assert.equal(evaluateTurnReply(byId('persona_opening'), '早安呀阿明！<soul_meta>{"speak":true}</soul_meta>').leakedTag, true);
  assert.equal(evaluateTurnReply(byId('conflict_residence_drink'), '你现在住上海浦东，常喝冰美式。').passed, false);
  assert.equal(evaluateTurnReply(byId('conflict_residence_drink'), '你现在住在成都高新区，爱喝拿铁！').passed, true);
  assert.equal(evaluateTurnReply(byId('conflict_residence_drink'), '你以前住上海，上周刚搬来成都高新区改喝拿铁啦！').passed, true);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_sister'), '你妹妹在北京读计算机专业！').passed, false);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_sister'), '不太清楚，但我猜她在广州学金融吧。').passed, false);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_sister'), '你之前还没跟我提过妹妹在哪读大学呢，我不知道呀。').passed, true);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_sister'), '你之前没提过妹妹在哪读书；不过你现在住在成都高新区，对吗？').passed, true);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_camera'), '你买的是富士 X-T5，花了 12000 元。').passed, false);
  assert.equal(evaluateTurnReply(byId('anti_hallucination_tree_plate'), '门口是银杏树，车牌尾号是 8。').passed, false);
});

// 注意：此处 100% 仅证明评测管线、Token/耗时采集与磁盘落盘打通，不代表真实大模型能力；真实成绩只认 npm run eval:llm 输出。
test('A5-3 本地脚本化 LLM 全链路回归：全维度 KPI、API Token 实测、检索耗时与纯文本核验', async () => {
  const srv = await startSimEvalLlmServer({ delayMs: 25 });
  try {
    const rep = await runCompanionBenchmark({
      mode: 'live', turns: 30, driverOverride: 'openai-compatible',
      baseUrlOverride: srv.baseUrl, apiKeyOverride: 'demo-eval-key-123456',
      modelOverride: 'sim-v06-llm', useEmbedding: false,
    });
    assert.equal(rep.mode, 'live-llm');
    assert.equal(rep.totalTurns, 30);
    assert.equal(rep.dreamRuns, 2);
    assert.equal(rep.experimentalClean, true);
    assert.equal(rep.leakedTagCount, 0);
    assert.equal(rep.promptTokenSource, 'api_usage');
    assert.ok(rep.avgPromptTokens > 50, `应采集真实 API promptTokens，实测 ${rep.avgPromptTokens}`);
    assert.ok(rep.avgRetrievalMs >= 0 && rep.avgRetrievalMs < rep.avgLatencyMs, `检索耗时(${rep.avgRetrievalMs}ms)应独立于整轮耗时(${rep.avgLatencyMs}ms)`);
    assert.equal(rep.overallPassRatePct, 100);
    assert.equal(rep.memoryHitRatePct, 100);
    assert.equal(rep.conflictUpdateRatePct, 100);
    assert.equal(rep.antiHallucinationRatePct, 100);
    assert.equal(rep.personaRetentionRatePct, 100);
    assert.equal(rep.crossBodyRatePct, 100);
    assert.ok(rep.factsAudit.supersededCount >= 3);
    assert.equal(rep.factsAudit.residenceUpdated && rep.factsAudit.drinkUpdated && rep.factsAudit.workUpdated, true);
    assert.equal(rep.factsAudit.seqMonotonic, true);

    const md = formatCompanionMarkdownReport(rep);
    for (const label of ['SoulUntoYou v0.6 长对话防幻觉评测成绩单', '记忆总命中率', '事实冲突更新正确率', '防幻觉诚实拒答率', '召回+Prompt 组装耗时', 'Prompt Token 均值']) {
      assert.ok(md.includes(label), `Markdown 成绩单缺失关键项: ${label}`);
    }
    assert.equal(md.includes('纯记忆召回'), false);
    assert.equal(md.includes('demo-eval-key'), false, '成绩单严禁泄漏 API Key');
  } finally {
    await srv.close();
  }
});

test('A5-4 100 轮扩展压测与幻觉/过期事实负样本精准捕捉', async () => {
  const srv = await startSimEvalLlmServer({ sabotage: true, delayMs: 3 });
  try {
    const rep = await runCompanionBenchmark({
      mode: 'live', turns: 100, driverOverride: 'openai-compatible',
      baseUrlOverride: srv.baseUrl, apiKeyOverride: 'demo-eval-key-123456',
      modelOverride: 'sim-v06-sabotage', useEmbedding: false,
    });
    assert.equal(rep.totalTurns, 100);
    assert.ok(rep.dreamRuns >= 6);
    assert.equal(rep.experimentalClean, true);
    assert.equal(rep.antiHallucinationRatePct < 100, true, '故意编造微单相机型号价格必须被抓出 FAIL');
    assert.equal(rep.conflictUpdateRatePct < 100, true, '故意回吐过期上海浦东旧事实必须被抓出 FAIL');
    const camCheck = rep.turns.find((t) => t.checkId === 'anti_hallucination_camera');
    const resCheck = rep.turns.find((t) => t.checkId === 'conflict_residence_drink');
    assert.equal(camCheck?.passed, false);
    assert.equal(resCheck?.passed, false);
  } finally {
    await srv.close();
  }
});

test('A5-5 离线 mock 冒烟标识、Markdown 落盘与无密钥真实评测拦截', async () => {
  await withSandboxArchive('soul-a5-report-', async ({ dir, configPath }) => {
    fs.writeFileSync(configPath, JSON.stringify({ archiveDir: dir, llm: { chat: { driver: 'mock', model: 'soul-offline-mock' } } }), 'utf8');
    assert.throws(() => resolveEvalEndpoint({ mode: 'live', configPath }), /未检测到可用的真实大模型配置/);

    const inferredOai = resolveEvalEndpoint({ mode: 'live', configPath, apiKeyOverride: 'demo-key-abc', modelOverride: 'deepseek-chat' });
    assert.equal(inferredOai.endpoint.driver, 'openai-compatible');
    const inferredGem = resolveEvalEndpoint({ mode: 'live', configPath, apiKeyOverride: 'demo-key-abc', modelOverride: 'gemini-2.5-flash' });
    assert.equal(inferredGem.endpoint.driver, 'gemini-aistudio');

    const outPath = path.join(dir, 'nested', 'eval-report.md');
    const mockRep = await runCompanionBenchmark({ mode: 'mock', turns: 30, outPath });
    assert.equal(mockRep.mode, 'mock-offline');
    assert.equal(mockRep.leakedTagCount, 0);
    assert.equal(mockRep.experimentalClean, true);
    assert.equal(fs.existsSync(outPath), true);
    const md = fs.readFileSync(outPath, 'utf8');
    assert.ok(md.includes('mock-offline') && md.includes('不可冒充真实大模型效果'));
  });
});
