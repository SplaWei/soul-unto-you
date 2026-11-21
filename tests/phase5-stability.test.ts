import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createQqOneBotAdapter, defaultQqAdapterConfig } from '../adapters/qq-onebot/main.ts';
import { OneBotClient } from '../adapters/qq-onebot/onebot-client.ts';
import { LlmRouter } from '../src/llm/router.ts';
import { SimpleWsServer } from '../src/server/ws.ts';
import { assertCrossVerifiedArchive, authHeaders, withTestHub } from './helpers/sandbox.ts';

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

async function postJson<T>(url: string, body: unknown, token: string): Promise<{ status: number; data: T }> {
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

test('5.1-A LLM fallbackModels 自动降级重试（429/503/超时/400坏模型）与 401 快速失败/透明报错', async () => {
  const calls: string[] = [];
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = req.url || '';

    if (url.startsWith('/v1beta/models/')) {
      const m = url.match(/\/v1beta\/models\/([^:]+):generateContent/)?.[1] || '';
      calls.push(`gemini:${m}`);
      if (m === 'gem-bad400') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model not found or not supported' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini备用成功<soul_meta>{"speak":true,"mood":"平静"}</soul_meta>' }] } }] }));
      return;
    }

    const body = JSON.parse(raw || '{}') as { model?: string };
    const m = String(body.model || '');
    calls.push(`oai:${m}`);
    if (m === 'm-rate') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
    } else if (m === 'm-down') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'backend overloaded' } }));
    } else if (m === 'm-unauth') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    } else if (m === 'm-slow') {
      await new Promise((r) => setTimeout(r, 280));
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '慢响应' } }] }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `已由${m}接管回复<soul_meta>{"speak":true,"mood":"安心"}</soul_meta>` } }] }));
    }
  });

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const turnBase = { systemPrompt: 'sys', userText: 'hi', speaker: 'u', bodyType: 'web', soulName: '柳遥' };

    const r1 = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'm-rate', fallbackModels: ['m-down', 'm-ok'], baseUrl: `${baseUrl}/v1`, apiKey: 'k' } });
    const out1 = await r1.chat(turnBase);
    assert.equal(out1.model, 'm-ok');
    assert.equal(out1.fallbackFrom, 'm-rate');
    assert.deepEqual(out1.attemptedModels, ['m-rate', 'm-down', 'm-ok']);

    const rTimeout = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'm-slow', fallbackModels: ['m-ok'], baseUrl: `${baseUrl}/v1`, apiKey: 'k', timeoutMs: 120 } });
    const outTimeout = await rTimeout.chat(turnBase);
    assert.equal(outTimeout.model, 'm-ok');
    assert.equal(outTimeout.fallbackFrom, 'm-slow');

    const rGem = new LlmRouter({ chat: { driver: 'gemini-aistudio', model: 'gem-bad400', fallbackModels: ['gem-ok'], baseUrl, apiKey: 'k' } });
    const outGem = await rGem.chat(turnBase);
    assert.equal(outGem.model, 'gem-ok');
    assert.equal(outGem.fallbackFrom, 'gem-bad400');

    calls.length = 0;
    const r401 = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'm-unauth', fallbackModels: ['m-ok'], baseUrl: `${baseUrl}/v1`, apiKey: 'bad' } });
    await assert.rejects(() => r401.chat(turnBase), (e: Error) => e.message.includes('401') && e.message.includes('m-unauth'));
    assert.deepEqual(calls, ['oai:m-unauth']);

    const rFailAll = new LlmRouter({ chat: { driver: 'openai-compatible', model: 'm-rate', fallbackModels: ['m-down'], baseUrl: `${baseUrl}/v1`, apiKey: 'k' } });
    await assert.rejects(
      () => rFailAll.chat(turnBase),
      (e: Error) => e.message.includes('m-rate') && e.message.includes('429') && e.message.includes('m-down') && e.message.includes('503'),
    );
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('5.1-B 系统/游戏指令噪声过滤、躯体自声明 noisePatterns 与真实体感反馈免过滤', async () => {
  await withTestHub({ prefix: 'soul-p51-noise-' }, async ({ hub, dir }) => {
    for (const noise of [
      'Set own game mode to Creative Mode',
      'Teleported Player to 0, 64, 0',
      '§7[Server] Saving...',
      '已将时间设为 1000',
    ]) {
      const r = await postJson<{ ok: boolean; filtered?: boolean; decidedToSpeak: boolean }>(`${hub.baseUrl}/api/body/observe`, {
        bodyId: 'game-bot', bodyType: 'game:sandbox', summary: noise, allowSpeak: false,
      }, hub.apiToken);
      assert.equal(r.status, 200);
      assert.equal(r.data.filtered, true);
      assert.equal(r.data.decidedToSpeak, false);
    }

    await postJson(`${hub.baseUrl}/api/body/register`, {
      bodyId: 'factory-bot', bodyType: 'robot:factory', displayName: '工厂机械臂', noisePatterns: ['^HEARTBEAT_PING'],
    }, hub.apiToken);

    const customNoise = await postJson<{ filtered?: boolean }>(`${hub.baseUrl}/api/body/observe`, {
      bodyId: 'factory-bot', bodyType: 'robot:factory', summary: 'HEARTBEAT_PING #42', allowSpeak: false,
    }, hub.apiToken);
    assert.equal(customNoise.data.filtered, true);

    const normalEvt = await postJson<{ filtered?: boolean }>(`${hub.baseUrl}/api/body/observe`, {
      bodyId: 'factory-bot', bodyType: 'robot:factory', summary: '机械臂完成校准', allowSpeak: false,
    }, hub.apiToken);
    assert.ok(!normalEvt.data.filtered);

    const rfEvt = await postJson<{ filtered?: boolean; recordedExperience?: unknown }>(`${hub.baseUrl}/api/body/observe`, {
      bodyId: 'game-bot', bodyType: 'game:sandbox', summary: 'Killed by hazard', allowSpeak: false,
      metadata: {
        realityFeedback: {
          origin: 'lived', stimulus: '高压危险区域', chosenAction: '直接闯入',
          realityOutcome: '受重伤倒下', valence: -0.9, arousal: 0.9, lesson: '先检查防护再靠近危险区',
        },
      },
    }, hub.apiToken);
    assert.ok(!rfEvt.data.filtered);
    assert.ok(rfEvt.data.recordedExperience);

    const jRes = await fetch(`${hub.baseUrl}/api/archive/journal?limit=50`, { headers: { 'X-Soul-Token': hub.apiToken } });
    const jJson = (await jRes.json()) as { entries: Array<{ text: string }> };
    const texts = jJson.entries.map((e) => e.text);
    assert.equal(texts.some((t) => /Creative Mode|Teleported|Saving|已将时间设为|HEARTBEAT_PING/.test(t)), false);
    assert.ok(texts.some((t) => t.includes('机械臂完成校准')));
    assert.ok(texts.some((t) => t.includes('Killed by hazard')));
    assertCrossVerifiedArchive(dir);
  });
});

test('5.1-C 慢 LLM 移出 withSoulLock：并发 observe/commitment 不被 450ms 慢模型阻塞', async () => {
  const slowAi = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === '/v1/chat/completions') {
      await new Promise((r) => setTimeout(r, 450));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '慢模型回应完成<soul_meta>{"speak":true,"mood":"平静"}</soul_meta>' } }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => slowAi.listen(0, '127.0.0.1', r));
  const port = (slowAi.address() as { port: number }).port;

  try {
    await withTestHub({ prefix: 'soul-p51-lock-', llmBaseUrl: `http://127.0.0.1:${port}/v1` }, async ({ hub, dir }) => {
      const slowPercept = postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'web-main', bodyType: 'web', text: '帮我思考一个复杂问题',
      }, hub.apiToken);

      await new Promise((r) => setTimeout(r, 40));
      const t0 = Date.now();
      const [obsRes, commitRes] = await Promise.all([
        postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/observe`, {
          bodyId: 'sensor-1', bodyType: 'iot:sensor', summary: '室温 24 度，光线温和', allowSpeak: false,
        }, hub.apiToken),
        postJson<{ ok: boolean }>(`${hub.baseUrl}/api/archive/commitment`, {
          title: '并发短锁校验约定', detail: '验证慢 LLM 不阻塞其他写入', bodyType: 'web',
        }, hub.apiToken),
      ]);
      const fastElapsed = Date.now() - t0;

      assert.equal(obsRes.status, 200);
      assert.equal(commitRes.status, 200);
      assert.ok(fastElapsed < 280, `并发 observe/commitment 不应被 450ms 慢模型阻塞，实际耗时 ${fastElapsed}ms`);

      const slowDone = await slowPercept;
      assert.equal(slowDone.status, 200);
      assert.equal(slowDone.data.ok, true);
      assertCrossVerifiedArchive(dir);
    });
  } finally {
    await new Promise<void>((r) => slowAi.close(() => r()));
  }
});

test('5.1-D QQ 适配器透明 HTTP 报错、SSE 非 200 自动重连与防风控清晰中文原因日志', async () => {
  let sseHits = 0;
  const openSseStreams = new Set<http.ServerResponse>();
  const mockHub = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    const url = req.url || '';
    if (url === '/api/body/register') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (url === '/api/body/observe') {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>Bad Gateway</html>');
    } else if (url.startsWith('/api/events')) {
      sseHits += 1;
      if (sseHits === 1) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(': keepalive\n\n');
        openSseStreams.add(res);
        res.on('close', () => openSseStreams.delete(res));
      }
    } else {
      res.writeHead(404).end('not found');
    }
  });

  const mockOneBotHttp = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'onebot internal error' }));
  });

  const mockObWs = new SimpleWsServer(() => {});
  const obWsSrv = http.createServer((_, res) => res.writeHead(404).end());
  obWsSrv.on('upgrade', (req, sock) => mockObWs.handleUpgrade(req, sock));

  await Promise.all([
    new Promise<void>((r) => mockHub.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => mockOneBotHttp.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => obWsSrv.listen(0, '127.0.0.1', r)),
  ]);
  const hubPort = (mockHub.address() as { port: number }).port;
  const obHttpPort = (mockOneBotHttp.address() as { port: number }).port;
  const obWsPort = (obWsSrv.address() as { port: number }).port;

  const logs: string[] = [];
  const cfg = defaultQqAdapterConfig();
  cfg.soulHubUrl = `http://127.0.0.1:${hubPort}`;
  cfg.onebot.wsUrl = `ws://127.0.0.1:${obWsPort}`;
  cfg.onebot.httpUrl = '';
  cfg.guard.allowedUsers = ['10001'];
  cfg.guard.allowedGroups = ['20001'];
  cfg.guard.conflictCheckPorts = [];

  const adapter = createQqOneBotAdapter(cfg, { logger: (line) => logs.push(line), sseRetryMs: 40 });
  const obClient = new OneBotClient({ endpoint: { wsUrl: '', httpUrl: `http://127.0.0.1:${obHttpPort}` }, onMessage: () => {} });

  try {
    await assert.rejects(
      () => obClient.callAction('get_login_info'),
      (e: Error) => e.message.includes('500') && e.message.includes('onebot internal error'),
    );

    await adapter.start();
    await waitUntil(() => mockObWs.clientCount() === 1 && sseHits >= 2, 3500);

    const nowSec = Math.floor(Date.now() / 1000) + 1;
    mockObWs.broadcastJson({ post_type: 'message', message_type: 'private', user_id: 88888, self_id: 90001, message_id: 1, time: nowSec, message: 'hi' });
    mockObWs.broadcastJson({ post_type: 'message', message_type: 'group', group_id: 99999, user_id: 10001, self_id: 90001, message_id: 2, time: nowSec, message: 'hi' });
    mockObWs.broadcastJson({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: 90001, message_id: 3, time: nowSec, message: '群聊闲聊' });

    await waitUntil(() => logs.some((l) => l.includes('HTTP 502')) && logs.filter((l) => l.includes('防风控已拦截')).length >= 2, 3500);
    assert.ok(logs.some((l) => l.includes('防风控已拦截') && l.includes('不在私聊白名单内')));
    assert.ok(logs.some((l) => l.includes('防风控已拦截') && l.includes('不在群聊白名单内')));
    assert.ok(logs.some((l) => l.includes('HTTP 502') && l.includes('Bad Gateway')));
    assert.ok(logs.some((l) => l.includes('503') && l.includes('重连')));
    assert.ok(sseHits >= 2);
  } finally {
    adapter.stop();
    obClient.close();
    for (const s of openSseStreams) s.end();
    mockObWs.closeAll();
    await Promise.all([
      new Promise<void>((r) => mockHub.close(() => r())),
      new Promise<void>((r) => mockOneBotHttp.close(() => r())),
      new Promise<void>((r) => obWsSrv.close(() => r())),
    ]);
  }
});
