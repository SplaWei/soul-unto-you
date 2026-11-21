import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bindPersonHandle, listRelations, mergePersons, resolveAndRecordSpeaker,
  unbindPersonHandle, upsertPersonRelation,
} from '../src/memory/relations.ts';
import { buildRecallContext } from '../src/memory/search.ts';
import { upsertRelation } from '../src/memory/store.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { appendJournal, initSoulArchive, readJsonlSafe, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import type { JournalEntry, SoulIdentity } from '../src/soul/types.ts';

const TEST_IDENTITY: SoulIdentity = {
  id: 'soul-55b-test', name: '柳遥测试体', partnerName: '同行者',
  persona: '白纸中立、跨端一致的数字灵魂。',
  catchphrases: ['呀~'], coreValues: ['诚实溯源'], anchors: ['醒来第一声我爱你'],
};

function makeSandbox(prefix: string): { dir: string; cfgPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initSoulArchive(dir, TEST_IDENTITY);
  awakenSoul(dir, { bodyId: 'test-init', bodyType: 'web' });
  return { dir, cfgPath: path.join(dir, 'hub.test.json') };
}

test('5.5b-A 跨端 personId 聚合映射与防同昵称冒名顶替隔离', () => {
  const { dir } = makeSandbox('soul-55b-a-');
  try {
    upsertPersonRelation(dir, {
      personId: 'partner-primary', entityId: 'partner-primary', name: '阿明', role: '同行者',
      bondSummary: '重要伙伴。', familiarity: 60,
      handles: [
        { channel: 'web', accountId: 'console-1' },
        { channel: 'chat:qq', accountId: '88001' },
        { channel: 'game:rimworld', accountId: 'colonist_a' },
      ],
    });

    const r1 = resolveAndRecordSpeaker(dir, { bodyId: 'web-1', bodyType: 'web', speaker: '阿明', metadata: { accountId: 'console-1' } });
    const r2 = resolveAndRecordSpeaker(dir, { bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '夜猫子明哥', metadata: { userId: '88001' } });
    const r3 = resolveAndRecordSpeaker(dir, { bodyId: 'rw-1', bodyType: 'game:rimworld', speaker: 'Ming', metadata: { playerId: 'colonist_a' } });

    assert.equal(r1.person.personId, 'partner-primary');
    assert.equal(r2.person.personId, 'partner-primary');
    assert.equal(r3.person.personId, 'partner-primary');
    assert.equal(r3.person.interactionCount, 3);
    assert.ok(r3.person.aliases.includes('夜猫子明哥'));
    assert.ok(r3.person.aliases.includes('Ming'));
    assert.ok(r3.person.familiarity > 60);

    appendJournal(dir, { bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '夜猫子明哥', role: 'partner', text: '跨端打卡', provenance: 'verified', personId: r2.person.personId });
    const journal = readJsonlSafe<JournalEntry>(resolveArchivePaths(dir).journal);
    assert.equal(journal[journal.length - 1].personId, 'partner-primary');

    const spoof = resolveAndRecordSpeaker(dir, {
      bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '阿明', metadata: { userId: '99999' },
    });
    assert.notEqual(spoof.person.personId, 'partner-primary', '不同 QQ 号即使同昵称也不得冒名并入');
    assert.equal(spoof.isNew, true);
    assert.equal(spoof.person.familiarity, 20);

    const primaryNow = listRelations(dir).find((p) => p.personId === 'partner-primary');
    assert.ok(primaryNow);
    assert.equal(primaryNow.interactionCount, 3);
    assert.equal(primaryNow.handles.some((h) => h.accountId === '99999'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5b-B 绑定自动归并、手动合并、解绑与做梦非破坏性更新', () => {
  const { dir } = makeSandbox('soul-55b-b-');
  try {
    upsertPersonRelation(dir, {
      personId: 'partner-primary', entityId: 'partner-primary', name: '阿明', role: '同行者',
      bondSummary: '一直一起测试。', familiarity: 72,
      handles: [{ channel: 'web', accountId: 'console-1' }],
    });

    const u1 = resolveAndRecordSpeaker(dir, { bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '小七', metadata: { userId: '77701' } });
    const u2 = resolveAndRecordSpeaker(dir, { bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '小七号', metadata: { userId: '77701' } });
    assert.equal(u1.person.personId, u2.person.personId);
    assert.equal(u2.person.interactionCount, 2);

    const bound = bindPersonHandle(dir, {
      personId: 'partner-primary', channel: 'chat:qq', accountId: '77701', displayName: '小七分身', mergeExistingOwner: true,
    });
    assert.equal(bound.mergedFromId, u2.person.personId);
    assert.equal(bound.person.interactionCount, 2);
    assert.ok(bound.person.aliases.includes('小七'));
    assert.ok(bound.person.aliases.includes('小七分身'));
    assert.equal(listRelations(dir).some((r) => r.personId === u2.person.personId), false);

    upsertPersonRelation(dir, {
      personId: 'friend-b', entityId: 'friend-b', name: '林栖', role: '朋友',
      bondSummary: '帮忙调试过插件。', familiarity: 80, tags: ['开发者'], notes: ['常聊架构'],
      handles: [{ channel: 'web', accountId: 'web-b' }],
    });
    const merged = mergePersons(dir, 'partner-primary', 'friend-b');
    assert.equal(merged.familiarity, 80);
    assert.ok(merged.aliases.includes('林栖'));
    assert.ok(merged.tags.includes('开发者'));
    assert.ok(merged.notes.includes('常聊架构'));
    assert.ok(merged.handles.some((h) => h.channel === 'web' && h.accountId === 'web-b'));
    assert.equal(listRelations(dir).some((r) => r.personId === 'friend-b'), false);

    const unbound = unbindPersonHandle(dir, { personId: 'partner-primary', channel: 'web', accountId: 'web-b' });
    assert.ok(unbound);
    assert.equal(unbound.handles.some((h) => h.accountId === 'web-b'), false);
    assert.ok(unbound.handles.some((h) => h.accountId === '77701'));

    upsertRelation(dir, {
      entityId: 'rel_阿明', name: '阿明', role: '核心同行者',
      bondSummary: '做梦整理后更新的羁绊印象', familiarity: 88,
    });
    const afterDream = listRelations(dir).find((r) => r.personId === 'partner-primary');
    assert.ok(afterDream);
    assert.equal(afterDream.bondSummary, '做梦整理后更新的羁绊印象');
    assert.equal(afterDream.familiarity, 88);
    assert.ok(afterDream.handles.some((h) => h.accountId === '77701'), '做梦更新不得抹掉已绑定的跨端句柄');
    assert.ok(afterDream.aliases.includes('小七'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5b-C 端到端 HTTP 关系图路由、Percept Prompt/Trace 注入、MCP soul_relations 与中性校验', async () => {
  const { dir, cfgPath } = makeSandbox('soul-55b-c-');
  const token = 'tok-55b-http';
  const hub = await createSoulHubServer({ archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token });
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };

    const createRes = await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers,
      body: JSON.stringify({ personId: 'partner-primary', name: '阿明', role: '同行者', bondSummary: '共同打造灵魂插座', familiarity: 76 }),
    });
    assert.equal(createRes.status, 200);

    await fetch(`${hub.baseUrl}/api/relations/bind`, {
      method: 'POST', headers,
      body: JSON.stringify({ personId: 'partner-primary', channel: 'web', accountId: 'console-main', displayName: '网页阿明' }),
    });
    await fetch(`${hub.baseUrl}/api/relations/bind`, {
      method: 'POST', headers,
      body: JSON.stringify({ personId: 'partner-primary', channel: 'chat:qq', accountId: '88001', displayName: '深夜明哥' }),
    });

    const queryRes = await fetch(`${hub.baseUrl}/api/relations?channel=chat:qq&accountId=88001`, { headers: { 'X-Soul-Token': token } });
    const queryJson = (await queryRes.json()) as { ok: boolean; matched?: { personId: string }; summary: { crossBodyPersons: number; totalHandles: number } };
    assert.equal(queryJson.ok, true);
    assert.equal(queryJson.matched?.personId, 'partner-primary');
    assert.equal(queryJson.summary.crossBodyPersons, 1);
    assert.equal(queryJson.summary.totalHandles, 2);

    const perceptRes = await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers,
      body: JSON.stringify({
        bodyId: 'qq-bot', bodyType: 'chat:qq', speaker: '深夜明哥',
        text: '晚上好呀，还记得我吗？', metadata: { platform: 'qq', userId: '88001' },
      }),
    });
    assert.equal(perceptRes.status, 200);
    const perceptJson = (await perceptRes.json()) as {
      ok: boolean;
      activePerson?: { personId: string; channels: string[]; interactionCount: number };
      recallTrace: { activePerson?: { personId: string; channels: string[] } };
    };
    assert.equal(perceptJson.ok, true);
    assert.equal(perceptJson.activePerson?.personId, 'partner-primary');
    assert.equal(perceptJson.recallTrace.activePerson?.personId, 'partner-primary');
    assert.ok(perceptJson.recallTrace.activePerson?.channels.includes('chat:qq'));
    assert.ok(perceptJson.recallTrace.activePerson?.channels.includes('web'));

    const resolvedReadonly = resolveAndRecordSpeaker(dir, {
      bodyId: 'qq-bot', bodyType: 'chat:qq', speaker: '深夜明哥', metadata: { userId: '88001' }, readonly: true,
    });
    const ctx = await buildRecallContext({
      archiveDir: dir, query: '你好', bodyId: 'qq-bot', bodyType: 'chat:qq', activePerson: resolvedReadonly, reinforce: false,
    });
    assert.ok(ctx.systemPrompt.includes('当前对话对象：阿明 [partner-primary]'));
    assert.ok(ctx.systemPrompt.includes('熟悉度'));
    assert.equal(/(严禁回答|必须拒绝陌生人|请遵守安全伦理)/.test(ctx.systemPrompt), false, '核心 Prompt 严禁硬塞说教/拒答护栏');

    const mcpRelRes = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'soul_relations', arguments: {} } }),
    });
    const mcpRelJson = (await mcpRelRes.json()) as { result: { content: Array<{ text: string }> } };
    const mcpList = JSON.parse(mcpRelJson.result.content[0].text) as Array<{ personId: string }>;
    assert.ok(mcpList.some((p) => p.personId === 'partner-primary'));

    const mcpPerceiveRes = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'soul_perceive', arguments: { bodyType: 'chat:qq', speaker: '凌晨明哥', accountId: '88001', text: '测试 MCP 识别' } },
      }),
    });
    const mcpPerceiveJson = (await mcpPerceiveRes.json()) as { result: { content: Array<{ text: string }> } };
    const mcpPayload = JSON.parse(mcpPerceiveJson.result.content[0].text) as { activePerson?: { personId: string; interactionCount: number } };
    assert.equal(mcpPayload.activePerson?.personId, 'partner-primary');
    assert.equal(mcpPayload.activePerson?.interactionCount, 2);

    await fetch(`${hub.baseUrl}/api/relations`, {
      method: 'POST', headers, body: JSON.stringify({ personId: 'temp-2', name: '路人甲', familiarity: 30 }),
    });
    const mergeRes = await fetch(`${hub.baseUrl}/api/relations/merge`, {
      method: 'POST', headers, body: JSON.stringify({ targetPersonId: 'partner-primary', sourcePersonId: 'temp-2' }),
    });
    assert.equal(mergeRes.status, 200);
    const unbindRes = await fetch(`${hub.baseUrl}/api/relations/unbind`, {
      method: 'POST', headers, body: JSON.stringify({ personId: 'partner-primary', channel: 'chat:qq', accountId: '88001' }),
    });
    assert.equal(unbindRes.status, 200);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
