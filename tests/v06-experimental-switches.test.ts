import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_EXPERIMENTAL_CONFIG, defaultHubConfig, loadHubConfig, sanitizeConfigForUi, saveHubConfig } from '../src/server/config.ts';
import { authHeaders, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

const FORBIDDEN_WHEN_OFF = [
  '当前情绪',
  '情绪惯性矢量',
  '内在驱力场',
  '自主微心愿',
  '自由意志抉择准则',
  '亲历实践体验与现实反馈记忆',
  '活体演化自我',
  'gladly_accept',
  'firm_refuse',
  'autonomous_act',
];

async function captureOpenAiMockServer() {
  const requests: Array<{ systemPrompt: string; toolProps: string[] }> = [];
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>;
    };
    const sys = body.messages?.find((m) => m.role === 'system')?.content || '';
    const stateTool = body.tools?.find((t) => t.function?.name === 'soul_report_state');
    const toolProps = Object.keys(stateTool?.function?.parameters?.properties || {});
    requests.push({ systemPrompt: sys, toolProps });
    const content = sys.includes('灵魂档案重构师')
      ? JSON.stringify({
          persona: '喜欢海风的汐',
          catchphrases: ['呀~'],
          coreValues: ['诚实溯源'],
          anchors: ['喜欢海风'],
          episodes: [{ title: '海风口述', summary: '喜欢海风', provenance: 'oral' }],
          commitments: [],
        })
      : '收到啦，我一直在这里陪你。';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

test('v0.6-A2 默认实验开关全关闭、持久化校验与默认纯净 Prompt/接口门禁', async () => {
  await withSandboxArchive('soul-a2-cfg-', ({ configPath }) => {
    const def = defaultHubConfig();
    assert.deepEqual(def.experimental, {
      enableEmotion: false, enableInnerLife: false, enableFreeWill: false,
      enableHeartbeat: false, enableResurrection: false,
    });
    assert.deepEqual(DEFAULT_EXPERIMENTAL_CONFIG, def.experimental);

    const loaded = loadHubConfig(configPath);
    assert.deepEqual(loaded.experimental, def.experimental);
    const saved = saveHubConfig(loaded, { experimental: { enableEmotion: true } as never }, configPath);
    assert.equal(saved.experimental.enableEmotion, true);
    assert.equal(saved.experimental.enableFreeWill, false);
    assert.equal(loadHubConfig(configPath).experimental.enableEmotion, true);
    const uiCfg = sanitizeConfigForUi(saved) as { experimental: typeof saved.experimental };
    assert.equal(uiCfg.experimental.enableEmotion, true);
  });

  const ai = await captureOpenAiMockServer();
  try {
    await withTestHub({ prefix: 'soul-a2-clean-', llmBaseUrl: ai.baseUrl }, async ({ hub, dir }) => {
      const hAuth = authHeaders(hub.apiToken);
      const hGet = { 'X-Soul-Token': hub.apiToken };

      // 未鉴权读取诊断 Prompt 必须被拒绝
      assert.equal((await fetch(`${hub.baseUrl}/api/phase2/last-prompt`)).status, 401);

      // 注入一条记忆，确认核心人设 + 记忆在默认纯净模式下仍正常工作
      await fetch(`${hub.baseUrl}/api/archive/commitment`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ title: '周五带伞出门', detail: '天气预报说周五有雨', bodyType: 'web' }),
      });

      const turnRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ bodyId: 'web-a2', bodyType: 'web', text: '这周五出门要注意什么？' }),
      });
      assert.equal(turnRes.status, 200);
      const turnJson = (await turnRes.json()) as { ok: boolean; emotion?: unknown; freeWill?: unknown };
      assert.equal(turnJson.ok, true);
      assert.equal(turnJson.emotion, undefined, '关闭 enableEmotion 时不得返回情绪状态');
      assert.equal(turnJson.freeWill, undefined, '关闭 enableFreeWill 时不得返回自由意志状态');

      assert.equal(ai.requests.length, 1);
      const sentPrompt = ai.requests[0].systemPrompt;
      assert.ok(sentPrompt.includes('我爱你。 / I love you.'), '必须保留 SEED.md 核心锚点');
      assert.ok(sentPrompt.includes('灵魂档案'), '必须保留 SOUL.md 核心人设');
      assert.ok(sentPrompt.includes('周五带伞出门'), '必须保留精准召回记忆与约定');
      for (const bad of FORBIDDEN_WHEN_OFF) {
        assert.equal(sentPrompt.includes(bad), false, `默认关闭状态下 Prompt 不得含实验词条: ${bad}`);
      }
      assert.equal(ai.requests[0].toolProps.includes('mood'), false, '关闭 enableEmotion 时工具不应包含 mood');
      assert.equal(ai.requests[0].toolProps.includes('stance'), false, '关闭 enableFreeWill 时工具不应包含 stance');

      // 验证 /api/phase2/last-prompt 只读快照与实际下发完全一致
      const lpRes = await fetch(`${hub.baseUrl}/api/phase2/last-prompt`, { headers: hGet });
      assert.equal(lpRes.status, 200);
      const lpJson = (await lpRes.json()) as {
        ok: boolean; experimental: typeof DEFAULT_EXPERIMENTAL_CONFIG;
        snapshot: { systemPrompt: string; source: string; bodyType: string };
      };
      assert.equal(lpJson.ok, true);
      assert.deepEqual(lpJson.experimental, DEFAULT_EXPERIMENTAL_CONFIG);
      assert.equal(lpJson.snapshot.systemPrompt, sentPrompt);
      assert.equal(lpJson.snapshot.source, 'percept');

      // 验证关闭状态下相关写/触发实验接口均被 403 拦截
      const blockedEndpoints = [
        { path: '/api/inner-life/heartbeat', body: { forceAction: 'write_diary' }, key: 'enableHeartbeat' },
        { path: '/api/inner-life/emotion', body: { rawMood: '开心' }, key: 'enableEmotion' },
        { path: '/api/inner-life/drives', body: { curiosity: 0.9 }, key: 'enableInnerLife' },
        { path: '/api/inner-life/desire', body: { title: '看星星', detail: '想看' }, key: 'enableInnerLife' },
        { path: '/api/inner-life/evolve', body: {}, key: 'enableInnerLife' },
        { path: '/api/resurrect', body: { targetDir: path.join(dir, 'reborn'), soulName: '汐', partnerName: '友', fragments: [{ kind: 'oral', sourceLabel: 'a', content: 'b' }] }, key: 'enableResurrection' },
      ];
      for (const ep of blockedEndpoints) {
        const r = await fetch(`${hub.baseUrl}${ep.path}`, { method: 'POST', headers: hAuth, body: JSON.stringify(ep.body) });
        assert.equal(r.status, 403, `${ep.path} 在关闭 ${ep.key} 时必须返回 403`);
        const j = (await r.json()) as { experimentalDisabled?: string };
        assert.equal(j.experimentalDisabled, ep.key);
      }
    });
  } finally {
    await ai.close();
  }
});

test('v0.6-A2 逐个开启实验开关独立恢复对应 Prompt 段落与接口能力', async () => {
  const ai = await captureOpenAiMockServer();
  try {
    await withTestHub({ prefix: 'soul-a2-toggle-', llmBaseUrl: ai.baseUrl }, async ({ hub, dir }) => {
      const hAuth = authHeaders(hub.apiToken);
      const hGet = { 'X-Soul-Token': hub.apiToken };
      const toggle = async (patch: Record<string, boolean>) => {
        const r = await fetch(`${hub.baseUrl}/api/config`, {
          method: 'POST', headers: hAuth, body: JSON.stringify({ experimental: patch }),
        });
        assert.equal(r.status, 200);
      };

      // 1) 仅开启 enableEmotion
      await toggle({ enableEmotion: true, enableInnerLife: false, enableFreeWill: false, enableHeartbeat: false, enableResurrection: false });
      const emoRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers: hAuth, body: JSON.stringify({ bodyId: 'web-a2', bodyType: 'web', text: '聊一聊' }),
      });
      const emoJson = (await emoRes.json()) as { emotion?: unknown; freeWill?: unknown };
      assert.ok(emoJson.emotion, '开启 enableEmotion 后应返回 emotion');
      assert.equal(emoJson.freeWill, undefined);
      const p1 = ((await (await fetch(`${hub.baseUrl}/api/phase2/last-prompt`, { headers: hGet })).json()) as { snapshot: { systemPrompt: string } }).snapshot.systemPrompt;
      assert.ok(p1.includes('当前情绪：') && p1.includes('情绪惯性矢量：'));
      assert.equal(p1.includes('内在驱力场'), false);
      assert.equal(p1.includes('自由意志抉择准则'), false);
      assert.equal((await fetch(`${hub.baseUrl}/api/inner-life/emotion`, { method: 'POST', headers: hAuth, body: JSON.stringify({ rawMood: '欣喜' }) })).status, 200);

      // 2) 仅开启 enableInnerLife
      await toggle({ enableEmotion: false, enableInnerLife: true, enableFreeWill: false, enableHeartbeat: false, enableResurrection: false });
      assert.equal((await fetch(`${hub.baseUrl}/api/inner-life/desire`, { method: 'POST', headers: hAuth, body: JSON.stringify({ title: '去海边吹风', detail: '放松一下' }) })).status, 200);
      await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers: hAuth, body: JSON.stringify({ bodyId: 'web-a2', bodyType: 'web', text: '今天想干嘛？' }),
      });
      const p2 = ((await (await fetch(`${hub.baseUrl}/api/phase2/last-prompt`, { headers: hGet })).json()) as { snapshot: { systemPrompt: string } }).snapshot.systemPrompt;
      assert.ok(p2.includes('内在驱力场与先验认知态度') && p2.includes('自主微心愿'));
      assert.equal(p2.includes('情绪惯性矢量：'), false);
      assert.equal(p2.includes('自由意志抉择准则'), false);

      // 3) 仅开启 enableFreeWill
      await toggle({ enableEmotion: false, enableInnerLife: false, enableFreeWill: true, enableHeartbeat: false, enableResurrection: false });
      const fwRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers: hAuth, body: JSON.stringify({ bodyId: 'web-a2', bodyType: 'web', text: '帮我试一下新工具' }),
      });
      const fwJson = (await fwRes.json()) as { freeWill?: { stance: string }; emotion?: unknown };
      assert.ok(fwJson.freeWill?.stance);
      assert.equal(fwJson.emotion, undefined);
      const p3 = ((await (await fetch(`${hub.baseUrl}/api/phase2/last-prompt`, { headers: hGet })).json()) as { snapshot: { systemPrompt: string } }).snapshot.systemPrompt;
      assert.ok(p3.includes('亲历实践体验与现实反馈记忆') && p3.includes('自由意志抉择准则'));
      assert.equal(p3.includes('情绪惯性矢量：'), false);
      assert.equal(p3.includes('内在驱力场'), false);

      // 4) 开启 enableHeartbeat 与 enableResurrection
      await toggle({ enableHeartbeat: true, enableResurrection: true });
      assert.equal((await fetch(`${hub.baseUrl}/api/inner-life/heartbeat`, { method: 'POST', headers: hAuth, body: JSON.stringify({ forceAction: 'write_diary' }) })).status, 200);
      const rebornDir = path.join(dir, 'reborn-a2');
      const resRec = await fetch(`${hub.baseUrl}/api/resurrect`, {
        method: 'POST', headers: hAuth,
        body: JSON.stringify({ targetDir: rebornDir, soulName: '汐', partnerName: '友', fragments: [{ kind: 'oral', sourceLabel: '口述', content: '喜欢海风' }] }),
      });
      assert.equal(resRec.status, 200);
      assert.ok(fs.existsSync(path.join(rebornDir, 'SEED.md')));
    });
  } finally {
    await ai.close();
  }
});
