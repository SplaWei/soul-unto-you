import type { BodyActionSpec, SoulActionIntent } from '../soul/types.ts';

export type ToolCallMode = 'native' | 'tag' | 'dual' | 'none';

export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface SoulToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SoulToolBundle {
  defs: SoulToolDef[];
  openAiTools: Array<{ type: 'function'; function: SoulToolDef }>;
  geminiTools: Array<{ functionDeclarations: SoulToolDef[] }>;
  actionByToolName: Map<string, BodyActionSpec>;
}

export const SOUL_STATE_TOOL_NAME = 'soul_report_state';

export function toValidToolName(rawName: string, idx: number, used: Set<string>): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_-]{0,60}$/.test(rawName) && !used.has(rawName)) return rawName;
  const cleaned = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[^a-zA-Z_]+/, '') || 'action';
  const base = cleaned.slice(0, 44);
  let candidate = `act_${base}_${idx}`;
  let seq = 2;
  while (used.has(candidate)) {
    candidate = `act_${base.slice(0, 38)}_${idx}_${seq}`;
    seq += 1;
  }
  return candidate;
}

export function buildSoulToolBundle(actions?: BodyActionSpec[], observeMode?: boolean): SoulToolBundle {
  const stateTool: SoulToolDef = {
    name: SOUL_STATE_TOOL_NAME,
    description: '报告本轮说话意愿、情绪状态、自由意志抉择姿态与是否值得主动铭记（每轮可调用）',
    parameters: {
      type: 'object',
      properties: {
        speak: { type: 'boolean', description: observeMode ? '静默观察下是否决定开口说话' : '是否向对方回应（直接对话通常为 true）' },
        mood: { type: 'string', description: '当前内心情绪（2~6个汉字，如：温柔安心、警惕犹豫）' },
        stance: {
          type: 'string',
          enum: ['gladly_accept', 'reluctant_comply', 'negotiate_condition', 'invite_together', 'firm_refuse', 'autonomous_act'],
          description: '基于亲历体验做出的自由意志抉择姿态',
        },
        decisionReason: { type: 'string', description: '一句话说明做出该抉择的原因' },
        selfImportant: { type: 'boolean', description: '本轮是否包含重要约定、秘密或对彼此意义非凡的瞬间' },
        selfImportantReason: { type: 'string', description: '若 selfImportant 为 true，简述主动铭记理由' },
      },
      required: ['speak', 'mood', 'stance'],
    },
  };

  const defs: SoulToolDef[] = [stateTool];
  const used = new Set<string>([SOUL_STATE_TOOL_NAME]);
  const actionByToolName = new Map<string, BodyActionSpec>();

  (actions ?? []).forEach((act, idx) => {
    const toolName = toValidToolName(String(act.name || '').trim(), idx, used);
    used.add(toolName);
    actionByToolName.set(toolName, act);

    const props: Record<string, unknown> = {};
    for (const [key, desc] of Object.entries(act.params ?? {})) {
      const lower = String(desc || '').trim().toLowerCase();
      const paramType = lower === 'number' || lower === 'integer' ? 'number' : lower === 'boolean' ? 'boolean' : 'string';
      props[key] = { type: paramType, description: String(desc || key) };
    }
    if (!props.reason) props.reason = { type: 'string', description: '执行该动作的简短原因' };
    if (act.targetBodyId && !props.targetBodyId) {
      props.targetBodyId = { type: 'string', description: `跨躯体目标ID（锁定 ${act.targetBodyId}）` };
    }
    const tag = act.targetBodyId ? ` [跨躯体→${act.targetBodyId}]` : '';
    defs.push({ name: toolName, description: `${act.description}${tag}`, parameters: { type: 'object', properties: props } });
  });

  return {
    defs,
    openAiTools: defs.map((fn) => ({ type: 'function', function: fn })),
    geminiTools: [{ functionDeclarations: defs }],
    actionByToolName,
  };
}

export function buildMetaInstruction(actions?: BodyActionSpec[], observeMode?: boolean, nativeToolsEnabled = true): string {
  const lines = [
    '',
    '## 躯体表达与自由意志结构化意图协议（必须严格遵循）',
    observeMode
      ? '- 当前为「静默环境观察」模式：你可以自主决定是否开口说话（speak: true 或 false）；日常琐碎动态可保持安静只记在心里，遇到危险、疼痛反馈、情绪波动或重要发现再开口。'
      : '- 当前为直接对话模式，请正常回应对方（speak: true），并基于过往亲历体验自主选择 stance 抉择姿态（gladly_accept / reluctant_comply / negotiate_condition / invite_together / firm_refuse / autonomous_act）。',
  ];
  if (actions?.length) {
    lines.push('- 当前与跨躯体开放了以下可执行动作（仅可从列表选用；若你决定拒绝某请求请勿误发冒险动作）：');
    for (const a of actions) {
      const pDesc = a.params ? ` 参数:${JSON.stringify(a.params)}` : '';
      const tag = a.targetBodyId ? ` [跨躯体→${a.targetBodyId}]` : '';
      lines.push(`  · ${a.name}${tag}: ${a.description}${pDesc}`);
    }
  }
  lines.push('- 若你发自内心觉得本轮包含重要约定、秘密或意义非凡的瞬间，请将 `selfImportant` 设为 `true` 并说明理由。');
  if (nativeToolsEnabled) {
    lines.push(
      `- 请优先通过原生工具 \`${SOUL_STATE_TOOL_NAME}\` 与对应的躯体动作工具提交状态与动作意图，并用自然语言直接回复对方（不要把 JSON 或标签写进回复正文）。`,
      '- 仅当当前模型无法调用原生工具时，才退回在回复最末尾附加一行：<soul_meta>{"speak":true,"mood":"情绪","stance":"autonomous_act","decisionReason":"理由","selfImportant":false,"selfImportantReason":"","actions":[]}</soul_meta>',
    );
  } else {
    lines.push(
      '- 请先写出自然的角色回复（若 decide speak=false 可只写一句极简内心注记），并在回复最末尾附上一行 JSON 标签：',
      '  <soul_meta>{"speak":true,"mood":"两个字到六个字的情绪","stance":"autonomous_act","decisionReason":"一句话说明你为何做出这个抉择","selfImportant":false,"selfImportantReason":"","actions":[{"name":"动作名","targetBodyId":"跨躯体时填目标ID","params":{},"reason":"简短原因"}]}</soul_meta>',
    );
  }
  return lines.join('\n');
}

export function stripLeakedSoulMeta(raw: string): string {
  return String(raw ?? '')
    .replace(/```(?:xml|json)?\s*<soul_meta\b[^>]*>[\s\S]*?<\/soul_meta\s*>\s*```/gi, '')
    .replace(/<soul_meta\b[^>]*>[\s\S]*?<\/soul_meta\s*>/gi, '')
    .replace(/(?:```(?:xml|json)?\s*)?<soul_meta\b[\s\S]*$/i, '')
    .replace(/<\/soul_meta\s*>/gi, '')
    .trim();
}

function sanitizeActionParams(rawParams: unknown, spec: BodyActionSpec): Record<string, unknown> | undefined {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return undefined;
  const specParams = spec.params;
  if (!specParams || Object.keys(specParams).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    if (k === 'reason' || k === 'targetBodyId' || v === undefined || !Object.hasOwn(specParams, k)) continue;
    const expected = String(specParams[k] || '').trim().toLowerCase();
    if (expected === 'number' || expected === 'integer') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (expected === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
    } else {
      out[k] = String(v).slice(0, 1000);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function matchAllowedSpec(list: BodyActionSpec[], name: string, requestedTarget?: string): BodyActionSpec | undefined {
  const reqTarget = String(requestedTarget ?? '').trim();
  if (reqTarget) {
    const exact = list.find((a) => a.name === name && a.targetBodyId === reqTarget);
    if (exact) return exact;
  }
  return list.find((a) => a.name === name);
}

export function parseSoulMeta(raw: string, allowedActions?: BodyActionSpec[], defaultSpeak = true) {
  const allowedList = allowedActions ?? [];
  const cleanReply = stripLeakedSoulMeta(raw);
  const match = String(raw ?? '').match(/<soul_meta\b[^>]*>\s*([\s\S]*?)\s*<\/soul_meta\s*>/i);
  if (!match) {
    return { reply: cleanReply, decidedToSpeak: defaultSpeak, mood: '专注陪伴', actions: [] as SoulActionIntent[], hasTag: false };
  }
  try {
    const parsed = JSON.parse(match[1]) as {
      speak?: boolean; mood?: string; stance?: string; decisionReason?: string;
      selfImportant?: boolean; selfImportantReason?: string;
      actions?: Array<{ name?: string; targetBodyId?: string; params?: Record<string, unknown>; reason?: string }>;
    };
    const actions: SoulActionIntent[] = [];
    for (const item of parsed.actions ?? []) {
      const name = String(item?.name ?? '').trim();
      const spec = name ? matchAllowedSpec(allowedList, name, item?.targetBodyId) : undefined;
      if (!spec) continue;
      const targetBodyId = spec.targetBodyId ? String(spec.targetBodyId).trim() : '';
      const params = sanitizeActionParams(item.params, spec);
      actions.push({
        name: spec.name,
        ...(targetBodyId ? { targetBodyId } : {}),
        ...(params ? { params } : {}),
        ...(item.reason ? { reason: String(item.reason).slice(0, 240) } : {}),
      });
    }
    return {
      reply: cleanReply,
      decidedToSpeak: typeof parsed.speak === 'boolean' ? parsed.speak : defaultSpeak,
      mood: String(parsed.mood || '专注陪伴').slice(0, 24),
      actions,
      rawStance: parsed.stance,
      rawReason: parsed.decisionReason,
      ...(parsed.selfImportant ? { selfImportant: true, selfImportantReason: String(parsed.selfImportantReason || '').trim() } : {}),
      hasTag: true,
    };
  } catch {
    return { reply: cleanReply, decidedToSpeak: defaultSpeak, mood: '专注陪伴', actions: [] as SoulActionIntent[], hasTag: true };
  }
}

export function mergeDualTrackTurn(params: {
  rawText: string;
  toolCalls: NativeToolCall[];
  toolBundle?: SoulToolBundle;
  allowedActions?: BodyActionSpec[];
  defaultSpeak: boolean;
}) {
  const allowedList = params.allowedActions ?? [];
  const tagParsed = parseSoulMeta(params.rawText, allowedList, params.defaultSpeak);
  let hasNative = false;
  let nativeSpeak: boolean | undefined;
  let nativeMood: string | undefined;
  let nativeStance: string | undefined;
  let nativeReason: string | undefined;
  let nativeSelfImp: boolean | undefined;
  let nativeSelfImpReason: string | undefined;
  const nativeActions: SoulActionIntent[] = [];

  for (const tc of params.toolCalls) {
    const args = tc.args || {};
    if (tc.name === SOUL_STATE_TOOL_NAME) {
      hasNative = true;
      if (typeof args.speak === 'boolean') nativeSpeak = args.speak;
      if (args.mood) nativeMood = String(args.mood).trim();
      if (args.stance) nativeStance = String(args.stance).trim();
      if (args.decisionReason) nativeReason = String(args.decisionReason).trim();
      if (typeof args.selfImportant === 'boolean') nativeSelfImp = args.selfImportant;
      if (args.selfImportantReason) nativeSelfImpReason = String(args.selfImportantReason).trim();
      continue;
    }
    const spec = params.toolBundle?.actionByToolName.get(tc.name)
      ?? matchAllowedSpec(allowedList, tc.name, typeof args.targetBodyId === 'string' ? args.targetBodyId : undefined);
    if (!spec) continue;
    hasNative = true;
    const cleanParams = sanitizeActionParams(args, spec);
    const targetBodyId = spec.targetBodyId ? String(spec.targetBodyId).trim() : '';
    const reason = args.reason ? String(args.reason).trim().slice(0, 240) : '';
    nativeActions.push({
      name: spec.name,
      ...(targetBodyId ? { targetBodyId } : {}),
      ...(cleanParams ? { params: cleanParams } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  const seen = new Set<string>();
  const actions: SoulActionIntent[] = [];
  for (const act of [...nativeActions, ...tagParsed.actions]) {
    const key = `${act.name}|${act.targetBodyId || ''}|${JSON.stringify(act.params || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(act);
  }

  const toolCallMode: ToolCallMode =
    hasNative && tagParsed.hasTag ? 'dual' : hasNative ? 'native' : tagParsed.hasTag ? 'tag' : 'none';
  return {
    reply: tagParsed.reply,
    decidedToSpeak: nativeSpeak !== undefined ? nativeSpeak : tagParsed.decidedToSpeak,
    mood: String(nativeMood || tagParsed.mood || '专注陪伴').slice(0, 24),
    actions,
    rawStance: nativeStance || tagParsed.rawStance,
    rawReason: nativeReason || tagParsed.rawReason,
    ...(nativeSelfImp ?? tagParsed.selfImportant
      ? { selfImportant: true, selfImportantReason: nativeSelfImpReason || tagParsed.selfImportantReason || '' }
      : {}),
    toolCallMode,
  };
}
