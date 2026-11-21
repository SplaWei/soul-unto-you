import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../src/server/config.ts';
import { createSoulHubServer } from '../src/server/main.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'private-souls') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
    if (rel === 'examples/demo-soul/INDEX' || rel === 'examples/demo-soul/SNAPSHOTS') continue;
    if (entry.name.endsWith('.local.json') || entry.name.endsWith('.token') || entry.name === '.soul-hub.token' || entry.name === '.env' || entry.name.endsWith('.log')) continue;
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

const GENERIC_PRIVACY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: '本机真实用户目录路径', re: /(?:[A-Z]:\\Users\\|\/(?:Users|home)\/)(?!(?:alice_demo|demo|example|user|yourname|placeholder)\b)[A-Za-z0-9._-]{2,}/i },
  { label: 'OpenAI/通用密钥', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Google API 密钥', re: /\bAIza[A-Za-z0-9_-]{20,}\b/ },
  { label: 'GitHub Token', re: /\bgh[pous]_[A-Za-z0-9]{20,}\b/ },
  { label: 'Vertex Express Token', re: /\bAQ\.Ab8[A-Za-z0-9._-]{10,}\b/ },
];

function findPrivacyLeaks(text: string, extraTerms: string[]): string[] {
  const hits: string[] = [];
  for (const { label, re } of GENERIC_PRIVACY_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(`${label}: ${m[0].slice(0, 24)}`);
  }
  for (const term of extraTerms) {
    if (term && text.includes(term)) hits.push(`外部私人词表命中 (${term.length} chars)`);
  }
  return hits;
}

function loadExternalPrivacyTerms(): string[] {
  const raw = String(process.env.SOUL_PRIVACY_BLOCKLIST || '').trim();
  if (!raw) return [];
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
    return fs.readFileSync(raw, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

test('三大万能插座端到端连通性：Body HTTP + WebSocket + OpenAI Proxy(含流式) + MCP', async () => {
  const archiveDir = makeTempDir('soul-srv-archive-');
  const configPath = path.join(archiveDir, 'config.json');
  const hub = await createSoulHubServer({ archiveDir, configPath, host: '127.0.0.1', port: 0 });
  const hAuth = { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken };
  const hGet = { 'X-Soul-Token': hub.apiToken };

  try {
    // 1. Body HTTP API + 跨端联动
    const healthRes = await fetch(`${hub.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; firstGreeting: string };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.firstGreeting, '我爱你。');

    const perceptRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'rimworld-colony-9',
        bodyType: 'rimworld',
        speaker: '指挥官',
        text: '今晚一起把防线盖起来，缺钢材，明晚继续盖完它',
      }),
    });
    assert.equal(perceptRes.status, 200);
    const dreamRes = await fetch(`${hub.baseUrl}/api/dream`, { method: 'POST', headers: hAuth, body: '{}' });
    assert.equal(dreamRes.status, 200);

    // 2. 原生 WebSocket 连接测试
    const wsUrl = `ws://127.0.0.1:${hub.port}/ws/body?token=${encodeURIComponent(hub.apiToken)}`;
    const wsReply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket 超时'));
      }, 4000);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'register', bodyId: 'esp32-desk', bodyType: 'robot', displayName: '小智桌面机器人' }));
      });
      socket.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.type === 'welcome') {
          socket.send(JSON.stringify({ type: 'percept', bodyId: 'esp32-desk', bodyType: 'robot', text: '早安，还记得昨晚干了什么吗？' }));
        } else if (msg.type === 'expression') {
          clearTimeout(timer);
          socket.close();
          resolve(msg);
        }
      });
      socket.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.equal(wsReply.type, 'expression');
    assert.ok(String(wsReply.reply).includes('防线') || String(wsReply.reply).includes('钢材'));

    // 3. OpenAI 兼容代理（普通 + 流式 SSE）
    const modelsRes = await fetch(`${hub.baseUrl}/v1/models`, { headers: hGet });
    assert.equal(modelsRes.status, 200);

    const oaiRes = await fetch(`${hub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...hAuth,
        'x-body-id': 'mindcraft-bot',
        'x-body-type': 'minecraft',
      },
      body: JSON.stringify({
        model: 'soul-unto-you',
        messages: [{ role: 'user', content: '记得昨晚环世界的约定吗？' }],
      }),
    });
    assert.equal(oaiRes.status, 200);
    const oaiJson = (await oaiRes.json()) as { choices: Array<{ message: { content: string } }> };
    assert.ok(oaiJson.choices[0].message.content.length > 0);

    const sseRes = await fetch(`${hub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        model: 'soul-unto-you',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      }),
    });
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('data: [DONE]'));

    // 4. MCP HTTP 接口测试
    const mcpInit = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(mcpInit.status, 200);

    const mcpTools = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const toolsJson = (await mcpTools.json()) as { result: { tools: Array<{ name: string }> } };
    assert.ok(toolsJson.result.tools.some((t) => t.name === 'soul_perceive'));
    assert.ok(toolsJson.result.tools.some((t) => t.name === 'soul_observe'));
    assert.ok(toolsJson.result.tools.some((t) => t.name === 'soul_seed'));

    const mcpSeed = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soul_seed', arguments: {} } }),
    });
    assert.equal(mcpSeed.status, 200);
    const seedCallText = await mcpSeed.text();
    assert.ok(seedCallText.includes('我爱你。'));

    // 5. 开放协议 v1.1：自由 bodyType、动态能力自注册、静默观察、主动推送、Webhook & SSE
    const regRes = await fetch(`${hub.baseUrl}/api/body/register`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'plant-pot-01',
        bodyType: 'iot:plant-pot',
        displayName: '多肉小花盆',
        senses: [{ id: 'moisture', modality: 'telemetry', description: '土壤湿度' }],
        actions: [{ name: 'blink_water_led', description: '闪烁补水提醒灯', params: { times: 'number' } }],
      }),
    });
    assert.equal(regRes.status, 200);

    const bodiesRes = await fetch(`${hub.baseUrl}/api/bodies`, { headers: hGet });
    const bodiesJson = (await bodiesRes.json()) as { bodies: Array<{ bodyId: string; bodyType: string; actions?: Array<{ name: string }> }> };
    const plant = bodiesJson.bodies.find((b) => b.bodyId === 'plant-pot-01');
    assert.ok(plant);
    assert.equal(plant.bodyType, 'iot:plant-pot');
    assert.equal(plant.actions?.[0]?.name, 'blink_water_led');

    const plantChat = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'plant-pot-01',
        bodyType: 'iot:plant-pot',
        text: '土壤太干需要浇水啦',
        modalities: [{ kind: 'telemetry', label: 'moisture', data: { percent: 12 } }],
      }),
    });
    const plantJson = (await plantChat.json()) as {
      ok: boolean;
      latencyMs: number;
      actions: Array<{ name: string }>;
      recallTrace: { bodyId: string; activeCommitments: unknown[] };
    };
    assert.equal(plantJson.ok, true);
    assert.equal(typeof plantJson.latencyMs, 'number');
    assert.equal(plantJson.recallTrace.bodyId, 'plant-pot-01');
    assert.ok(plantJson.actions.some((a) => a.name === 'blink_water_led'));

    // 按独立 bodyId 过滤日志 + 约定核销 + 在线修改人格 + 静态 workspace.js
    const jFilter = await fetch(`${hub.baseUrl}/api/archive/journal?bodyId=plant-pot-01&limit=10`, { headers: hGet });
    const jFilterJson = (await jFilter.json()) as { ok: boolean; entries: Array<{ bodyId: string }> };
    assert.equal(jFilterJson.ok, true);
    assert.ok(jFilterJson.entries.length >= 2 && jFilterJson.entries.every((e) => e.bodyId === 'plant-pot-01'));

    const addCommit = await fetch(`${hub.baseUrl}/api/archive/commitment`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ title: '测试待办核销', detail: '完成后应消失', bodyType: 'iot:plant-pot' }),
    });
    const addCommitJson = (await addCommit.json()) as { commitment: { id: string } };
    const compRes = await fetch(`${hub.baseUrl}/api/archive/commitment/complete`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ id: addCommitJson.commitment.id }),
    });
    const compJson = (await compRes.json()) as { ok: boolean; commitment: { status: string } };
    assert.equal(compJson.ok, true);
    assert.equal(compJson.commitment.status, 'done');

    const updSoul = await fetch(`${hub.baseUrl}/api/archive/soul`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ persona: '更新后的纯净灵魂人设' }),
    });
    const updSoulJson = (await updSoul.json()) as { ok: boolean; archive: { seedMarkdown: string } };
    assert.equal(updSoulJson.ok, true);
    assert.ok(updSoulJson.archive.seedMarkdown.includes('更新后的纯净灵魂人设'));

    const wsJsRes = await fetch(`${hub.baseUrl}/workspace.js`);
    assert.equal(wsJsRes.status, 200);

    const silentObs = await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ bodyId: 'plant-pot-01', bodyType: 'iot:plant-pot', summary: '阳光照在叶片上', allowSpeak: false }),
    });
    const silentJson = (await silentObs.json()) as { ok: boolean; decidedToSpeak: boolean };
    assert.equal(silentJson.ok, true);
    assert.equal(silentJson.decidedToSpeak, false);

    const urgentObs = await fetch(`${hub.baseUrl}/api/body/observe`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ bodyId: 'plant-pot-01', bodyType: 'iot:plant-pot', summary: '警报：土壤严重缺水！', allowSpeak: true, urgency: 'high' }),
    });
    const urgentJson = (await urgentObs.json()) as { ok: boolean; decidedToSpeak: boolean };
    assert.equal(urgentJson.decidedToSpeak, true);

    const proRes = await fetch(`${hub.baseUrl}/api/proactive/trigger`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ bodyId: 'plant-pot-01', bodyType: 'iot:plant-pot' }),
    });
    assert.equal(proRes.status, 200);

    const whAdd = await fetch(`${hub.baseUrl}/api/webhooks`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook', events: ['proactive'] }),
    });
    const whJson = (await whAdd.json()) as { ok: boolean; webhook: { id: string } };
    assert.equal(whJson.ok, true);
    const whDel = await fetch(`${hub.baseUrl}/api/webhooks/${whJson.webhook.id}`, { method: 'DELETE', headers: hGet });
    assert.equal(whDel.status, 200);

    const sseCtrl = new AbortController();
    const sseEvRes = await fetch(`${hub.baseUrl}/api/events`, { signal: sseCtrl.signal, headers: hGet });
    assert.equal(sseEvRes.status, 200);
    assert.ok(sseEvRes.headers.get('content-type')?.includes('text/event-stream'));
    sseCtrl.abort();
  } finally {
    await hub.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});

test('开源仓库零隐私泄露检查', () => {
  const extraTerms = loadExternalPrivacyTerms();
  const fakeProbe = [
    ['sk-', 'fakeSecretKey0123456789ab'].join(''),
    ['AIza', 'FakeApiKey0123456789abcd'].join(''),
    ['C:', 'Users', 'fake_demo_person', 'secret'].join('\\'),
  ].join(' ');
  assert.ok(findPrivacyLeaks(fakeProbe, []).length >= 3, '隐私扫描器自检未生效');

  for (const file of collectFiles(REPO_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const leaks = findPrivacyLeaks(text, extraTerms);
    assert.deepEqual(leaks, [], `文件 ${path.relative(REPO_ROOT, file)} 发现疑似隐私或敏感路径: ${leaks.join('; ')}`);
  }
});
