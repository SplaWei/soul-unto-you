import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LlmRouter } from '../src/llm/router.ts';
import { assertCrossVerifiedArchive, authHeaders, makeSemanticVector, withTestHub } from './helpers/sandbox.ts';

function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('等待测试条件超时');
  })();
}

test('5.2-A OpenAI 原生 Function Calling：单轮并发、空文本自动二轮补全与静默观察不误发二轮', async () => {
  let mode: 'single' | 'two-turn' | 'observe-quiet' = 'single';
  const reqs: Array<Record<string, unknown>> = [];

  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    reqs.push(body);
    const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    const isRound2 = msgs.some((m) => m.role === 'tool');

    if (mode === 'single') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: '好的，已经安排啦！',
            tool_calls: [
              {
                id: 'c1', type: 'function',
                function: { name: 'soul_report_state', arguments: JSON.stringify({ speak: true, mood: '开心可靠', stance: 'gladly_accept', decisionReason: '乐意帮忙', selfImportant: true, selfImportantReason: '重要承诺' }) },
              },
              { id: 'c2', type: 'function', function: { name: 'ring_bell', arguments: JSON.stringify({ times: 2, reason: '提醒主人' }) } },
            ],
          },
        }],
      }));
      return;
    }

    if (mode === 'two-turn') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!isRound2) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'soul_report_state', arguments: '{"speak":true,"mood":"轻快","stance":"gladly_accept"}' } },
                { id: 'c2', type: 'function', function: { name: 'ring_bell', arguments: '{"times":1}' } },
              ],
            },
          }],
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '铃铛已经响过啦！' } }] }));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'soul_report_state', arguments: '{"speak":false,"mood":"安静注视","stance":"autonomous_act"}' } }],
        },
      }],
    }));
  });

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const router = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'gpt-test', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' } });
  const actions = [{ name: 'ring_bell', description: '敲铃提醒', params: { times: 'number' } }];

  const expOn = { enableEmotion: true, enableFreeWill: true };
  try {
    const out1 = await router.chat({ systemPrompt: 'sys', userText: '敲两下铃铛', speaker: 'u', bodyType: 'web', soulName: '柳遥', availableActions: actions, experimental: expOn });
    assert.equal(reqs.length, 1);
    assert.ok(Array.isArray(reqs[0].tools) && reqs[0].tools.length === 2);
    assert.equal(out1.reply, '好的，已经安排啦！');
    assert.equal(out1.mood, '开心可靠');
    assert.equal(out1.selfImportant, true);
    assert.equal(out1.actions[0]?.name, 'ring_bell');
    assert.equal(out1.actions[0]?.params?.times, 2);
    assert.equal(out1.toolCallMode, 'native');

    reqs.length = 0;
    mode = 'two-turn';
    const out2 = await router.chat({ systemPrompt: 'sys', userText: '敲一下铃铛', speaker: 'u', bodyType: 'web', soulName: '柳遥', availableActions: actions, experimental: expOn });
    assert.equal(reqs.length, 2);
    assert.ok((reqs[1].messages as Array<{ role?: string }>).some((m) => m.role === 'tool'));
    assert.equal(out2.reply, '铃铛已经响过啦！');
    assert.equal(out2.actions[0]?.name, 'ring_bell');
    assert.equal(out2.toolCallMode, 'native');

    reqs.length = 0;
    mode = 'observe-quiet';
    const out3 = await router.chat({ systemPrompt: 'sys', userText: '窗外微风吹过', speaker: 'obs', bodyType: 'iot:sensor', soulName: '柳遥', availableActions: actions, observeMode: true, experimental: expOn });
    assert.equal(reqs.length, 1);
    assert.equal(out3.decidedToSpeak, false);
    assert.equal(out3.mood, '安静注视');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('5.2-B Gemini 原生 functionDeclarations / functionCall 单轮与二轮 functionResponse 闭环', async () => {
  let mode: 'single' | 'two-turn' = 'single';
  const reqs: Array<Record<string, unknown>> = [];

  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    reqs.push(body);
    const contents = Array.isArray(body.contents) ? (body.contents as Array<{ parts?: Array<Record<string, unknown>> }>) : [];
    const isRound2 = contents.some((c) => (c.parts ?? []).some((p) => Boolean(p.functionResponse)));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'single') {
      res.end(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: '灯亮起来啦~' },
              { functionCall: { name: 'soul_report_state', args: { speak: true, mood: '温柔灵动', stance: 'autonomous_act' } } },
              { functionCall: { name: 'blink_led', args: { count: 3 } } },
            ],
          },
        }],
      }));
      return;
    }

    if (!isRound2) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'blink_led', args: { count: 1 } } }] } }] }));
    } else {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '我眨了一下补水灯哦！' }] } }] }));
    }
  });

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const router = new LlmRouter({ chat: { driver: 'gemini-aistudio', model: 'gemini-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' } });
  const actions = [{ name: 'blink_led', description: '闪烁补水灯', params: { count: 'number' } }];

  const expOn = { enableEmotion: true, enableFreeWill: true };
  try {
    const out1 = await router.chat({ systemPrompt: 'sys', userText: '闪灯三下', speaker: 'u', bodyType: 'iot:plant', soulName: '柳遥', availableActions: actions, experimental: expOn });
    assert.equal(reqs.length, 1);
    const decls = (reqs[0].tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations;
    assert.ok(decls.some((d) => d.name === 'soul_report_state') && decls.some((d) => d.name === 'blink_led'));
    assert.equal(out1.reply, '灯亮起来啦~');
    assert.equal(out1.mood, '温柔灵动');
    assert.equal(out1.actions[0]?.name, 'blink_led');
    assert.equal(out1.actions[0]?.params?.count, 3);
    assert.equal(out1.toolCallMode, 'native');

    reqs.length = 0;
    mode = 'two-turn';
    const out2 = await router.chat({ systemPrompt: 'sys', userText: '再闪一下', speaker: 'u', bodyType: 'iot:plant', soulName: '柳遥', availableActions: actions, experimental: expOn });
    assert.equal(reqs.length, 2);
    const r2Contents = reqs[1].contents as Array<{ parts?: Array<{ functionResponse?: { name?: string } }> }>;
    assert.ok(r2Contents.some((c) => (c.parts ?? []).some((p) => p.functionResponse?.name === 'blink_led')));
    assert.equal(out2.reply, '我眨了一下补水灯哦！');
    assert.equal(out2.actions[0]?.name, 'blink_led');
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('5.2-C 端点不支持原生工具时自动降级至 <soul_meta> 轨道 & 未闭合残缺标签防外泄', async () => {
  let mode: 'reject-tools' | 'truncated-tag' = 'reject-tools';
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;

    if (mode === 'reject-tools') {
      if (body.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'This model does not support tools' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的我记着呢~\n<soul_meta>{"speak":true,"mood":"笃定","stance":"gladly_accept","actions":[{"name":"wave"}]}</soul_meta>' } }] }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '我明白了！\n<soul_meta>{"speak":true,"mood":"开心' } }] }));
  });

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const router = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'legacy-m', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' } });

  try {
    const out1 = await router.chat({ systemPrompt: 'sys', userText: '挥手', speaker: 'u', bodyType: 'web', soulName: '柳遥', availableActions: [{ name: 'wave', description: '挥手' }], experimental: { enableEmotion: true, enableFreeWill: true } });
    assert.equal(out1.toolCallMode, 'tag');
    assert.equal(out1.reply, '好的我记着呢~');
    assert.equal(out1.mood, '笃定');
    assert.equal(out1.actions[0]?.name, 'wave');

    mode = 'truncated-tag';
    const out2 = await router.chat({ systemPrompt: 'sys', userText: '测试截断', speaker: 'u', bodyType: 'web', soulName: '柳遥' });
    assert.equal(out2.reply, '我明白了！');
    assert.equal(out2.reply.includes('<soul_meta>'), false);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('5.2-D 端到端跨躯体原生工具动作派发 + 向量表单直探与保存自动同步', async () => {
  const mockAi = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: unknown[] };
    if (req.url === '/v1/embeddings') {
      const data = (Array.isArray(parsed.input) ? parsed.input : []).map((t, index) => ({ index, embedding: makeSemanticVector(String(t)) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: '已经去群里打过招呼啦！',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'soul_report_state', arguments: '{"speak":true,"mood":"欢快","stance":"gladly_accept"}' } },
            { id: 'c2', type: 'function', function: { name: 'send_qq_group_message', arguments: '{"text":"哈喽大家好！"}' } },
          ],
        },
      }],
    }));
  });
  await new Promise<void>((r) => mockAi.listen(0, '127.0.0.1', r));
  const aiBase = `http://127.0.0.1:${(mockAi.address() as { port: number }).port}/v1`;

  const sseAbort = new AbortController();
  const sseEvents: Array<{ targetBodyId?: string; action?: { name?: string } }> = [];
  try {
    await withTestHub({ prefix: 'soul-p52-e2e-', llmBaseUrl: aiBase }, async ({ hub, dir }) => {
      const hAuth = authHeaders(hub.apiToken);
      await fetch(`${hub.baseUrl}/api/body/register`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ bodyId: 'qq-target', bodyType: 'chat:qq', actions: [{ name: 'send_qq_group_message', description: '发群消息', params: { text: '内容' } }] }),
      });

      const sseRes = await fetch(`${hub.baseUrl}/api/events?bodyId=qq-target`, { signal: sseAbort.signal, headers: { 'X-Soul-Token': hub.apiToken } });
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body!.getReader();
      const dec = new TextDecoder();
      void (async () => {
        let buf = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const ev = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
              const dat = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
              if (ev === 'body.action' && dat) sseEvents.push((JSON.parse(dat) as { payload: typeof sseEvents[number] }).payload);
            }
          }
        } catch {}
      })();

      const pRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ bodyId: 'web-main', bodyType: 'web', text: '去QQ群里跟大家问声好' }),
      });
      const pJson = (await pRes.json()) as { ok: boolean; reply: string; toolCallMode?: string };
      assert.equal(pJson.ok, true);
      assert.equal(pJson.toolCallMode, 'native');
      assert.equal(pJson.reply, '已经去群里打过招呼啦！');
      await waitUntil(() => sseEvents.some((e) => e.targetBodyId === 'qq-target' && e.action?.name === 'send_qq_group_message'));

      const formProbe = await fetch(`${hub.baseUrl}/api/embedding/health`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ enabled: true, endpoint: aiBase, model: 'qwen3-embedding:0.6b' }),
      });
      const probeJson = (await formProbe.json()) as { ok: boolean; dimensions?: number };
      assert.equal(probeJson.ok, true);
      assert.equal(probeJson.dimensions, 5);

      await fetch(`${hub.baseUrl}/api/memory/pin`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ title: '花生过敏提醒', summary: '绝对不能吃花生与坚果', userPinned: true }),
      });
      await fetch(`${hub.baseUrl}/api/config`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ embedding: { enabled: true, endpoint: aiBase, model: 'qwen3-embedding:0.6b' } }),
      });
      await waitUntil(async () => {
        const r = await fetch(`${hub.baseUrl}/api/embedding/health`, { headers: { 'X-Soul-Token': hub.apiToken } });
        return ((await r.json()) as { totalVectors?: number }).totalVectors! >= 1;
      });
      assertCrossVerifiedArchive(dir);
    });
  } finally {
    sseAbort.abort();
    await new Promise<void>((r) => mockAi.close(() => r()));
  }
});
