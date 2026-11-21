import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { QqRiskGuard } from '../adapters/qq-onebot/guard.ts';
import type { OneBotMessageEvent, ParsedQqMessage } from '../adapters/qq-onebot/types.ts';
import { findPerson, mergePersons, upsertPersonRelation } from '../src/memory/relations.ts';
import { applyEmotionStimulus, applyTurnEmotion, loadEmotionState } from '../src/presence/emotion.ts';
import { initSoulArchive, readJsonlSafe, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { createSnapshot } from '../src/soul/snapshot.ts';
import { authHeaders, createTestIdentity, withSandboxArchive, withTestHub } from './helpers/sandbox.ts';

async function startCustomMockOpenAi(
  handler: (reqIndex: number, body: Record<string, unknown>, res: http.ServerResponse) => Promise<void> | void,
) {
  let count = 0;
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    count += 1;
    await handler(count, body, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test('v0.5-C Epoch 栅栏丢弃并发回滚后的过时 LLM 回复 & 工具二轮 502 不污染日记', async () => {
  const slowMock = await startCustomMockOpenAi(async (_idx, _body, res) => {
    await new Promise((r) => setTimeout(r, 260));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'delayed-stale-reply' } }] }));
  });
  try {
    await withTestHub({ prefix: 'soul-v05-epoch-', llmBaseUrl: slowMock.baseUrl }, async ({ hub, dir }) => {
      const headers = authHeaders(hub.apiToken);
      const snap = createSnapshot(dir, { label: 'before-in-flight' });
      const inFlight = fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '测试并发回滚' }),
      });
      await new Promise((r) => setTimeout(r, 50));
      const rbRes = await fetch(`${hub.baseUrl}/api/archive/rollback`, {
        method: 'POST', headers, body: JSON.stringify({ snapshotId: snap.id }),
      });
      assert.equal(rbRes.status, 200);

      const pRes = await inFlight;
      assert.equal(pRes.status, 409, '慢 LLM 期间若发生回滚，陈旧结果必须被 409 丢弃');
      const pJson = (await pRes.json()) as { ok: boolean; stale: boolean };
      assert.equal(pJson.ok, false);
      assert.equal(pJson.stale, true);

      const journal = readJsonlSafe<{ text: string }>(resolveArchivePaths(dir).journal);
      assert.equal(journal.some((j) => j.text.includes('delayed-stale-reply')), false, '陈旧回复严禁写入日记');
    });
  } finally {
    await slowMock.close();
  }

  const failRound2 = await startCustomMockOpenAi((idx, _body, res) => {
    if (idx === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'soul_report_state', arguments: '{"speak":true,"mood":"平静","stance":"gladly_accept"}' } }],
          },
        }],
      }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('round 2 upstream error');
  });
  try {
    await withTestHub({ prefix: 'soul-v05-tool2-', llmBaseUrl: failRound2.baseUrl }, async ({ hub, dir }) => {
      const headers = authHeaders(hub.apiToken);
      const res = await fetch(`${hub.baseUrl}/api/body/percept`, {
        method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '触发二轮工具补全失败' }),
      });
      assert.equal(res.status, 502, '二轮补全失败必须返回 502 而不写空回复');
      const json = (await res.json()) as { toolFollowUpFailed: boolean };
      assert.equal(json.toolFollowUpFailed, true);
      const journal = readJsonlSafe<{ role: string; text: string }>(resolveArchivePaths(dir).journal);
      assert.equal(journal.some((j) => j.role === 'soul' && j.text === ''), false);
    });
  } finally {
    await failRound2.close();
  }
});

test('v0.5-C 关系图自合并/冒名劫持/HTTP 409 防护', async () => {
  await withSandboxArchive('soul-v05-rel-', ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    upsertPersonRelation(dir, {
      personId: 'person-alpha', entityId: 'alias-alpha', name: '阿明', role: '同行者',
      handles: [{ channel: 'chat:qq', accountId: '111' }],
    });
    assert.throws(() => mergePersons(dir, 'person-alpha', 'alias-alpha'), /同一人物档案|不同/);
    const hijack = findPerson(
      [upsertPersonRelation(dir, { personId: 'partner-primary', name: '林夏', handles: [{ channel: 'chat:qq', accountId: '10001' }] })],
      { personId: 'partner-primary', channel: 'chat:qq', accountId: '99999' },
    );
    assert.equal(hijack, null, '不同 accountId 带 personId 参数不得冒名劫持已有档案');
  });

  await withTestHub({ prefix: 'soul-v05-relhttp-' }, async ({ hub }) => {
    const headers = authHeaders(hub.apiToken);
    const rCreate = await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers, body: JSON.stringify({ name: '陈屿', role: '朋友' }),
    });
    assert.equal(rCreate.status, 200);

    const rDup = await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers, body: JSON.stringify({ name: '陈屿', role: '冒充同名' }),
    });
    assert.equal(rDup.status, 409, '未传 personId 且重名必须返回 409');

    await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers, body: JSON.stringify({ personId: 'partner-primary', name: '林夏', allowOverwrite: true }),
    });
    const rRename = await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers, body: JSON.stringify({ personId: 'partner-primary', name: '冒名改名者' }),
    });
    assert.equal(rRename.status, 409, '未显式 allowOverwrite 不得直接覆盖改名 partner-primary');
  });
});

test('v0.5-C 情绪 null 防清零 + 否定词极性与 QQ 同目标并发互斥锁', async () => {
  await withSandboxArchive('soul-v05-emo-', ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    awakenSoul(dir, { bodyId: 'w', bodyType: 'web' });
    const base = loadEmotionState(dir);
    const afterNull = applyEmotionStimulus(dir, {
      valence: null as unknown as number, arousal: null as unknown as number, safety: undefined,
    });
    assert.equal(afterNull.valence, base.valence, 'null 数值字段不得通过 Number(null)===0 强行拉向 0');

    const negZh = applyTurnEmotion(dir, { rawMood: '今天真的一点都不开心' });
    assert.ok(negZh.valence < base.valence, `中文否定词"不开心"必须向下拉低效价 (${negZh.valence})`);
    const negEn = applyTurnEmotion(dir, { rawMood: 'not happy about this' });
    assert.ok(negEn.valence < negZh.valence, `英文否定词"not happy"必须继续向下拉低效价 (${negEn.valence})`);
  });

  const guard = new QqRiskGuard({ allowedUsers: ['1001'], privateCooldownMs: 0 });
  guard.markConnected(Date.now() - 10_000);
  const ev: OneBotMessageEvent = { post_type: 'message', message_type: 'private', user_id: '1001', message_id: 'm1', time: Math.floor(Date.now() / 1000) };
  const parsed: ParsedQqMessage = { text: '你好', isAtSelf: true, mentionedIds: [], imageUrls: [] };

  assert.equal(guard.tryAcquireTarget('private:1001'), true);
  assert.equal(guard.tryAcquireTarget('private:1001'), false);
  const busy = guard.evaluateIncoming({ ...ev, message_id: 'm2' }, parsed);
  assert.equal(busy.decision, 'drop');
  assert.equal(busy.reason, 'target-busy');
  guard.releaseTarget('private:1001');
  assert.equal(guard.tryAcquireTarget('private:1001'), true);
});
