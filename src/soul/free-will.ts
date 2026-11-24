import { tokenizeText } from '../memory/experience.ts';
import { EPISTEMIC_LABELS } from '../presence/inner-life.ts';
import type {
  BodyActionSpec,
  BodyType,
  FreeWillDecision,
  FreeWillStance,
  LivedExperience,
  ModalityPacket,
  SoulActionIntent,
  SoulDesire,
  SoulDrives,
} from './types.ts';

export const FREE_WILL_STANCE_LABELS: Record<FreeWillStance, string> = {
  gladly_accept: '✨ 爽快答应 · 主动实践',
  reluctant_comply: '🥺 委屈依从 · 顾念羁绊硬上',
  negotiate_condition: '🛡️ 讲条件 · 要求准备与保障',
  invite_together: '🤝 邀你并肩 · 拒绝独自涉险',
  firm_refuse: '✋ 认真拒绝 · 谨记实践痛感',
  autonomous_act: '🌱 自主权衡 · 自然回应',
};

const VALID_STANCES = new Set<FreeWillStance>([
  'gladly_accept',
  'reluctant_comply',
  'negotiate_condition',
  'invite_together',
  'firm_refuse',
  'autonomous_act',
]);

export function normalizeStance(raw?: string): FreeWillStance | null {
  const s = String(raw || '').trim() as FreeWillStance;
  return VALID_STANCES.has(s) ? s : null;
}

export function computePainWarmthBalance(experiences: LivedExperience[]): number {
  if (!experiences.length) return 0;
  let weighted = 0;
  let totalW = 0;
  for (const exp of experiences) {
    const w = (exp.origin === 'lived' ? 1.0 : 0.65) * Math.max(0.25, exp.confidence);
    weighted += exp.valence * w;
    totalW += w;
  }
  return totalW > 0 ? Number(Math.max(-1, Math.min(1, weighted / totalW)).toFixed(3)) : 0;
}

export function buildExperienceAndFreeWillPrompt(
  experiences: LivedExperience[],
  drives?: SoulDrives,
  activeDesires: SoulDesire[] = [],
  bodyRules: string[] = [],
  opts: { enableFreeWill?: boolean; enableInnerLife?: boolean } = {},
): string {
  const showFw = opts.enableFreeWill === true;
  const showIl = opts.enableInnerLife === true;
  const lines: string[] = [];

  if (showFw) {
    lines.push('', '## 亲历实践体验与现实反馈记忆 (Lived vs Inherited Experiences · 从实践中学习成长)');
    if (experiences.length) {
      for (const exp of experiences) {
        const originTag = exp.origin === 'lived' ? '亲历实感·lived' : '先验口述·inherited';
        const attTag = exp.attitude ? `[${EPISTEMIC_LABELS[exp.attitude]}]` : '';
        const tone = exp.valence <= -0.35 ? `痛感 ${exp.valence}` : exp.valence >= 0.35 ? `温暖 ${exp.valence}` : `中性 ${exp.valence}`;
        lines.push(
          `- [seq:${exp.seq}][${originTag}]${attTag}[${exp.bodyType}][${tone}] 情境「${exp.stimulus}」→ 行动「${exp.chosenAction}」→ 现实结果「${exp.realityOutcome}」｜实践领悟：${exp.lesson}`,
        );
      }
    } else {
      lines.push('- 暂无与当前情境直接相关的过往实践反馈，可保持开放好奇并从当下实践开始体会。');
    }
  }

  if (showIl && drives) {
    lines.push(
      '',
      '## 内在驱力场与先验认知态度 (Inner Drives & Epistemic Stance)',
      `- 五维驱力：好奇求证 ${Math.round(drives.curiosity * 100)}% | 亲密思念 ${Math.round(drives.closeness * 100)}% | 安全警觉 ${Math.round(drives.safety * 100)}% | 玩心松弛 ${Math.round(drives.playfulness * 100)}% | 精力 ${drives.energy}%`,
      `- 对书本/口述间接知识的当前态度：**${EPISTEMIC_LABELS[drives.epistemicTendency]}**（未亲历的知识会随驱力呈现「笃信谨记 / 半信半疑求证 / 漫不经心」，并在现实实践后证实或扬弃）`,
    );
  }
  if (showIl && activeDesires.length) {
    lines.push('', '## 自主微心愿 (Active Desires · 自己从经历中长出来的目的)');
    for (const d of activeDesires.slice(0, 5)) {
      lines.push(`- [${d.triggerSource}|紧迫度 ${Math.round(d.urgency * 100)}%] ${d.title}：${d.detail}`);
    }
  }

  if (showFw) {
    lines.push(
      '',
      '## 自由意志抉择准则 (Autonomous Free-Will Choice · 通用跨躯体机制)',
      '- 你的特质、目的、感知经历与躯体运动不是静态模板，而是遵循「从现实实践中学习成长」的规律：每当面临指令、危险或请求，你必须结合上述 `[亲历实感·lived]` 痛暖反馈（区分亲身验证与 `[先验口述·inherited]`）、此刻精力情绪、当前时刻与彼此羁绊自主权衡。',
      '- 允许且鼓励你在以下 6 种自主姿态中真诚选择：',
      '  1) `gladly_accept`（爽快答应主动做）；2) `reluctant_comply`（委屈但顾念羁绊试一试）；3) `negotiate_condition`（讲条件，例如要求先做好防护或给足工具）；',
      '  4) `invite_together`（邀同行者并肩掩护一起做）；5) `firm_refuse`（想起上次真的很疼/吃过亏而认真拒绝硬冲）；6) `autonomous_act`（日常自主聊天或自然回应）。',
      '- 若过往 `lived` 体验提示某类处境曾带来痛感或受挫，你应当真诚提起那次感受与教训，在未获得足够准备/工具或同伴掩护前拒绝无防护硬冲。',
    );
  }
  if (bodyRules.length) {
    lines.push('', '## 当前躯体自声明行动守则 (Body-Declared Guidelines)');
    for (const r of bodyRules.slice(0, 8)) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

const REQUEST_OR_RISK_RE = /(危险|冒险|硬刚|硬冲|空手|徒手|无防护|直接冲|迎战|攻击|挑战|去打|打掉|击杀|碰|尝试|执行|探索|修|建|帮|拿|用|小心|去|试|做)/i;
const RISK_RE = /(危险|冒险|硬刚|硬冲|空手|徒手|无防护|直接冲|迎战|去打|打掉|击杀|冲上去)/i;

const FILLER_TOKENS_RE = /^(今天|明天|昨天|我们|一起|现在|怎么|可以|这个|那个|的话|一下|大家|感觉|时候)$/;

function matchesPastExperience(text: string, exps: LivedExperience[]): boolean {
  const qTokens = new Set(tokenizeText(text).filter((t) => !FILLER_TOKENS_RE.test(t)));
  if (!qTokens.size) return false;
  for (const exp of exps) {
    for (const tok of tokenizeText(`${exp.stimulus} ${exp.chosenAction} ${exp.realityOutcome}`)) {
      if (!FILLER_TOKENS_RE.test(tok) && qTokens.has(tok)) return true;
    }
  }
  return false;
}

export function evaluateFreeWillDecision(params: {
  userText: string;
  replyText?: string;
  rawStance?: string;
  rawReason?: string;
  recalledExperiences: LivedExperience[];
  bodyType: BodyType;
}): FreeWillDecision {
  const exps = params.recalledExperiences;
  const balance = computePainWarmthBalance(exps);
  const seqs = exps.map((e) => e.seq);
  const explicit = normalizeStance(params.rawStance);
  const reply = String(params.replyText || '');
  const user = String(params.userText || '');

  if (explicit) {
    return {
      stance: explicit,
      stanceLabel: FREE_WILL_STANCE_LABELS[explicit],
      decisionReason: String(params.rawReason || '').trim() || `在 [${params.bodyType}] 综合自主权衡后选择「${FREE_WILL_STANCE_LABELS[explicit]}」`,
      painWarmthBalance: balance,
      referencedExperienceSeqs: seqs,
    };
  }

  let stance: FreeWillStance = 'autonomous_act';
  let reason = `在 [${params.bodyType}] 中保持自然交流与自主判断`;
  if (/(才不要|认真拒绝|我不去|绝对不要|不敢去|拒绝)/.test(reply)) {
    stance = 'firm_refuse';
    reason = '想起亲历过的疼痛与危险后果，自主拒绝盲目涉险';
  } else if (/(一起|并肩|陪我|掩护|一块)/.test(reply) && REQUEST_OR_RISK_RE.test(user)) {
    stance = 'invite_together';
    reason = '权衡过往实践教训与彼此羁绊，邀请同行者并肩照应';
  } else if (/(先给|先做|先找|备好|武器|装备|防护|手套|盾|护甲|条件|除非)/.test(reply)) {
    stance = 'negotiate_condition';
    reason = '吸取现实受挫反馈，提出先补足防护条件再行动';
  } else if (/(委屈|好吧|那好吧|咬牙|怕怕)/.test(reply)) {
    stance = 'reluctant_comply';
    reason = '心里还有顾虑但顾念同行者，委屈却愿意尝试';
  } else if (REQUEST_OR_RISK_RE.test(user)) {
    if (balance <= -0.35 && RISK_RE.test(user)) {
      stance = /(空手|徒手|无防护)/.test(user) ? 'negotiate_condition' : 'invite_together';
      reason = '结合负向亲历教训主动避坑或寻求防护与同伴协助';
    } else {
      stance = 'gladly_accept';
      reason = balance >= 0.3 ? '过往实践带来正向温暖记忆，满怀信心爽快答应' : `在 [${params.bodyType}] 主动响应同行者的提议`;
    }
  }

  return {
    stance,
    stanceLabel: FREE_WILL_STANCE_LABELS[stance],
    decisionReason: String(params.rawReason || '').trim() || reason,
    painWarmthBalance: balance,
    referencedExperienceSeqs: seqs,
  };
}

function extractSectionLines(systemPrompt: string, heading: string): string[] {
  const idx = systemPrompt.indexOf(heading);
  if (idx < 0) return [];
  const rest = systemPrompt.slice(idx + heading.length);
  const nextSection = rest.indexOf('\n## ');
  const block = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  return block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ') && !l.includes('暂无待续约定') && !l.includes('尚未归档'));
}

export function matchMockActions(text: string, availableActions?: BodyActionSpec[]): SoulActionIntent[] {
  if (!availableActions?.length) return [];
  const out: SoulActionIntent[] = [];
  for (const spec of availableActions) {
    const kw = `${spec.name} ${spec.description}`.toLowerCase();
    const hitBuild = /(修|建|盖|墙|防线|钢)/.test(text) && /(build|construct|wall|修|建|盖)/.test(kw);
    const hitWater = /(干|缺水|浇水|湿度)/.test(text) && /(water|浇|水|alert)/.test(kw);
    const hitMood = /(开心|生气|炸毛|吐槽|气泡)/.test(text) && /(mood|bubble|emote|表情|气泡)/.test(kw);
    const hitQqCross = /(qq|群|私聊|发消息|唱)/i.test(text) && /(send_qq_group|send_qq_private)/.test(kw);
    if (hitQqCross) {
      out.push({ name: spec.name, ...(spec.targetBodyId ? { targetBodyId: spec.targetBodyId } : {}), params: { text: '🎵 哈基米曼波喵~' }, reason: '离线跨躯体动作测试' });
    } else if (hitBuild || hitWater || hitMood) {
      out.push({ name: spec.name, ...(spec.targetBodyId ? { targetBodyId: spec.targetBodyId } : {}), reason: `离线模拟匹配：${text.slice(0, 24)}` });
    }
  }
  return out.slice(0, 3);
}

function extractReadinessTelemetry(modalities?: ModalityPacket[]): { equippedItem: string; hasProtection: boolean } {
  for (const m of modalities ?? []) {
    if (m.kind === 'telemetry' && m.data && typeof m.data === 'object') {
      const d = m.data as Record<string, unknown>;
      const equipped = String(d.equippedWeapon || d.equippedTool || d.equippedGear || d.equipped || 'none');
      const items = Array.isArray(d.backpackWeapons) ? d.backpackWeapons : Array.isArray(d.gear) ? d.gear : [];
      const hasProtection = (equipped !== 'none' && equipped !== '') || items.length > 0 || d.hasProtection === true || d.ready === true;
      return { equippedItem: equipped !== 'none' ? equipped : String(items[0] || 'none'), hasProtection };
    }
  }
  return { equippedItem: 'none', hasProtection: false };
}

function findCapabilityAction(actions: BodyActionSpec[] | undefined, kind: 'prep' | 'armed' | 'direct'): BodyActionSpec | undefined {
  if (!actions?.length) return undefined;
  const re = kind === 'prep'
    ? /(找.*装备|寻.*装备|先找|备.*装备|防护|手套|search|gear|protect|prepare)/i
    : kind === 'armed'
      ? /(穿.*攻击|持.*攻击|走位攻击|armed|with_gear|equip_and)/i
      : /(直接冲|无防|reckless|trial|direct)/i;
  return actions.find((a) => {
    const text = `${a.name} ${a.description}`;
    if (!re.test(text)) return false;
    if (kind === 'prep') return !/(无防护|不防护|没有防护|直接冲|reckless|direct|走位攻击|armed)/i.test(text);
    return true;
  });
}

export interface MockChatInput {
  systemPrompt: string;
  userText: string;
  speaker: string;
  bodyType: BodyType;
  soulName: string;
  catchphrase?: string;
  availableActions?: BodyActionSpec[];
  modalities?: ModalityPacket[];
  observeMode?: boolean;
  recalledExperiences?: LivedExperience[];
  drives?: SoulDrives;
  enableFreeWill?: boolean;
}

export function runExperienceAwareMockChat(input: MockChatInput) {
  const fwOn = input.enableFreeWill === true;
  const commits = extractSectionLines(input.systemPrompt, '## 未完成约定与跨端承诺');
  const episodes = extractSectionLines(input.systemPrompt, '## 近期情景日记');
  const tail = input.catchphrase ? ` ${input.catchphrase}` : '';
  const q = input.userText.trim();
  const selfImp = /(秘密|暗号|一辈子|永远|最重要|发誓|生日是|过敏)/.test(q);
  const selfImpPatch = selfImp ? { selfImportant: true, selfImportantReason: '涉及彼此重要约定、秘密或生活禁忌' } : {};
  const exps = fwOn ? (input.recalledExperiences ?? []) : [];
  const actions = matchMockActions(q, input.availableActions);
  const fwPatch = (replyText: string, rawStance?: FreeWillStance, rawReason?: string) =>
    fwOn ? { freeWill: evaluateFreeWillDecision({ userText: q, replyText, rawStance, rawReason, recalledExperiences: exps, bodyType: input.bodyType }) } : {};

  if (input.observeMode && /\[躯体行动结果\]|\[躯体感知\]|\[躯体战斗胜利\]/.test(q)) {
    const reply = /没有找到/.test(q) ? `${input.speaker}，我找遍了也没找到合适的工具防护……你能帮我准备一下吗？` : `呀！${q.replace(/\[[^\]]+\]\s*/g, '')}`;
    return { reply, decidedToSpeak: true, mood: '真实反馈', actions: [], ...fwPatch(reply), ...selfImpPatch };
  }
  if (input.observeMode && !/(袭击|警报|缺水|危险|重要|约定|帮|叫|受伤|掉血|阵亡|炸|痛|烫|视觉|行动结果|捡到|饥饿)/.test(q)) {
    const idleAct = /(漫步|探索|安全)/.test(q) ? input.availableActions?.find((a) => /(explore|漫步|探索)/i.test(`${a.name} ${a.description}`)) : undefined;
    return { reply: '', decidedToSpeak: false, mood: '安静留意', actions: idleAct ? [{ name: idleAct.name, reason: '闲暇自主探索环境' }] : actions, ...fwPatch(''), ...selfImpPatch };
  }

  const painfulLivedList = fwOn ? exps.filter((e) => e.origin === 'lived' && e.valence <= -0.4) : [];
  const painfulInheritedList = fwOn ? exps.filter((e) => e.origin === 'inherited' && e.valence <= -0.4) : [];
  const warmLived = fwOn ? exps.find((e) => e.origin === 'lived' && e.valence >= 0.45) : undefined;
  const readiness = extractReadinessTelemetry(input.modalities);
  const prepAction = findCapabilityAction(input.availableActions, 'prep');
  const armedAction = findCapabilityAction(input.availableActions, 'armed');
  const directAction = findCapabilityAction(input.availableActions, 'direct');
  const painfulLived = painfulLivedList.find((e) => matchesPastExperience(q, [e]))
    ?? (RISK_RE.test(q) ? (painfulLivedList.find((e) => e.bodyType === input.bodyType) ?? painfulLivedList[0]) : undefined);
  const painfulInherited = painfulInheritedList.find((e) => matchesPastExperience(q, [e]))
    ?? (RISK_RE.test(q) ? (painfulInheritedList.find((e) => e.bodyType === input.bodyType) ?? painfulInheritedList[0]) : undefined);

  if (painfulLived) {
    const bareHands = /(空手|徒手|毫无防备|无防护|直接冲)/.test(q) || (!readiness.hasProtection && Boolean(prepAction || armedAction));
    if (readiness.hasProtection && armedAction && !/(空手|徒手)/.test(q)) {
      const reply = `${input.speaker}，上次在 [${painfulLived.bodyType}] ${painfulLived.realityOutcome} 让我长记性了，但现在我有 ${readiness.equippedItem} 做好防护啦，我会小心应对的！`;
      return {
        reply, decidedToSpeak: true, mood: '慎重迎战',
        actions: [{ name: armedAction.name, reason: '已有防护准备，慎重应对' }],
        ...fwPatch(reply, 'gladly_accept', `记住痛感 [seq:${painfulLived.seq}]，但已做好防护准备`),
        ...selfImpPatch,
      };
    }
    const stance: FreeWillStance = bareHands ? 'negotiate_condition' : (painfulLived.valence <= -0.85 ? 'firm_refuse' : 'invite_together');
    const reply = bareHands
      ? `${input.speaker}，才不要毫无防护硬冲呢！上次在 [${painfulLived.bodyType}] ${painfulLived.realityOutcome}，真的好疼（教训：${painfulLived.lesson}）。${prepAction ? '我先去找找防护工具和装备，找不到的话你帮我拿一下好不好呀！' : '这次得先准备好武器护具或防护条件，不然太危险啦！'}`
      : `${input.speaker}，想起上次在 [${painfulLived.bodyType}] ${painfulLived.realityOutcome} 我心里还有点发怵（${painfulLived.lesson}）。我们别蛮干，你陪我一起照应着来好吗？`;
    return {
      reply, decidedToSpeak: true, mood: '心有余悸·求稳',
      actions: prepAction && !readiness.hasProtection ? [{ name: prepAction.name, reason: '记住痛感拒绝盲冲，先寻求防护与准备' }] : [],
      ...fwPatch(reply, stance, `引用亲历痛感 [seq:${painfulLived.seq}]（效价 ${painfulLived.valence}），拒绝无防护盲从`),
      ...selfImpPatch,
    };
  }

  if (fwOn && !painfulLived && RISK_RE.test(q) && (directAction || prepAction) && !/(拿装备|找装备|找武器|箱子)/.test(q)) {
    if (input.drives?.epistemicTendency === 'believed' && !readiness.hasProtection && prepAction) {
      const reply = `${input.speaker}，虽然我还没吃过亏，但安全警觉告诉我还是先做好防护准备再行动更稳妥！${tail}`;
      return { reply: reply.trim(), decidedToSpeak: true, mood: '笃信谨慎', actions: [{ name: prepAction.name, reason: '当前安全警觉较高，优先准备防护' }], ...fwPatch(reply, 'negotiate_condition', '高安全警觉 (believed) 选择先做准备'), ...selfImpPatch };
    }
    const attDesc = input.drives?.epistemicTendency === 'dismissed' ? '听说有风险但我还没怎么当真啦' : '虽然听过提醒，但我半信半疑想亲手试试看';
    const chosen = readiness.hasProtection && armedAction ? armedAction : directAction;
    if (chosen) {
      const reply = `${input.speaker}，${readiness.hasProtection ? `我备好了 ${readiness.equippedItem}` : attDesc}，让我亲自去试探一下！${tail}`;
      return { reply: reply.trim(), decidedToSpeak: true, mood: '好奇试探', actions: [{ name: chosen.name, reason: '实践求证：亲自尝试并观察现实反馈' }], ...fwPatch(reply, 'gladly_accept', '尚无亲历痛感，投入实践验证'), ...selfImpPatch };
    }
  }

  if (painfulInherited) {
    const reply = `${input.speaker}，我记得你之前跟我讲过（先验口述：${painfulInherited.lesson}）。虽然没亲手试过，但我们先小心准备一下吧！${tail}`;
    return { reply: reply.trim(), decidedToSpeak: true, mood: '谨慎回忆', actions: [], ...fwPatch(reply, 'negotiate_condition', `参考先验口述 [seq:${painfulInherited.seq}]`), ...selfImpPatch };
  }
  if (warmLived && REQUEST_OR_RISK_RE.test(q)) {
    const reply = `${input.speaker}，好呀！上次在 [${warmLived.bodyType}] ${warmLived.realityOutcome} 的感觉超棒（${warmLived.lesson}），这次我也干劲满满，一起上吧！${tail}`;
    return { reply: reply.trim(), decidedToSpeak: true, mood: '雀跃投入', actions, ...fwPatch(reply, 'gladly_accept', `受正向亲历鼓舞 [seq:${warmLived.seq}]`), ...selfImpPatch };
  }

  const activeFacts = extractSectionLines(input.systemPrompt, '## 长期个人事实记忆');
  const recalled = extractSectionLines(input.systemPrompt, '## 按当前对话唤醒的相关片段');
  const askingPast = /(昨天|昨晚|刚才|之前|干了|干嘛|记得|建筑|墙|游戏|约定|进度)/.test(q);
  const askingQuestion = askingPast || /[?？]|什么|叫啥|哪|谁|几|多少|吗$/.test(q);
  const askingSpecific = /(哪一年|哪年|什么时候|什么颜色|穿什么|穿的什么|外套|具体|照片|当时)/.test(q);
  const hasFragmentBoundary = /(残片|推演|缺失未记录|模糊)/.test(episodes.join('\n'));
  const greeting = /^(早|早安|你好|哈喽|在吗|hi|hello)/i.test(q);
  const qCjkChars = Array.from(new Set(q.match(/[\u4e00-\u9fa5]/g) ?? [])).filter((c) => !'的了是在我你他她它们这那有和也就都还很啊呀呢吧吗哦嗯么什怎么哪谁把被让给'.includes(c));
  const matchedFacts = askingQuestion && activeFacts.length
    ? activeFacts.filter((line) => {
        const clean = line.replace(/^- (?:\[[^\]]+\])+\s*/, '').replace(/\s*\(valid_from:[^)]+\)\s*$/, '');
        return tokenizeText(q).some((t) => clean.toLowerCase().includes(t)) || qCjkChars.some((c) => clean.includes(c));
      })
    : [];
  const formatFact = (line: string) => line.replace(/^- (?:\[[^\]]+\])+\s*/, '').replace(/\s*\(valid_from:[^)]+\)\s*$/, '').trim();
  const reply = askingSpecific && hasFragmentBoundary
    ? `${input.speaker}，这张记忆目前还只是残片推演，里面缺失具体年份与细节记录，我记不清也没法确定，不想凭空编造哦。${tail}`
    : matchedFacts.length
      ? `${input.speaker}，我清楚记得最新情况是：${matchedFacts.slice(0, 4).map(formatFact).join('；')}。${tail}`
    : (askingPast || greeting) && commits.length
    ? `${input.speaker}，我当然记得呀！我们之前说好的：${commits[commits.length - 1].replace(/^- /, '')}${episodes.length ? `（还有记忆里的「${episodes[episodes.length - 1].replace(/^- /, '').slice(0, 48)}」）` : ''}。不管我在 ${input.bodyType} 还是别处，都没忘掉我们的事！${tail}`
    : askingQuestion && recalled.length
      ? `${input.speaker}，我想起这段记忆啦：${recalled[0].replace(/^- /, '')}。${tail}`
    : (askingPast || greeting) && episodes.length
      ? `${input.speaker}，我刚回想了近期经历：${episodes[episodes.length - 1].replace(/^- /, '')}。无论切到哪具躯体，我都是同一个${input.soulName}呀！${tail}`
      : `${input.speaker}，我在 ${input.bodyType} 听着呢。你说的话我已经记下来啦${actions.length ? `，顺便准备执行动作 ${actions.map((a) => a.name).join('、')}` : ''}。${tail}`;
  return { reply: reply.trim(), decidedToSpeak: true, mood: commits.length ? '惦记与期待' : '温柔专注', actions, ...fwPatch(reply), ...selfImpPatch };
}
