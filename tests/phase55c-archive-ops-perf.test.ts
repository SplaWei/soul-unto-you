import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runJsonl10kBenchmark } from '../scripts/bench-jsonl-10k.ts';
import { recordExperience } from '../src/memory/experience.ts';
import { upsertPersonRelation } from '../src/memory/relations.ts';
import { upsertCommitment } from '../src/memory/store.ts';
import { runSoulHeartbeat } from '../src/presence/heartbeat.ts';
import { createSoulHubServer } from '../src/server/main.ts';
import { appendJournal, initSoulArchive, readJsonSafe, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { FIRST_AWAKENING_HEADER, SEED_MAX_BYTES } from '../src/soul/covenant.ts';
import { exportSoulArchive, exportSoulArchiveToDir } from '../src/soul/export.ts';
import {
  createSnapshot, listCanonicalArchiveFiles, listSnapshots, rollbackToSnapshot, sha256Bytes, verifySnapshotIntegrity,
} from '../src/soul/snapshot.ts';
import type { SoulIdentity, SoulMeta } from '../src/soul/types.ts';

const TEST_IDENTITY: SoulIdentity = {
  id: 'soul-55c-test', name: '柳遥导出测试', partnerName: '同行者',
  persona: '来自 C:\\Users\\alice_demo\\docs 的记忆，测试账号 alice@example.org。',
  catchphrases: ['呀~'], coreValues: ['诚实溯源'], anchors: ['醒来第一声我爱你'],
};

function makeSandbox(prefix: string): { dir: string; cfgPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initSoulArchive(dir, TEST_IDENTITY);
  awakenSoul(dir, { bodyId: 'test-init', bodyType: 'web' });
  return { dir, cfgPath: path.join(dir, 'hub.test.json') };
}

function hashAllCanonical(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of listCanonicalArchiveFiles(dir)) {
    hashes[rel] = sha256Bytes(fs.readFileSync(path.join(dir, rel)));
  }
  return hashes;
}

test('5.5c-A 只读导出与结构化脱敏：绝不改动源档案任何字节且保持格式可解析', async () => {
  const { dir } = makeSandbox('soul-55c-export-');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-55c-export-out-'));
  try {
    upsertPersonRelation(dir, {
      personId: 'partner-primary', name: 'Alice', role: '同行者', bondSummary: '测试联系 13800138000',
      handles: [{ channel: 'chat:qq', accountId: '987654321', displayName: 'AliceQQ' }],
    });
    const fakeKey = ['sk', 'demoFakeSecretKey123456'].join('-');
    appendJournal(dir, {
      bodyId: 'qq-1', bodyType: 'chat:qq', speaker: 'AliceQQ', role: 'partner',
      text: `密钥 ${fakeKey}，路径 C:\\Users\\alice_demo\\notes.txt，暗号星轨！`,
      provenance: 'verified', metadata: { userId: '987654321', groupId: '555666777' },
    });
    await runSoulHeartbeat(dir, { forceAction: 'write_diary', isSilentIdle: true });

    const beforeHashes = hashAllCanonical(dir);
    const bundle = exportSoulArchive(dir, {
      redact: true, includeDiary: false, extraRedactTerms: ['暗号星轨'],
    });
    const afterHashes = hashAllCanonical(dir);
    assert.deepEqual(afterHashes, beforeHashes, '只读导出严禁改动源档案任何字节');

    assert.equal(bundle.redacted, true);
    assert.equal(bundle.files['INNER-LIFE/diary.jsonl'], undefined, 'includeDiary=false 应排除私密日记');
    assert.ok(bundle.redactionStats && bundle.redactionStats.replacedCount >= 5);
    assert.ok(bundle.files['SEED.md'].startsWith(FIRST_AWAKENING_HEADER));
    assert.ok(Buffer.byteLength(bundle.files['SEED.md'], 'utf8') <= SEED_MAX_BYTES);

    const joined = Object.values(bundle.files).join('\n');
    assert.equal(joined.includes(fakeKey), false);
    assert.equal(joined.includes('alice_demo'), false);
    assert.equal(joined.includes('alice@example.org'), false);
    assert.equal(joined.includes('13800138000'), false);
    assert.equal(joined.includes('987654321'), false);
    assert.equal(joined.includes('555666777'), false);
    assert.equal(joined.includes('暗号星轨'), false);

    const parsedRelations = JSON.parse(bundle.files['MEMORIES/relations.json']) as Array<{ handles: Array<{ accountId: string }> }>;
    assert.ok(parsedRelations[0].handles[0].accountId.startsWith('acct_'));
    for (const line of bundle.files['MEMORIES/journal.jsonl'].split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line));
    }

    const dirSummary = exportSoulArchiveToDir(dir, outDir, { redact: true, includeDiary: false });
    assert.equal(dirSummary.fileCount, bundle.fileCount);
    assert.ok(fs.existsSync(path.join(outDir, 'SEED.md')));
    assert.throws(() => exportSoulArchiveToDir(dir, dir), /重叠或嵌套/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('5.5c-B 时间点快照、SHA-256 完整性防篡改与后悔药双向回滚', async () => {
  const { dir } = makeSandbox('soul-55c-snap-');
  const p = resolveArchivePaths(dir);
  try {
    upsertCommitment(dir, { title: '初版约定', detail: '保持初衷', sourceBodyType: 'web' });
    const snap1 = createSnapshot(dir, { label: 'state-t1', reason: '保存初始干净态' });
    const metaT1 = readJsonSafe<SoulMeta>(p.meta, {} as SoulMeta);
    assert.equal(verifySnapshotIntegrity(dir, snap1.id).ok, true);

    await new Promise((r) => setTimeout(r, 15));
    const snapTampered = createSnapshot(dir, { label: 'tamper-test' });
    const tamperTarget = path.join(p.snapshots, snapTampered.id, 'files', 'meta.json');
    fs.appendFileSync(tamperTarget, 'CORRUPT', 'utf8');
    const badCheck = verifySnapshotIntegrity(dir, snapTampered.id);
    assert.equal(badCheck.ok, false);
    assert.throws(() => rollbackToSnapshot(dir, snapTampered.id), /SHA-256 不匹配/);

    upsertCommitment(dir, { title: '后悔新增约定', detail: '等会儿要回滚掉', sourceBodyType: 'chat:qq' });
    appendJournal(dir, { bodyId: 'qq-1', bodyType: 'chat:qq', speaker: '同行者', role: 'partner', text: '误操作消息', provenance: 'verified' });
    recordExperience(dir, {
      bodyId: 'body-1', bodyType: 'robot:test', origin: 'lived',
      stimulus: '误撞测试', realityOutcome: '剧痛受损', valence: -0.9, arousal: 0.92, lesson: '错路',
    });
    fs.mkdirSync(p.index, { recursive: true });
    fs.writeFileSync(p.vectors, '{"stale":true}', 'utf8');
    const metaT2 = readJsonSafe<SoulMeta>(p.meta, {} as SoulMeta);
    assert.ok(metaT2.nextSeq > metaT1.nextSeq);

    const rb1 = rollbackToSnapshot(dir, snap1.id);
    assert.equal(rb1.ok, true);
    assert.equal(rb1.restoredNextSeq, metaT1.nextSeq);
    assert.ok(rb1.safetySnapshotId, '默认回滚必须先留一份自动保护快照');
    assert.equal(fs.existsSync(p.vectors), false, '回滚后应清除可能过期的向量缓存');

    const metaAfterRb1 = readJsonSafe<SoulMeta>(p.meta, {} as SoulMeta);
    assert.equal(metaAfterRb1.nextSeq, metaT1.nextSeq);
    const commitsAfterRb1 = readJsonSafe<Array<{ title: string }>>(p.commitments, []);
    assert.equal(commitsAfterRb1.some((c) => c.title === '后悔新增约定'), false);

    const rbForward = rollbackToSnapshot(dir, rb1.safetySnapshotId!, { createSafetySnapshot: false });
    assert.equal(rbForward.restoredNextSeq, metaT2.nextSeq);
    const commitsForward = readJsonSafe<Array<{ title: string }>>(p.commitments, []);
    assert.equal(commitsForward.some((c) => c.title === '后悔新增约定'), true);
    assert.ok(listSnapshots(dir).length >= 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5c-C 端到端 HTTP 导出/快照/回滚路由与路径穿越拦截', async () => {
  const { dir, cfgPath } = makeSandbox('soul-55c-http-');
  const token = 'tok-55c-http';
  const hub = await createSoulHubServer({ archiveDir: dir, configPath: cfgPath, port: 0, apiToken: token });
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Soul-Token': token };
    const snapRes = await fetch(`${hub.baseUrl}/api/archive/snapshots`, {
      method: 'POST', headers, body: JSON.stringify({ label: 'before-edit', reason: 'HTTP 快照' }),
    });
    assert.equal(snapRes.status, 200);
    const snapJson = (await snapRes.json()) as { ok: boolean; snapshot: { id: string; nextSeq: number } };
    const snapId = snapJson.snapshot.id;

    await fetch(`${hub.baseUrl}/api/body/percept`, {
      method: 'POST', headers, body: JSON.stringify({ bodyId: 'web-1', bodyType: 'web', text: '这条记录等会儿要回滚' }),
    });
    const listBefore = (await (await fetch(`${hub.baseUrl}/api/archive`, { headers: { 'X-Soul-Token': token } })).json()) as {
      archive: { meta: { nextSeq: number } };
    };
    assert.ok(listBefore.archive.meta.nextSeq > snapJson.snapshot.nextSeq);

    const exportRes = await fetch(`${hub.baseUrl}/api/archive/export?redact=1&includeDiary=0`, { headers: { 'X-Soul-Token': token } });
    const exportJson = (await exportRes.json()) as { ok: boolean; bundle: { redacted: boolean; files: Record<string, string> } };
    assert.equal(exportJson.ok, true);
    assert.equal(exportJson.bundle.redacted, true);
    assert.equal(exportJson.bundle.files['INNER-LIFE/diary.jsonl'], undefined);

    const rbRes = await fetch(`${hub.baseUrl}/api/archive/rollback`, {
      method: 'POST', headers, body: JSON.stringify({ snapshotId: snapId }),
    });
    assert.equal(rbRes.status, 200);
    const rbJson = (await rbRes.json()) as { ok: boolean; restoredNextSeq: number; safetySnapshotId?: string };
    assert.equal(rbJson.ok, true);
    assert.equal(rbJson.restoredNextSeq, snapJson.snapshot.nextSeq);

    const listAfter = (await (await fetch(`${hub.baseUrl}/api/archive`, { headers: { 'X-Soul-Token': token } })).json()) as {
      archive: { meta: { nextSeq: number } };
    };
    assert.equal(listAfter.archive.meta.nextSeq, snapJson.snapshot.nextSeq);

    const badDelRes = await fetch(`${hub.baseUrl}/api/archive/snapshots/..%2Fevil`, {
      method: 'DELETE', headers: { 'X-Soul-Token': token },
    });
    assert.equal(badDelRes.status, 400);

    if (rbJson.safetySnapshotId) {
      const delRes = await fetch(`${hub.baseUrl}/api/archive/snapshots/${rbJson.safetySnapshotId}`, {
        method: 'DELETE', headers: { 'X-Soul-Token': token },
      });
      assert.equal(delRes.status, 200);
    }
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5.5c-D 万级 JSONL (10,000+条) 扫盘、尾读、混合召回与导出快照性能基线', async () => {
  const bench = await runJsonl10kBenchmark(10_000);
  assert.equal(bench.tailCount, 40);
  assert.equal(bench.tailLastSeq, 10_000);
  assert.equal(bench.fullCount, 10_000);
  assert.equal(bench.topRecalledTitle, '星海天文台约定');
  assert.ok(bench.tailJournal40Ms < 200, `万级尾部40条读取应 <200ms，实测 ${bench.tailJournal40Ms}ms`);
  assert.ok(bench.fullEpisodesScanMs < 2000, `万条全量扫描应 <2000ms，实测 ${bench.fullEpisodesScanMs}ms`);
  assert.ok(bench.recall10kMs < 2500, `万条混合召回应 <2500ms，实测 ${bench.recall10kMs}ms`);
});
