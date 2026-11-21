import assert from 'node:assert/strict';
import test from 'node:test';
import { FIRST_AWAKENING_ZH } from '../src/soul/covenant.ts';
import { assertCrossVerifiedArchive, authHeaders, withMockAiServer, withTestHub } from './helpers/sandbox.ts';

async function postJson<T>(url: string, body: unknown, token: string, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token, headers),
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

test('交叉验证 1：四向协议互通 (HTTP ↔ WS ↔ OpenAI Proxy ↔ MCP) + 磁盘档案独立对账', async () => {
  const ai = await withMockAiServer();
  try {
    await withTestHub({ prefix: 'soul-x4-', llmBaseUrl: ai.baseUrl, embeddingBaseUrl: ai.baseUrl }, async ({ hub, dir }) => {
      const h = { 'X-Soul-Token': hub.apiToken };
      await postJson(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'http-a', bodyType: 'web', text: '帮我记住：我对花生严重过敏，绝对不能碰',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/archive/commitment`, {
        title: '修筑西侧花岗岩防线', detail: '目前还缺钢材，明晚继续盖完', bodyType: 'game:rimworld',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/archive/experience`, {
        bodyId: 'mc-a', bodyType: 'game:minecraft', origin: 'lived',
        stimulus: '空手硬刚苦力怕', realityOutcome: '被炸掉 14 点血', valence: -0.88, lesson: '绝不空手硬刚苦力怕',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/embedding/sync`, {}, hub.apiToken);

      // 1) WebSocket 语义跨词召回与约定可见性
      const wsMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/body?token=${encodeURIComponent(hub.apiToken)}`);
        const timer = setTimeout(() => { socket.close(); reject(new Error('WS 超时')); }, 5000);
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'register', bodyId: 'ws-desk', bodyType: 'robot:ros2' }));
        });
        socket.addEventListener('message', (ev) => {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg.type === 'welcome') {
            socket.send(JSON.stringify({ type: 'percept', bodyId: 'ws-desk', bodyType: 'robot:ros2', text: '今晚外卖挑不含坚果类的清淡炒饭吧' }));
          } else if (msg.type === 'expression') {
            clearTimeout(timer);
            socket.close();
            resolve(msg);
          }
        });
        socket.addEventListener('error', (err) => { clearTimeout(timer); reject(err); });
      });
      const wsTrace = wsMsg.recallTrace as {
        activeCommitments: Array<{ title: string }>;
        recalledFragments: Array<{ title: string }>;
      };
      assert.ok(wsTrace.activeCommitments.some((c) => c.title.includes('西侧花岗岩防线')));
      assert.ok(wsTrace.recalledFragments.some((f) => f.title.includes('花生')));

      // 2) OpenAI Proxy 验证 LLM 系统提示完整包含约定与亲历经验
      const oaiRes = await postJson<{ choices: Array<{ message: { content: string } }> }>(
        `${hub.baseUrl}/v1/chat/completions`,
        { model: 'soul-unto-you', messages: [{ role: 'user', content: '还记得苦力怕和西侧防线吗？' }] },
        hub.apiToken,
        { 'x-body-id': 'oai-mc', 'x-body-type': 'game:minecraft' },
      );
      assert.equal(oaiRes.status, 200);
      assert.ok(oaiRes.data.choices[0]?.message.content.length > 0);
      const lastChatReq = ai.requests.filter((r) => r.path === '/v1/chat/completions').pop()?.body as {
        messages?: Array<{ role: string; content: string }>;
      };
      const sysPrompt = lastChatReq?.messages?.find((m) => m.role === 'system')?.content || '';
      assert.ok(sysPrompt.includes('西侧花岗岩防线'), 'OpenAI 代理系统提示必须注入未完约定');
      assert.ok(sysPrompt.includes('绝不空手硬刚苦力怕'), 'OpenAI 代理系统提示必须注入亲历教训');

      // 3) MCP 工具调用验证
      const mcpPerceive = await postJson<{ result?: { content?: Array<{ text: string }> } }>(`${hub.baseUrl}/mcp`, {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'soul_perceive', arguments: { text: '花岗岩防线进度如何？', bodyId: 'mcp-1', bodyType: 'mcp' } },
      }, hub.apiToken);
      assert.equal(mcpPerceive.status, 200);
      assert.ok((mcpPerceive.data.result?.content?.[0]?.text || '').length > 0);
      const mcpSeed = await fetch(`${hub.baseUrl}/mcp`, {
        method: 'POST', headers: authHeaders(hub.apiToken, h),
        body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'soul_seed', arguments: {} } }),
      });
      assert.ok((await mcpSeed.text()).includes(FIRST_AWAKENING_ZH));

      assertCrossVerifiedArchive(dir);
    });
  } finally {
    await ai.close();
  }
});

test('交叉验证 2：冷重启永生一致性校验（记忆保留率、向量索引与三重铭记跨进程无损恢复）', async () => {
  const ai = await withMockAiServer();
  try {
    await withTestHub({ prefix: 'soul-cold-', llmBaseUrl: ai.baseUrl, embeddingBaseUrl: ai.baseUrl }, async ({ hub, dir, restartHub }) => {
      const h = { 'X-Soul-Token': hub.apiToken };
      await postJson(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'qq-1', bodyType: 'chat:qq', text: '帮我记住：我对花生严重过敏，绝对不能碰',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'qq-1', bodyType: 'chat:qq', text: '这是只有我们俩懂的秘密口令：星河落羽',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/archive/experience`, {
        bodyId: 'mc-1', bodyType: 'game:minecraft', origin: 'lived',
        stimulus: '空手硬刚苦力怕', realityOutcome: '被炸伤', valence: -0.9, lesson: '别空手冲',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/dream`, {}, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/embedding/sync`, {}, hub.apiToken);

      const retBefore = await (await fetch(`${hub.baseUrl}/api/memory/retention`, { headers: h })).json() as {
        episodes: unknown[]; summary: { pinnedCount: number; selfImportantCount: number };
      };
      const expBefore = await (await fetch(`${hub.baseUrl}/api/archive/experiences`, { headers: h })).json() as { experiences: unknown[] };
      const embBefore = await (await fetch(`${hub.baseUrl}/api/embedding/health`, { headers: h })).json() as { ok: boolean; totalVectors: number };

      // 彻底关闭旧中枢并在原目录冷启动全新中枢实例
      const hub2 = await restartHub();
      const h2 = { 'X-Soul-Token': hub2.apiToken };
      const retAfter = await (await fetch(`${hub2.baseUrl}/api/memory/retention`, { headers: h2 })).json() as typeof retBefore;
      const expAfter = await (await fetch(`${hub2.baseUrl}/api/archive/experiences`, { headers: h2 })).json() as typeof expBefore;
      const embAfter = await (await fetch(`${hub2.baseUrl}/api/embedding/health`, { headers: h2 })).json() as typeof embBefore;

      assert.equal(retAfter.episodes.length, retBefore.episodes.length);
      assert.equal(retAfter.summary.pinnedCount, retBefore.summary.pinnedCount);
      assert.equal(retAfter.summary.selfImportantCount, retBefore.summary.selfImportantCount);
      assert.equal(expAfter.experiences.length, expBefore.experiences.length);
      assert.equal(embAfter.ok, true);
      assert.equal(embAfter.totalVectors, embBefore.totalVectors);

      const para = await postJson<{
        recallTrace: { embeddingActive: boolean; recalledFragments: Array<{ title: string }> };
      }>(`${hub2.baseUrl}/api/body/percept`, {
        bodyId: 'web-2', bodyType: 'web', text: '今晚外卖挑不含坚果类的清淡炒饭吧',
      }, hub2.apiToken);
      assert.equal(para.data.recallTrace.embeddingActive, true);
      assert.ok(para.data.recallTrace.recalledFragments.some((f) => f.title.includes('花生')));
      assertCrossVerifiedArchive(dir);
    });
  } finally {
    await ai.close();
  }
});

test('交叉验证 3：故障注入与自动热恢复（向量熔断静默降级 -> 恢复后自动复能）', async () => {
  const ai = await withMockAiServer();
  try {
    await withTestHub({ prefix: 'soul-fault-', llmBaseUrl: ai.baseUrl, embeddingBaseUrl: ai.baseUrl }, async ({ hub, dir }) => {
      await postJson(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'web-1', bodyType: 'web', text: '帮我记住：我对花生严重过敏，绝不能碰',
      }, hub.apiToken);
      await postJson(`${hub.baseUrl}/api/embedding/sync`, {}, hub.apiToken);

      // A: 在线语义召回正常
      const onlineRes = await postJson<{
        ok: boolean; recallTrace: { embeddingActive: boolean; recalledFragments: Array<{ title: string }> };
      }>(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'web-1', bodyType: 'web', text: '今晚外卖挑不含坚果类的清淡炒饭吧',
      }, hub.apiToken);
      assert.equal(onlineRes.data.recallTrace.embeddingActive, true);
      assert.ok(onlineRes.data.recallTrace.recalledFragments.some((f) => f.title.includes('花生')));

      // B: 注入向量服务 503 故障 -> 对话不报错，静默回退词法检索
      ai.setFailMode({ embed: true });
      const outageRes = await postJson<{
        ok: boolean; recallTrace: { embeddingActive: boolean; recalledFragments: Array<{ title: string }> };
      }>(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'web-1', bodyType: 'web', text: '今晚外卖点什么不含花生？',
      }, hub.apiToken);
      assert.equal(outageRes.status, 200);
      assert.equal(outageRes.data.ok, true);
      assert.equal(outageRes.data.recallTrace.embeddingActive, false);
      assert.ok(outageRes.data.recallTrace.recalledFragments.some((f) => f.title.includes('花生')));

      // C: 恢复向量服务 -> 无需重启中枢即可自动恢复千问语义联想
      ai.setFailMode({ embed: false });
      const recoveredRes = await postJson<{
        ok: boolean; recallTrace: { embeddingActive: boolean; recalledFragments: Array<{ title: string }> };
      }>(`${hub.baseUrl}/api/body/percept`, {
        bodyId: 'web-1', bodyType: 'web', text: '今晚外卖挑不含坚果类的清淡炒饭吧',
      }, hub.apiToken);
      assert.equal(recoveredRes.data.recallTrace.embeddingActive, true);
      assert.ok(recoveredRes.data.recallTrace.recalledFragments.some((f) => f.title.includes('花生')));
      assertCrossVerifiedArchive(dir);
    });
  } finally {
    await ai.close();
  }
});

test('交叉验证 4：并发 SoulLock 压测下的因果序与纯文本档案完整性', async () => {
  await withTestHub({ prefix: 'soul-race-' }, async ({ hub, dir }) => {
    const tasks = [
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/percept`, { bodyId: 'b1', bodyType: 'web', text: '并发消息一：今天天气真好' }, hub.apiToken),
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/percept`, { bodyId: 'b2', bodyType: 'chat:qq', text: '并发消息二：记得今晚修西侧防线' }, hub.apiToken),
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/percept`, { bodyId: 'b3', bodyType: 'game:rimworld', text: '并发消息三：帮我记住基地缺钢材' }, hub.apiToken),
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/body/percept`, { bodyId: 'b4', bodyType: 'robot:ros2', text: '并发消息四：倒一杯温水' }, hub.apiToken),
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/archive/commitment`, { title: '并发约定校验', detail: '校验因果锁', bodyType: 'web' }, hub.apiToken),
      postJson<{ ok: boolean }>(`${hub.baseUrl}/api/dream`, {}, hub.apiToken),
    ];
    const results = await Promise.all(tasks);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
    }
    assertCrossVerifiedArchive(dir);
  });
});
