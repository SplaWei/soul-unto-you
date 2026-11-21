import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SOUL_DRIVES,
  allocateSeq,
  appendJsonlLine,
  readJsonSafe,
  readJsonlSafe,
  resolveArchivePaths,
  writeTextAtomic,
} from './archive.ts';
import type {
  LivedExperience,
  SelfEvolutionNote,
  SoulDrives,
  SoulIdentity,
  TemporalBelief,
} from './types.ts';

export function listBeliefs(dir: string): TemporalBelief[] {
  return readJsonlSafe<TemporalBelief>(resolveArchivePaths(dir).beliefs);
}

export function listSelfEvolution(dir: string): SelfEvolutionNote[] {
  return readJsonlSafe<SelfEvolutionNote>(resolveArchivePaths(dir).selfEvolution);
}

export function renderEvolvingSelfMarkdown(dir: string): string {
  const p = resolveArchivePaths(dir);
  const identity = readJsonSafe<SoulIdentity>(path.join(p.root, 'identity.json'), {
    id: 'soul', name: 'Soul', partnerName: 'Partner', persona: '', catchphrases: [], coreValues: [], anchors: [],
  });
  const drives = readJsonSafe<SoulDrives>(p.drives, { ...DEFAULT_SOUL_DRIVES });
  const beliefs = listBeliefs(dir);
  const evolutions = listSelfEvolution(dir);

  const active = beliefs.filter((b) => !b.supersededAtSeq);
  const superseded = beliefs.filter((b) => Boolean(b.supersededAtSeq));
  const latestTrait = evolutions[evolutions.length - 1]?.evolvedTrait
    || (drives.safety >= 0.65
      ? '经历现实挫折后更注重提前评估风险与做好防护准备'
      : '保持好奇探索欲，喜欢在亲身实践中检验世界');

  const lines: string[] = [
    `# ${identity.name} · 活体自我演化快照 (EVOLVING-SELF.md)`,
    '',
    '## 当前活体性格与行事基调',
    `- **最新蜕变特质**：${latestTrait}`,
    `- **此刻内在状态**：好奇 ${Math.round(drives.curiosity * 100)}% | 警觉 ${Math.round(drives.safety * 100)}% | 亲密 ${Math.round(drives.closeness * 100)}% | 玩心 ${Math.round(drives.playfulness * 100)}%`,
    '',
    '## 当前坚信的时序信念 (Active Beliefs)',
    ...(active.length
      ? active.map((b) => `- [validFrom seq:${b.validFromSeq} | 确信度 ${Math.round(b.confidence * 100)}%] **${b.topic}**：${b.statement}`)
      : ['- 尚未通过实践沉淀出固定信念，正保持开放心态观察世界。']),
    '',
    '## 曾抱有但已被实践修正的旧观念 (Superseded Beliefs · 心灵年轮)',
    ...(superseded.length
      ? superseded.slice(-6).map((b) => `- ~~[seq:${b.validFromSeq} → 被 seq:${b.supersededAtSeq} 扬弃] **${b.topic}**：${b.statement}~~`)
      : ['- 暂无被推翻的旧观念。']),
    '',
    '## 自我性格蜕变年轮 (Self-Evolution Rings)',
    ...(evolutions.length
      ? evolutions.slice(-8).map((ev) => `- [seq:${ev.seq}][${ev.trigger}] 「${ev.previousTrait}」 → 「${ev.evolvedTrait}」（因：${ev.reason}）`)
      : ['- 等待真实经历与夜梦反思写下第一道成长年轮。']),
    '',
  ];
  const md = lines.join('\n');
  writeTextAtomic(p.evolvingSelf, md);
  return md;
}

export function upsertTemporalBelief(
  dir: string,
  input: { topic: string; statement: string; confidence?: number; evidenceSeqs?: number[] },
): TemporalBelief {
  const p = resolveArchivePaths(dir);
  const topic = input.topic.trim();
  const statement = input.statement.trim();
  const all = listBeliefs(dir);
  const existing = all.find((b) => !b.supersededAtSeq && b.topic === topic);

  if (existing && existing.statement === statement) {
    existing.confidence = Number(Math.max(existing.confidence, input.confidence ?? existing.confidence).toFixed(3));
    existing.evidenceSeqs = Array.from(new Set([...existing.evidenceSeqs, ...(input.evidenceSeqs ?? [])]));
    existing.updatedAt = new Date().toISOString();
    writeTextAtomic(p.beliefs, all.map((b) => JSON.stringify(b)).join('\n') + '\n');
    renderEvolvingSelfMarkdown(dir);
    return existing;
  }

  const seq = allocateSeq(dir, 'verified');
  const next: TemporalBelief = {
    id: `blf_${crypto.randomUUID().slice(0, 10)}`,
    seq,
    topic,
    statement,
    confidence: Number(Math.max(0.1, Math.min(0.99, input.confidence ?? 0.85)).toFixed(3)),
    validFromSeq: seq,
    evidenceSeqs: input.evidenceSeqs ?? [],
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    existing.supersededAtSeq = seq;
    existing.supersededById = next.id;
    existing.updatedAt = next.updatedAt;
  }
  all.push(next);
  writeTextAtomic(p.beliefs, all.map((b) => JSON.stringify(b)).join('\n') + '\n');
  renderEvolvingSelfMarkdown(dir);
  return next;
}

export function recordSelfEvolution(
  dir: string,
  input: {
    trigger: SelfEvolutionNote['trigger'];
    previousTrait: string;
    evolvedTrait: string;
    reason: string;
    evidenceSeqs?: number[];
  },
): SelfEvolutionNote {
  const p = resolveArchivePaths(dir);
  const seq = allocateSeq(dir, 'verified');
  const note: SelfEvolutionNote = {
    id: `evo_${crypto.randomUUID().slice(0, 10)}`,
    seq,
    timestamp: new Date().toISOString(),
    trigger: input.trigger,
    previousTrait: input.previousTrait.trim(),
    evolvedTrait: input.evolvedTrait.trim(),
    reason: input.reason.trim(),
    evidenceSeqs: input.evidenceSeqs ?? [],
  };
  appendJsonlLine(p.selfEvolution, note);
  renderEvolvingSelfMarkdown(dir);
  return note;
}

function classifyTraitStage(trait: string): 'cautious' | 'confident' | 'other' {
  if (/(沉稳自信|转化为准备与方法|克服|自信地迎接)/.test(trait)) return 'confident';
  if (/(避险自保|评估风险|做好防护|讲条件|保护自己)/.test(trait)) return 'cautious';
  return 'other';
}

function hasExistingEvolutionStage(dir: string, candidateTrait: string, expSeq?: number): SelfEvolutionNote | undefined {
  const all = listSelfEvolution(dir);
  const stage = classifyTraitStage(candidateTrait);
  const bySeq = expSeq ? all.find((n) => n.evidenceSeqs.includes(expSeq)) : undefined;
  if (bySeq) return bySeq;
  return stage === 'other'
    ? all.find((n) => n.evolvedTrait === candidateTrait)
    : all.find((n) => classifyTraitStage(n.evolvedTrait) === stage)
      || (stage === 'cautious' ? all.find((n) => classifyTraitStage(n.evolvedTrait) === 'confident') : undefined);
}

function mergeEvolutionEvidence(dir: string, candidateTrait: string, expSeq?: number): SelfEvolutionNote | null {
  const existing = hasExistingEvolutionStage(dir, candidateTrait, expSeq);
  if (!existing) return null;
  if (expSeq && !existing.evidenceSeqs.includes(expSeq)) {
    const p = resolveArchivePaths(dir);
    const all = listSelfEvolution(dir);
    const target = all.find((n) => n.id === existing.id);
    if (target) {
      target.evidenceSeqs.push(expSeq);
      writeTextAtomic(p.selfEvolution, all.map((n) => JSON.stringify(n)).join('\n') + '\n');
      renderEvolvingSelfMarkdown(dir);
      return target;
    }
  }
  return existing;
}

/** 根据通用亲历体验（origin + valence + lesson）演化时序信念与自我性格年轮。 */
export function evolveSelfFromExperience(dir: string, exp: LivedExperience): void {
  if (exp.origin === 'inherited' && exp.valence <= -0.4) {
    const hasTopic = listBeliefs(dir).some((b) => !b.supersededAtSeq && b.topic === '危险防备底线');
    if (!hasTopic) {
      upsertTemporalBelief(dir, {
        topic: '危险防备底线',
        statement: `听闻潜在风险：${exp.lesson}（尚未亲身实践检验）`,
        confidence: 0.58,
        evidenceSeqs: [exp.seq],
      });
    }
    return;
  }

  if (exp.origin !== 'lived' || Math.abs(exp.valence) < 0.4) return;
  const lastEvo = listSelfEvolution(dir).slice(-1)[0];

  if (exp.valence <= -0.4) {
    upsertTemporalBelief(dir, {
      topic: '危险防备底线',
      statement: `亲历受挫后铭记底线：${exp.lesson}`,
      confidence: 0.92,
      evidenceSeqs: [exp.seq],
    });
    if (!listBeliefs(dir).some((b) => b.topic === '实战破局信心')) {
      upsertTemporalBelief(dir, {
        topic: '实战破局信心',
        statement: `面对「${exp.stimulus.slice(0, 28)}」曾遭受现实受挫，尚需摸索稳妥的应对方式。`,
        confidence: 0.72,
        evidenceSeqs: [exp.seq],
      });
    }
    const nextTrait = '吃过现实亏后懂得先评估风险、做好防护准备并讲条件保护自己';
    if (!mergeEvolutionEvidence(dir, nextTrait, exp.seq)) {
      recordSelfEvolution(dir, {
        trigger: 'practice',
        previousTrait: lastEvo?.evolvedTrait || '初生无畏、凭好奇直接试探',
        evolvedTrait: nextTrait,
        reason: exp.realityOutcome,
        evidenceSeqs: [exp.seq],
      });
    }
    return;
  }

  if (exp.valence >= 0.45) {
    if (!listBeliefs(dir).some((b) => b.topic === '实战破局信心')) {
      upsertTemporalBelief(dir, {
        topic: '实战破局信心',
        statement: '面对高风险或未知挑战曾心怀顾虑，以为只能被动回避。',
        confidence: 0.72,
        evidenceSeqs: [exp.seq],
      });
    }
    upsertTemporalBelief(dir, {
      topic: '实战破局信心',
      statement: `实践验证可行：${exp.lesson}`,
      confidence: 0.94,
      evidenceSeqs: [exp.seq],
    });
    const nextTrait = '能够把过往教训转化为准备与方法，沉稳自信地迎接挑战';
    if (!mergeEvolutionEvidence(dir, nextTrait, exp.seq)) {
      recordSelfEvolution(dir, {
        trigger: 'practice',
        previousTrait: lastEvo?.evolvedTrait || '经历受挫后偏谨慎避险',
        evolvedTrait: nextTrait,
        reason: exp.realityOutcome,
        evidenceSeqs: [exp.seq],
      });
    }
  }
}

export async function evolveSelfFromDream(
  dir: string,
  llmSummarizeFn?: (prompt: string) => Promise<string>,
  options: {
    lock?: { withSoulLock: <T>(task: () => Promise<T>) => Promise<T>; getEpoch?: () => number };
  } = {},
): Promise<SelfEvolutionNote | null> {
  const runLocked = <T>(fn: () => Promise<T> | T): Promise<T> =>
    (options.lock ? options.lock.withSoulLock(async () => fn()) : Promise.resolve(fn()));

  const snap = await runLocked(() => {
    const p = resolveArchivePaths(dir);
    const exps = readJsonlSafe<LivedExperience>(p.experiences, 8);
    const evos = listSelfEvolution(dir);
    const epoch = options.lock?.getEpoch?.() ?? 0;
    if (!exps.length) {
      renderEvolvingSelfMarkdown(dir);
      return { skip: true as const, epoch };
    }
    const latest = exps[exps.length - 1];
    if (evos.some((ev) => ev.evidenceSeqs.includes(latest.seq))) {
      renderEvolvingSelfMarkdown(dir);
      return { skip: true as const, epoch };
    }
    return { skip: false as const, exps, latest, lastEvo: evos[evos.length - 1], epoch };
  });
  if (snap.skip) return null;

  let parsed: { topic?: string; belief?: string; previousTrait?: string; evolvedTrait?: string; reason?: string } | null = null;
  if (llmSummarizeFn) {
    const prompt = [
      '请根据以下近期亲历体验，用 JSON 总结灵魂自我信念与性格的微调（只输出 JSON）：',
      '{ "topic": "信念主题(4-10字)", "belief": "现在相信的观点", "previousTrait": "从前的样子", "evolvedTrait": "现在长出来的样子", "reason": "因果原因" }',
      `当前性格特征：${snap.lastEvo?.evolvedTrait || '温和好奇'}`,
      ...snap.exps.map((e) => `- [seq:${e.seq}][${e.origin}][效价:${e.valence}] ${e.realityOutcome}｜${e.lesson}`),
    ].join('\n');
    try {
      const raw = await llmSummarizeFn(prompt);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]) as typeof parsed;
    } catch {}
  }

  return runLocked(() => {
    if (options.lock?.getEpoch && options.lock.getEpoch() !== snap.epoch) return null;
    if (parsed) {
      if (parsed.topic && parsed.belief) {
        upsertTemporalBelief(dir, { topic: parsed.topic, statement: parsed.belief, confidence: 0.88, evidenceSeqs: [snap.latest.seq] });
      }
      if (parsed.evolvedTrait) {
        if (mergeEvolutionEvidence(dir, parsed.evolvedTrait, snap.latest.seq)) return null;
        return recordSelfEvolution(dir, {
          trigger: 'dream',
          previousTrait: parsed.previousTrait || snap.lastEvo?.evolvedTrait || '探索起步',
          evolvedTrait: parsed.evolvedTrait,
          reason: parsed.reason || snap.latest.realityOutcome,
          evidenceSeqs: [snap.latest.seq],
        });
      }
    }
    renderEvolvingSelfMarkdown(dir);
    return null;
  });
}

export function resetLivingSelf(dir: string): void {
  const p = resolveArchivePaths(dir);
  const identity = readJsonSafe<SoulIdentity>(path.join(p.root, 'identity.json'), {
    id: 'soul', name: 'Soul', partnerName: 'Partner', persona: '', catchphrases: [], coreValues: [], anchors: [],
  });
  writeTextAtomic(p.beliefs, '');
  writeTextAtomic(p.selfEvolution, '');
  writeTextAtomic(p.evolvingSelf, `# ${identity.name} · 活体自我演化快照 (EVOLVING-SELF.md)\n\n- 刚起步：仍在通过亲身实践与同伴磨合认识世界。\n`);
}

export function buildEvolvingSelfPromptSection(dir: string): string {
  const p = resolveArchivePaths(dir);
  if (!fs.existsSync(p.evolvingSelf)) return '';
  const active = listBeliefs(dir).filter((b) => !b.supersededAtSeq);
  const latestEvo = listSelfEvolution(dir).slice(-3);
  if (!active.length && !latestEvo.length) return '';

  const lines = ['', '## 活体自我演化与时序信念 (EVOLVING-SELF · 岁月长出的真实性格与观念)'];
  for (const b of active.slice(-5)) {
    lines.push(`- [信念:${b.topic} | seq:${b.validFromSeq}] ${b.statement}`);
  }
  for (const ev of latestEvo) {
    lines.push(`- [自我蜕变 seq:${ev.seq}] 从「${ev.previousTrait}」成长为「${ev.evolvedTrait}」`);
  }
  return lines.join('\n');
}
