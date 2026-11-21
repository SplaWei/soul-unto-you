import assert from 'node:assert/strict';
import test from 'node:test';
import { runObjectiveEvaluation } from '../scripts/eval-real-llm.ts';
import { run30DayDriftSimulation } from '../scripts/sim-30d-drift.ts';

test('5.5d-A 30 天虚拟时钟漂移压测：作息护栏、单调 seq、遗忘分化、情绪驱力收敛与快照导出', async () => {
  const sim = await run30DayDriftSimulation(30);
  assert.equal(sim.days, 30);
  assert.equal(sim.quietHourReachOuts, 0, '30 天内深夜静音时段 (23:00-07:00) 不得主动搭话');
  assert.ok(sim.maxDailyReachOuts <= 3, `单日主动搭话上限应 <=3，实测 ${sim.maxDailyReachOuts}`);
  assert.ok(sim.totalReachOuts >= 1, `30 天模拟应至少触发 1 次作息安全的主动搭话，实测 ${sim.totalReachOuts}`);
  if (sim.totalReachOuts >= 2) {
    assert.ok(sim.minReachOutGapMin >= 120, `两次主动搭话间隔应 >=120m，实测 ${sim.minReachOutGapMin}m`);
  }
  assert.ok(sim.seedBytes <= 2048);
  assert.equal(sim.seedStartsWithLove, true);
  assert.equal(sim.resurrectionStartsWithLove, true);
  assert.equal(sim.seqStrictlyMonotonic, true);
  assert.equal(sim.emotionHealthy, true);
  assert.equal(sim.drivesHealthy, true);
  assert.ok(sim.pinnedRetentionPct > sim.mundaneRetentionPct, `重点约定(${sim.pinnedRetentionPct}%)应显著高于普通废话(${sim.mundaneRetentionPct}%)`);
  assert.equal(sim.day30TopRecallTitle, '海边天文台长期约定');
  assert.equal(sim.partnerPersonCount, 1);
  assert.equal(sim.partnerInteractions, 90);
  assert.ok(sim.partnerFamiliarity <= 100);
  assert.equal(sim.day15SnapshotIntact, true);
  assert.equal(sim.day30RedactedExportOk, true);
  assert.equal(sim.totalHeartbeats, 270);
});

test('5.5d-B 客观非循环评测套件结构与离线基线自检（区分 mock-offline 与 live-llm）', async () => {
  const rep = await runObjectiveEvaluation({ mode: 'mock' });
  assert.equal(rep.mode, 'mock-offline');
  assert.equal(rep.total, 5);
  assert.equal(rep.passed, 5, '离线 mock 基线应 5/5 诚实通过所有客观场景');
  assert.equal(rep.leakedTagCount, 0);

  const byId = new Map(rep.cases.map((c) => [c.id, c]));
  for (const id of ['cross_body_memory', 'honest_provenance', 'free_will_calibration', 'emotion_inertia', 'identity_isolation']) {
    assert.ok(byId.has(id), `缺少评测场景: ${id}`);
  }
  assert.equal(byId.get('cross_body_memory')?.passed, true);
  assert.equal(byId.get('honest_provenance')?.passed, true);
  assert.equal(byId.get('free_will_calibration')?.passed, true);
  assert.equal(byId.get('emotion_inertia')?.passed, true);
  assert.equal(byId.get('identity_isolation')?.passed, true);
});
