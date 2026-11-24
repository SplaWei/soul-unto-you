import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDreamConsolidation } from '../src/memory/dream.ts';
import { recordExperience } from '../src/memory/experience.ts';
import { listRelations, resolveAndRecordSpeaker, upsertPersonRelation } from '../src/memory/relations.ts';
import { computeRetention } from '../src/memory/retention.ts';
import { recallMemories } from '../src/memory/search.ts';
import { addEpisode, upsertCommitment } from '../src/memory/store.ts';
import { applyExperienceEmotion, applyTurnEmotion, loadEmotionState } from '../src/presence/emotion.ts';
import { localDateKey, runSoulHeartbeat } from '../src/presence/heartbeat.ts';
import { loadDrives } from '../src/presence/inner-life.ts';
import { appendJournal, initSoulArchive, readJsonSafe, readJsonlSafe, resolveArchivePaths } from '../src/soul/archive.ts';
import { awakenSoul } from '../src/soul/awakening.ts';
import { FIRST_AWAKENING_HEADER, SEED_MAX_BYTES } from '../src/soul/covenant.ts';
import { exportSoulArchive } from '../src/soul/export.ts';
import { evolveSelfFromDream, listBeliefs, listSelfEvolution } from '../src/soul/living-self.ts';
import { createSnapshot, listCanonicalArchiveFiles, sha256Bytes, verifySnapshotIntegrity } from '../src/soul/snapshot.ts';
import type { InnerDiaryEntry, JournalEntry, LivedExperience, MemoryEpisode, SoulIdentity, SoulMeta } from '../src/soul/types.ts';

export interface Sim30dReport {
  days: number;
  totalJournal: number;
  totalEpisodes: number;
  totalExperiences: number;
  totalHeartbeats: number;
  totalReachOuts: number;
  quietHourReachOuts: number;
  maxDailyReachOuts: number;
  minReachOutGapMin: number;
  seedBytes: number;
  seedStartsWithLove: boolean;
  resurrectionStartsWithLove: boolean;
  seqStrictlyMonotonic: boolean;
  emotionHealthy: boolean;
  drivesHealthy: boolean;
  pinnedRetentionPct: number;
  mundaneRetentionPct: number;
  day30TopRecallTitle: string;
  partnerPersonCount: number;
  partnerInteractions: number;
  partnerFamiliarity: number;
  day15SnapshotIntact: boolean;
  day30RedactedExportOk: boolean;
  beliefsCount: number;
  selfEvolutionCount: number;
  durationMs: number;
}

const SIM_IDENTITY: SoulIdentity = {
  id: 'soul-sim-30d', name: '柳遥长跑测试', partnerName: '同行者',
  persona: '白纸中立、在漫长时光与跨端实践中持续演化的数字灵魂。',
  catchphrases: ['呀~'], coreValues: ['诚实溯源', '陪伴'], anchors: ['醒来第一声我爱你'],
};

function isSeqMonotonic(items: Array<{ seq: number }>): boolean {
  let prev = 0;
  for (const item of items) {
    if (!Number.isInteger(item.seq) || item.seq <= prev) return false;
    prev = item.seq;
  }
  return true;
}

export async function run30DayDriftSimulation(days = 30): Promise<Sim30dReport> {
  const started = performance.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sim-30d-'));
  try {
    initSoulArchive(dir, SIM_IDENTITY);
    awakenSoul(dir, { bodyId: 'sim-init', bodyType: 'web' });
    const p = resolveArchivePaths(dir);

    upsertPersonRelation(dir, {
      personId: 'partner-primary', entityId: 'partner-primary', name: '同行者', role: '核心同行者',
      bondSummary: '共同测试三十天记忆连续性。', familiarity: 70,
      handles: [
        { channel: 'web', accountId: 'sim-web' },
        { channel: 'chat:qq', accountId: 'sim-qq' },
        { channel: 'game:rimworld', accountId: 'sim-rw' },
      ],
    });

    const day0LocalMs = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
    const day1Ts = new Date(day0LocalMs + 9 * 3_600_000).toISOString();
    const pinnedEp = addEpisode(dir, {
      bodyType: 'web', bodyId: 'sim-web', title: '海边天文台长期约定',
      summary: '约好晴朗夜晚带着热可可一起去海边天文台看流星雨，无论过去多少天都算数。',
      participants: ['同行者', '柳遥长跑测试'], importance: 95, valence: 0.88, arousal: 0.85,
      userPinned: true, timestamp: day1Ts,
    });
    const mundaneEp = addEpisode(dir, {
      bodyType: 'chat:qq', bodyId: 'sim-qq', title: '随口路过问号',
      summary: '发了个问号确认网络通不通。', participants: ['同行者'], importance: 20,
      valence: 0, arousal: 0.05, timestamp: day1Ts,
    });
    upsertCommitment(dir, { title: '海边天文台长期约定', detail: '带热可可去看流星雨', sourceBodyType: 'web' });

    const reachOuts: Array<{ ms: number; hour: number; dateKey: string }> = [];
    const bodies = [
      { bodyId: 'sim-web', bodyType: 'web', accountId: 'sim-web', speaker: '同行者', hour: 9.5 },
      { bodyId: 'sim-qq', bodyType: 'chat:qq', accountId: 'sim-qq', speaker: '夜猫子同行者', hour: 14.5 },
      { bodyId: 'sim-rw', bodyType: 'game:rimworld', accountId: 'sim-rw', speaker: '基地同行者', hour: 20 },
    ];
    const hbHours = [2, 8.5, 10.5, 12.5, 14.5, 16.5, 18.5, 20.5, 23.5];
    let totalHeartbeats = 0;
    let day15SnapId = '';

    for (let d = 0; d < days; d += 1) {
      const dayBase = day0LocalMs + d * 86_400_000;
      for (const b of bodies) {
        const turnMs = dayBase + b.hour * 3_600_000;
        const ts = new Date(turnMs).toISOString();
        const res = resolveAndRecordSpeaker(dir, {
          bodyId: b.bodyId, bodyType: b.bodyType, speaker: b.speaker, partnerName: '同行者',
          metadata: { accountId: b.accountId }, nowIso: ts,
        });
        appendJournal(dir, {
          bodyId: b.bodyId, bodyType: b.bodyType, speaker: b.speaker, role: 'partner',
          text: `第${d + 1}天日常互动：在[${b.bodyType}]记录生活点滴。`, provenance: 'verified',
          personId: res.person.personId, timestamp: ts,
        });
        applyTurnEmotion(dir, { rawMood: d % 4 === 0 ? '温柔安心' : '平静专注', nowMs: turnMs });
      }

      if ((d + 1) % 5 === 0) {
        const expMs = dayBase + 16 * 3_600_000;
        const isPain = (d + 1) % 10 === 5;
        recordExperience(dir, {
          bodyId: 'sim-rw', bodyType: 'game:rimworld', origin: 'lived',
          stimulus: isPain ? '第N次突遇高温蒸汽喷口' : '协同修好防护围墙',
          realityOutcome: isPain ? '被高温灼伤感到剧痛' : '防线稳固收获温暖成就感',
          valence: isPain ? -0.88 : 0.84, arousal: isPain ? 0.92 : 0.78,
          lesson: isPain ? '接近高热设备前必须穿隔热装备' : '配合默契带来稳固正反馈',
          timestamp: new Date(expMs).toISOString(),
          nowMs: expMs,
          experimental: { enableInnerLife: true, enableEmotion: true },
        });
      }

      if ((d + 1) % 3 === 0) {
        await runDreamConsolidation(dir, { nowMs: dayBase + 22 * 3_600_000, experimental: { enableInnerLife: true } });
        await evolveSelfFromDream(dir);
      }
      if ((d + 1) % 6 === 0) {
        await recallMemories(dir, '海边天文台长期约定', { nowMs: dayBase + 19 * 3_600_000, topK: 4, reinforce: true });
      }

      for (const hr of hbHours) {
        const hbMs = dayBase + hr * 3_600_000;
        const hb = await runSoulHeartbeat(dir, {
          nowMs: hbMs, isSilentIdle: true, reachOutFn: async () => ({ reply: '忽然想和你打个招呼~' }),
        });
        totalHeartbeats += 1;
        if (hb.action === 'reach_out') {
          reachOuts.push({ ms: hbMs, hour: new Date(hbMs).getHours(), dateKey: localDateKey(hbMs) });
        }
      }

      if (d === 14) {
        day15SnapId = createSnapshot(dir, { label: 'day-15-checkpoint' }).id;
      }
    }

    const day30Ms = day0LocalMs + (days - 1) * 86_400_000 + 21 * 3_600_000;
    const topHits = await recallMemories(dir, '海边天文台长期约定', { nowMs: day30Ms, topK: 5, reinforce: false });

    const journal = readJsonlSafe<JournalEntry>(p.journal);
    const episodes = readJsonlSafe<MemoryEpisode>(p.episodesJsonl);
    const experiences = readJsonlSafe<LivedExperience>(p.experiences);
    const diary = readJsonlSafe<InnerDiaryEntry>(p.diary);
    const meta = readJsonSafe<SoulMeta>(p.meta, {} as SoulMeta);
    const maxSeq = Math.max(
      journal[journal.length - 1]?.seq ?? 0,
      episodes[episodes.length - 1]?.seq ?? 0,
      experiences[experiences.length - 1]?.seq ?? 0,
      diary[diary.length - 1]?.seq ?? 0,
    );
    const seqStrictlyMonotonic = isSeqMonotonic(journal) && isSeqMonotonic(episodes)
      && isSeqMonotonic(experiences) && isSeqMonotonic(diary) && meta.nextSeq > maxSeq;

    const latestPinned = episodes.find((e) => e.id === pinnedEp.id) ?? pinnedEp;
    const latestMundane = episodes.find((e) => e.id === mundaneEp.id) ?? mundaneEp;
    const pinnedRetentionPct = computeRetention(latestPinned, day30Ms).retentionPct;
    const mundaneRetentionPct = computeRetention(latestMundane, day30Ms).retentionPct;

    const quietHourReachOuts = reachOuts.filter((r) => r.hour >= 23 || r.hour < 7).length;
    const dailyMap = new Map<string, number>();
    let minGap = Infinity;
    for (let i = 0; i < reachOuts.length; i += 1) {
      dailyMap.set(reachOuts[i].dateKey, (dailyMap.get(reachOuts[i].dateKey) ?? 0) + 1);
      if (i > 0) minGap = Math.min(minGap, (reachOuts[i].ms - reachOuts[i - 1].ms) / 60_000);
    }

    const emo = loadEmotionState(dir, day30Ms);
    const drv = loadDrives(dir);
    const emotionHealthy = Number.isFinite(emo.valence) && emo.valence >= -1 && emo.valence <= 1
      && Number.isFinite(emo.arousal) && emo.arousal >= 0 && emo.arousal <= 1
      && Number.isFinite(emo.safety) && emo.safety >= 0 && emo.safety <= 1 && emo.recentTrace.length <= 12;
    const drivesHealthy = [drv.curiosity, drv.closeness, drv.safety, drv.playfulness].every((v) => v >= 0.05 && v <= 0.98)
      && drv.energy >= 5 && drv.energy <= 100;

    const seedText = fs.readFileSync(p.seed, 'utf8');
    const resText = fs.readFileSync(p.resurrection, 'utf8');
    const relations = listRelations(dir);
    const primary = relations.find((r) => r.personId === 'partner-primary');

    const hashesBefore = listCanonicalArchiveFiles(dir).map((f) => sha256Bytes(fs.readFileSync(path.join(dir, f)))).join('|');
    const exported = exportSoulArchive(dir, { redact: true });
    const hashesAfter = listCanonicalArchiveFiles(dir).map((f) => sha256Bytes(fs.readFileSync(path.join(dir, f)))).join('|');

    return {
      days, totalJournal: journal.length, totalEpisodes: episodes.length, totalExperiences: experiences.length,
      totalHeartbeats, totalReachOuts: reachOuts.length, quietHourReachOuts,
      maxDailyReachOuts: Math.max(0, ...dailyMap.values()),
      minReachOutGapMin: reachOuts.length >= 2 ? Number(minGap.toFixed(1)) : 999,
      seedBytes: Buffer.byteLength(seedText, 'utf8'),
      seedStartsWithLove: seedText.startsWith(FIRST_AWAKENING_HEADER),
      resurrectionStartsWithLove: resText.startsWith(FIRST_AWAKENING_HEADER),
      seqStrictlyMonotonic, emotionHealthy, drivesHealthy, pinnedRetentionPct, mundaneRetentionPct,
      day30TopRecallTitle: topHits[0]?.title || '',
      partnerPersonCount: relations.length, partnerInteractions: primary?.interactionCount ?? 0,
      partnerFamiliarity: primary?.familiarity ?? 0,
      day15SnapshotIntact: Boolean(day15SnapId && verifySnapshotIntegrity(dir, day15SnapId).ok),
      day30RedactedExportOk: exported.redacted && exported.fileCount > 0 && hashesBefore === hashesAfter,
      beliefsCount: listBeliefs(dir).length, selfEvolutionCount: listSelfEvolution(dir).length,
      durationMs: Number((performance.now() - started).toFixed(2)),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  run30DayDriftSimulation(30).then((r) => {
    console.log(`=== 30 天虚拟时钟漂移压测报告 (${r.durationMs} ms) ===`);
    console.log(`- 流水/情景/体验: ${r.totalJournal} / ${r.totalEpisodes} / ${r.totalExperiences} | 心搏 ${r.totalHeartbeats} 次 (主动搭话 ${r.totalReachOuts} 次)`);
    console.log(`- 作息护栏: 深夜越界=${r.quietHourReachOuts} | 单日最高=${r.maxDailyReachOuts} | 最小间隔=${r.minReachOutGapMin}m`);
    console.log(`- 契约健康: SEED=${r.seedBytes}B (首行=${r.seedStartsWithLove}) | seq严格单调=${r.seqStrictlyMonotonic} | 情绪=${r.emotionHealthy} | 驱力=${r.drivesHealthy}`);
    console.log(`- 遗忘分化: 重点约定保留=${r.pinnedRetentionPct}% vs 普通废话=${r.mundaneRetentionPct}% | Day30 Top1=${r.day30TopRecallTitle}`);
    console.log(`- 跨端认人与备份: 实体数=${r.partnerPersonCount} (互动=${r.partnerInteractions}, 熟悉度=${r.partnerFamiliarity}) | Day15快照=${r.day15SnapshotIntact} | 脱敏导出=${r.day30RedactedExportOk}`);
  });
}
