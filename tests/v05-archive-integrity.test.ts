import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordExperience } from '../src/memory/experience.ts';
import { recallMemories } from '../src/memory/search.ts';
import { addEpisode } from '../src/memory/store.ts';
import { runSoulHeartbeat } from '../src/presence/heartbeat.ts';
import { ensureArchiveReady } from '../src/server/main.ts';
import {
  appendJsonlLine,
  appendJournal,
  initSoulArchive,
  readJsonlSafe,
  readMetaOrRecover,
  refreshDerivedSoulFiles,
  resolveArchivePaths,
} from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { createSnapshot, listSnapshots, rollbackToSnapshot, verifySnapshotIntegrity } from '../src/soul/snapshot.ts';
import { createTestIdentity, withSandboxArchive } from './helpers/sandbox.ts';

test('v0.5-A meta.json 损坏自动全盘扫 seq 恢复与防回退', async () => {
  await withSandboxArchive('soul-v05-recover-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    awakenSoul(dir, { bodyId: 'boot', bodyType: 'web' });
    appendJournal(dir, { bodyId: 'b1', bodyType: 'web', speaker: '同行者', role: 'partner', text: '测试因果序一', provenance: 'verified' });
    addEpisode(dir, { bodyId: 'b1', bodyType: 'web', title: '测试情节', summary: '推进因果序', provenance: 'verified' });
    recordExperience(dir, {
      bodyId: 'b1', bodyType: 'web', origin: 'lived',
      stimulus: '试验', realityOutcome: '顺利', valence: 0.6, arousal: 0.5, lesson: '稳步前进',
    });
    const hb = await runSoulHeartbeat(dir, { forceAction: 'write_diary', isSilentIdle: true });
    const diarySeq = hb.diaryEntry?.seq ?? 0;
    const p = resolveArchivePaths(dir);
    const metaBefore = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as { nextSeq: number };
    assert.ok(metaBefore.nextSeq > diarySeq && metaBefore.nextSeq >= 5);

    fs.writeFileSync(p.meta, '{corrupted json!!!', 'utf8');
    const recovered = readMetaOrRecover(dir, { writeRecovered: true });
    assert.equal(recovered.nextSeq, metaBefore.nextSeq, '恢复出的 nextSeq 必须严格高于所有 JSONL 最大 seq');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('meta.json.corrupt-'));
    assert.equal(backups.length, 1, '损坏的原 meta.json 必须保留故障取证备份');
    const reloaded = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as { nextSeq: number };
    assert.equal(reloaded.nextSeq, metaBefore.nextSeq);
  });
});

test('v0.5-A 手改 SOUL.md 备份保留与 ensureArchiveReady 防误覆盖', async () => {
  await withSandboxArchive('soul-v05-soulbak-', ({ dir }) => {
    const customId = createTestIdentity({ id: 'custom-real-01', name: '青岚', partnerName: '林风' });
    initSoulArchive(dir, customId);
    awakenSoul(dir, { bodyId: 'web', bodyType: 'web' });
    const p = resolveArchivePaths(dir);

    const handEdited = '# CUSTOM SOUL PROFILE\n\n用户亲手编写的人设细节，不得被静默覆盖。\n';
    fs.writeFileSync(p.soul, handEdited, 'utf8');
    refreshDerivedSoulFiles(dir);
    const bakPath = path.join(dir, 'SOUL.md.user.bak');
    assert.equal(fs.existsSync(bakPath), true, '检测到手改 SOUL.md 哈希不一致时必须先备份为 SOUL.md.user.bak');
    assert.equal(fs.readFileSync(bakPath, 'utf8'), handEdited);

    fs.writeFileSync(p.meta, '{broken meta', 'utf8');
    ensureArchiveReady(dir);
    const persistedId = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')) as { id: string; name: string };
    assert.equal(persistedId.id, 'custom-real-01', 'ensureArchiveReady 绝不得用示例身份覆盖已存在档案');
    assert.equal(persistedId.name, '青岚');
  });

  await withSandboxArchive('soul-v05-seedonly-', ({ dir }) => {
    const p = resolveArchivePaths(dir);
    fs.writeFileSync(p.seed, '我爱你。 / I love you.\n\n# 仅有种子的残缺档案\n', 'utf8');
    assert.throws(() => ensureArchiveReady(dir), /残缺档案|拒绝自动覆盖/);
  });
});

test('v0.5-A JSONL 缺尾换行自愈、畸形行过滤与零相关记忆抑制', async () => {
  await withSandboxArchive('soul-v05-jsonl-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    const p = resolveArchivePaths(dir);
    fs.writeFileSync(p.journal, '{"seq":1,"text":"第一条"}\n{"seq":2,"text":"第二条缺换行"}', 'utf8');
    appendJsonlLine(p.journal, { seq: 3, text: '第三条自动补换行' });
    fs.appendFileSync(p.journal, 'broken-json\nnull\n[1,2,3]\n123\n"str"\n', 'utf8');

    const lines = fs.readFileSync(p.journal, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.doesNotThrow(() => JSON.parse(lines[1]));
    assert.doesNotThrow(() => JSON.parse(lines[2]));
    const parsed = readJsonlSafe<{ seq: number; text: string }>(p.journal);
    assert.deepEqual(parsed.map((x) => x.seq), [1, 2, 3], 'readJsonlSafe 必须跳过 null/数组/原语与损坏行');

    addEpisode(dir, {
      bodyId: 'w1', bodyType: 'web', title: '今天买了草莓奶油蛋糕',
      summary: '在街角甜品店买了一份香甜的草莓蛋糕', provenance: 'verified',
      userPinned: true, selfImportant: true, importance: 99,
    });
    addEpisode(dir, {
      bodyId: 'w1', bodyType: 'web', title: '量子物理双缝干涉实验笔记',
      summary: '记录双缝干涉实验的光学条纹与波粒二象性观测结果', provenance: 'verified', importance: 70,
    });
    const hits = await recallMemories(dir, '量子物理双缝干涉', { topK: 2, reinforce: false });
    assert.equal(hits[0]?.title, '量子物理双缝干涉实验笔记', '零词法/向量相关的置顶记忆不得压倒高相关记忆');
  });
});

test('v0.5-A 快照严格清单校验与回滚清理保护', async () => {
  await withSandboxArchive('soul-v05-snap-', async ({ dir }) => {
    initSoulArchive(dir, createTestIdentity());
    awakenSoul(dir, { bodyId: 'w', bodyType: 'web' });
    const p = resolveArchivePaths(dir);
    const snap1 = createSnapshot(dir, { label: 'base-v1' });
    const mPath = path.join(p.snapshots, snap1.id, 'manifest.json');
    const origManifest = fs.readFileSync(mPath, 'utf8');

    const badId = JSON.parse(origManifest) as { id: string; files: Array<{ path: string; bytes: number; sha256: string }> };
    fs.writeFileSync(mPath, JSON.stringify({ ...badId, id: 'mismatch-id' }), 'utf8');
    assert.equal(verifySnapshotIntegrity(dir, snap1.id).ok, false);

    fs.writeFileSync(mPath, JSON.stringify({ ...badId, files: [{ path: '../evil.txt', bytes: 1, sha256: '00' }] }), 'utf8');
    assert.equal(verifySnapshotIntegrity(dir, snap1.id).ok, false);

    fs.writeFileSync(mPath, JSON.stringify({ ...badId, files: badId.files.filter((f) => f.path !== 'identity.json') }), 'utf8');
    assert.equal(verifySnapshotIntegrity(dir, snap1.id).ok, false);

    fs.writeFileSync(mPath, origManifest, 'utf8');
    assert.equal(verifySnapshotIntegrity(dir, snap1.id).ok, true);

    await new Promise((r) => setTimeout(r, 15));
    createSnapshot(dir, { label: 'prune-a', maxSnapshots: 2, protectIds: [snap1.id] });
    await new Promise((r) => setTimeout(r, 15));
    createSnapshot(dir, { label: 'prune-b', maxSnapshots: 2, protectIds: [snap1.id] });
    assert.ok(listSnapshots(dir).some((s) => s.id === snap1.id), 'protectIds 保护列表内的快照不得被裁剪');

    const rb = rollbackToSnapshot(dir, snap1.id, { createSafetySnapshot: true });
    assert.ok(rb.safetySnapshotId);
    assert.equal(verifySnapshotIntegrity(dir, rb.safetySnapshotId).ok, true);
  });
});
