import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkConflictPorts, QqRiskGuard } from '../adapters/qq-onebot/guard.ts';
import { createQqOneBotAdapter, defaultQqAdapterConfig } from '../adapters/qq-onebot/main.ts';
import { parseOneBotMessage, stripMarkdownForQq } from '../adapters/qq-onebot/onebot-client.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { SimpleWsServer } from '../src/server/ws.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('等待条件超时');
}

test('OneBot 消息解析、Markdown 清理、防风控护栏与端口冲突检测', async () => {
  const segParsed = parseOneBotMessage(
    [
      { type: 'at', data: { qq: '90001' } },
      { type: 'text', data: { text: ' 早安呀 ' } },
      { type: 'image', data: { url: 'https://example.com/a.png' } },
    ],
    '90001',
  );
  assert.equal(segParsed.isAtSelf, true);
  assert.equal(segParsed.text, '早安呀');
  assert.deepEqual(segParsed.imageUrls, ['https://example.com/a.png']);

  const cqParsed = parseOneBotMessage('[CQ:at,qq=90001] 晚上好 [CQ:image,url=https://example.com/b.jpg]', 90001);
  assert.equal(cqParsed.isAtSelf, true);
  assert.equal(cqParsed.text, '晚上好');
  assert.deepEqual(cqParsed.imageUrls, ['https://example.com/b.jpg']);

  assert.equal(stripMarkdownForQq('## 标题\n**加粗** 与 `代码`'), '标题\n加粗 与 代码');

  const guard = new QqRiskGuard({
    allowedUsers: ['10001'],
    allowedGroups: ['20001'],
    privateCooldownMs: 2500,
    groupCooldownMs: 4000,
    maxRepliesPerMinute: 2,
    groupRequireAtOrWakeWord: true,
    wakeWords: ['柳遥'],
    observeUnmentionedGroupMessages: true,
    maxMessageAgeSec: 15,
  });
  const baseMs = 1_700_000_000_000;
  guard.markConnected(baseMs);
  const nowSec = Math.floor(baseMs / 1000);

  // 1. 陌生人 fail-closed 拦截
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 99999, self_id: 90001, time: nowSec, message_id: 1 }, { text: 'hi', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).reason,
    'user-not-whitelisted',
  );
  assert.equal(guard.canSendToGroup('99999', baseMs).reason, 'group-not-whitelisted');
  // 2. 自身消息拦截
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 90001, self_id: 90001, time: nowSec, message_id: 2 }, { text: 'hi', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).reason,
    'self-message',
  );
  // 3. 断线重连积压旧消息拦截
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 90001, time: nowSec - 60, message_id: 3 }, { text: 'old', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).reason,
    'stale-offline-backlog',
  );
  // 4. 群内未 @ 且无唤醒词 -> 静默 observe
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: 90001, time: nowSec, message_id: 4 }, { text: '随便聊聊', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).decision,
    'observe',
  );
  // 5. 群内命中唤醒词 -> reply，并去重同一 message_id
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: 90001, time: nowSec, message_id: 5 }, { text: '柳遥在吗', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).decision,
    'reply',
  );
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: 90001, time: nowSec, message_id: 5 }, { text: '柳遥在吗', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs).reason,
    'duplicate-message',
  );
  // 6. 私聊冷却与每分钟上限
  const okPriv = guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 90001, time: nowSec, message_id: 6 }, { text: '你好', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs);
  assert.equal(okPriv.decision, 'reply');
  guard.recordReplySent(okPriv.targetKey!, baseMs);
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 90001, time: nowSec + 1, message_id: 7 }, { text: '再问一次', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs + 500).reason,
    'cooldown-active',
  );
  guard.recordReplySent('group:20001', baseMs + 1000);
  assert.equal(
    guard.evaluateIncoming({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 90001, time: nowSec + 3, message_id: 8 }, { text: '第三次', isAtSelf: false, mentionedIds: [], imageUrls: [] }, baseMs + 3500).reason,
    'rate-limit-minute',
  );

  // 7. 端口冲突检测（防止同号双开 Bot）
  const busySrv = net.createServer();
  await new Promise<void>((resolve) => busySrv.listen(0, '127.0.0.1', resolve));
  const busyAddr = busySrv.address();
  const busyPort = typeof busyAddr === 'object' && busyAddr ? busyAddr.port : 0;
  try {
    const conflicts = await checkConflictPorts([busyPort]);
    assert.deepEqual(conflicts, [busyPort]);
  } finally {
    await new Promise<void>((resolve) => busySrv.close(() => resolve()));
  }
});

test('Phase 2 跨端联动闭环：MC OpenAI 代理 -> 闲置自动做梦 -> QQ OneBot 零失忆接话', async () => {
  const archiveDir = makeTempDir('soul-phase2-archive-');
  const configPath = path.join(archiveDir, 'config.json');
  const hub = await createSoulHubServer({
    archiveDir,
    configPath,
    host: '127.0.0.1',
    port: 0,
    dream: { enabled: true, idleMinutes: 0.001, minPendingEntries: 2, checkIntervalSec: 0.05 },
  });

  const sentActions: Array<{ action: string; params: Record<string, unknown> }> = [];
  const mockObWs = new SimpleWsServer((client, raw) => {
    const msg = JSON.parse(raw) as { action?: string; params?: Record<string, unknown>; echo?: string };
    if (msg.action) {
      sentActions.push({ action: msg.action, params: msg.params || {} });
      mockObWs.sendJson(client, { status: 'ok', retcode: 0, data: { message_id: sentActions.length }, echo: msg.echo });
    }
  });
  const obServer = http.createServer((req, res) => {
    res.writeHead(404).end();
  });
  obServer.on('upgrade', (req, socket) => {
    mockObWs.handleUpgrade(req, socket);
  });
  await new Promise<void>((resolve) => obServer.listen(0, '127.0.0.1', resolve));
  const obAddr = obServer.address();
  const obPort = typeof obAddr === 'object' && obAddr ? obAddr.port : 0;

  const qqCfg = defaultQqAdapterConfig();
  qqCfg.soulHubUrl = hub.baseUrl;
  qqCfg.apiToken = hub.apiToken;
  qqCfg.bodyId = 'qq-test-bot';
  qqCfg.onebot.wsUrl = `ws://127.0.0.1:${obPort}`;
  qqCfg.onebot.httpUrl = '';
  qqCfg.guard.allowedUsers = ['10001'];
  qqCfg.guard.allowedGroups = ['20001'];
  qqCfg.guard.replyDelayMinMs = 0;
  qqCfg.guard.replyDelayMaxMs = 0;
  qqCfg.guard.conflictCheckPorts = [];

  const adapter = createQqOneBotAdapter(qqCfg, { logger: () => {} });
  const hAuth = { 'Content-Type': 'application/json', 'X-Soul-Token': hub.apiToken };
  const hGet = { 'X-Soul-Token': hub.apiToken };

  try {
    // 1. Minecraft Mindcraft 通过 body-scoped OpenAI 路径连接，并携带 system 提示词
    const mcRes = await fetch(`${hub.baseUrl}/v1/bodies/game:minecraft/mindcraft-bot/chat/completions`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        model: 'soul-unto-you',
        messages: [
          { role: 'system', content: '你正处于 Minecraft Java 版原版世界。' },
          { role: 'user', content: '今晚在 Minecraft 先一起盖好木屋庇护所，约定明晚继续下矿挖铁！' },
        ],
      }),
    });
    assert.equal(mcRes.status, 200);
    const mcJson = (await mcRes.json()) as { choices: Array<{ message: { content: string } }> };
    assert.ok(mcJson.choices[0].message.content.length > 0);

    const bodiesRes = await fetch(`${hub.baseUrl}/api/bodies`, { headers: hGet });
    const bodiesJson = (await bodiesRes.json()) as { bodies: Array<{ bodyId: string; bodyType: string }> };
    assert.ok(bodiesJson.bodies.some((b) => b.bodyId === 'mindcraft-bot' && b.bodyType === 'game:minecraft'));

    // 2. 等待 AutoDreamScheduler 自动完成做梦整理
    await waitUntil(async () => {
      const r = await fetch(`${hub.baseUrl}/api/dream/status`, { headers: hGet });
      const j = (await r.json()) as { scheduler?: { lastRunAt?: string | null; lastResult?: { episodesAdded?: number } | null } };
      return Boolean(j.scheduler?.lastRunAt && (j.scheduler?.lastResult?.episodesAdded ?? 0) >= 1);
    }, 3500);

    // 3. 启动 QQ OneBot 适配器
    await adapter.start();
    await waitUntil(() => mockObWs.clientCount() === 1, 3000);

    const nowSec = Math.floor(Date.now() / 1000) + 1;
    // 未在白名单的用户 -> 丢弃
    mockObWs.broadcastJson({
      post_type: 'message',
      message_type: 'private',
      message_id: 101,
      user_id: 88888,
      self_id: 90001,
      time: nowSec,
      message: '陌生人试探',
    });
    // 白名单群未 @ 且无唤醒词 -> 静默 observe
    mockObWs.broadcastJson({
      post_type: 'message',
      message_type: 'group',
      group_id: 20001,
      message_id: 102,
      user_id: 10001,
      self_id: 90001,
      time: nowSec,
      sender: { nickname: '同行者' },
      message: [{ type: 'text', data: { text: '今天天气不错' } }],
    });
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(sentActions.length, 0);

    const jRes = await fetch(`${hub.baseUrl}/api/archive/journal?bodyId=qq-test-bot&limit=10`, { headers: hGet });
    const jJson = (await jRes.json()) as { entries: Array<{ role: string; text: string }> };
    assert.ok(jJson.entries.some((e) => e.role === 'witness' && e.text.includes('今天天气不错')));

    // 白名单私聊说「早安」-> 必须清晰带出 Minecraft 的木屋/挖铁约定
    mockObWs.broadcastJson({
      post_type: 'message',
      message_type: 'private',
      message_id: 103,
      user_id: 10001,
      self_id: 90001,
      time: nowSec + 1,
      sender: { nickname: '同行者' },
      message: '早安',
    });
    await waitUntil(() => sentActions.length >= 1, 3500);
    assert.equal(sentActions[0].action, 'send_private_msg');
    assert.equal(sentActions[0].params.user_id, 10001);
    const qqReply = String(sentActions[0].params.message);
    assert.ok(qqReply.includes('木屋') || qqReply.includes('挖铁') || qqReply.includes('Minecraft'), `QQ 回复应记得 MC 约定，实际为: ${qqReply}`);

    // 3.5 验证跨躯体主动执行：MC 里让她去 QQ 群唱曼波 -> QQ 适配器真实收到 send_group_msg
    const crossCmdRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({
        bodyId: 'mc-companion-main',
        bodyType: 'game:minecraft',
        speaker: '玩家',
        text: '哈基米，去qq群里唱一首曼波',
      }),
    });
    assert.equal(crossCmdRes.status, 200);
    await waitUntil(() => sentActions.some((a) => a.action === 'send_group_msg'), 3500);
    const groupSend = sentActions.find((a) => a.action === 'send_group_msg')!;
    assert.equal(groupSend.params.group_id, 20001);
    assert.ok(String(groupSend.params.message).length > 0);

    // 4. 验证 Phase 2 一键联调台 API
    const p2StRes = await fetch(`${hub.baseUrl}/api/phase2/status?mcPort=55916`, { headers: hGet });
    assert.equal(p2StRes.status, 200);
    const p2StJson = (await p2StRes.json()) as { ok: boolean; hubOk: boolean; autoDream: unknown; mc: { runtimeReady: boolean; running: boolean; logs: unknown[] } };
    assert.equal(p2StJson.ok, true);
    assert.equal(p2StJson.hubOk, true);
    assert.ok(p2StJson.autoDream !== null);
    assert.equal(typeof p2StJson.mc?.runtimeReady, 'boolean');
    assert.equal(p2StJson.mc?.running, false);
    assert.ok(Array.isArray(p2StJson.mc?.logs));

    const p2McStopRes = await fetch(`${hub.baseUrl}/api/phase2/mc/stop`, { method: 'POST', headers: hAuth, body: '{}' });
    assert.equal(p2McStopRes.status, 200);
    const p2McStopJson = (await p2McStopRes.json()) as { ok: boolean };
    assert.equal(p2McStopJson.ok, true);

    const p2CfgRes = await fetch(`${hub.baseUrl}/api/phase2/qq/config`, { headers: hGet });
    assert.equal(p2CfgRes.status, 200);
    const p2CfgJson = (await p2CfgRes.json()) as { ok: boolean; config: { onebot: unknown } };
    assert.equal(p2CfgJson.ok, true);
    assert.ok(Boolean(p2CfgJson.config?.onebot));

    const p2McRes = await fetch(`${hub.baseUrl}/api/phase2/mc/check`, {
      method: 'POST',
      headers: hAuth,
      body: JSON.stringify({ mcPort: 55916 }),
    });
    assert.equal(p2McRes.status, 200);
    const p2McJson = (await p2McRes.json()) as { ok: boolean; hubOk: boolean; openAiRoute: string };
    assert.equal(p2McJson.ok, true);
    assert.equal(p2McJson.hubOk, true);
    assert.ok(p2McJson.openAiRoute.includes('/v1/bodies/game:minecraft/mindcraft-bot'));
  } finally {
    adapter.stop();
    mockObWs.closeAll();
    await new Promise<void>((resolve) => obServer.close(() => resolve()));
    await hub.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
