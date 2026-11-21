import type { DreamLlmAdapter } from '../memory/dream.ts';
import type { ResurrectionLlmAdapter } from '../resurrection/reconstructor.ts';
import { evaluateFreeWillDecision, runExperienceAwareMockChat } from '../soul/free-will.ts';
import type {
  BodyActionSpec, BodyType, FreeWillDecision, LivedExperience,
  ModalityPacket, SoulActionIntent, SoulDrives,
} from '../soul/types.ts';
import {
  buildMetaInstruction, buildSoulToolBundle, mergeDualTrackTurn, SOUL_STATE_TOOL_NAME,
  type NativeToolCall, type SoulToolBundle, type ToolCallMode,
} from './tools.ts';
import { callGeminiRest, callOpenAiCompatible, resolveCandidateModels, type LlmCallOutcome } from './transport.ts';

export type LlmDriver = 'mock' | 'openai-compatible' | 'gemini-aistudio' | 'vertex-express' | 'vertex-ai';

export interface LlmEndpointConfig {
  driver: LlmDriver;
  model: string;
  fallbackModels?: string[];
  toolCalling?: 'auto' | 'native' | 'tag';
  baseUrl?: string;
  apiKey?: string;
  projectId?: string;
  location?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmRouterConfig {
  chat: LlmEndpointConfig;
  dream?: LlmEndpointConfig;
  vision?: LlmEndpointConfig;
}

export interface ChatTurnInput {
  systemPrompt: string;
  externalSystemContext?: string;
  userText: string;
  speaker: string;
  bodyType: BodyType;
  soulName: string;
  catchphrase?: string;
  images?: Array<{ base64: string; mimeType?: string }>;
  availableActions?: BodyActionSpec[];
  modalities?: ModalityPacket[];
  observeMode?: boolean;
  recalledExperiences?: LivedExperience[];
  drives?: SoulDrives;
}

export interface ChatTurnResult {
  reply: string;
  decidedToSpeak: boolean;
  mood: string;
  actions: SoulActionIntent[];
  freeWill?: FreeWillDecision;
  selfImportant?: boolean;
  selfImportantReason?: string;
  driver: LlmDriver;
  model: string;
  toolCallMode?: ToolCallMode;
  toolFollowUpFailed?: boolean;
  toolFollowUpError?: string;
  fallbackFrom?: string;
  attemptedModels?: string[];
}

function formatModalitiesNote(modalities?: ModalityPacket[]): string {
  if (!modalities?.length) return '';
  const nonImg = modalities.filter((m) => m.kind !== 'image');
  if (!nonImg.length) return '';
  const lines = nonImg.map((m) => {
    const val = typeof m.data === 'string' ? m.data : JSON.stringify(m.data);
    return `- [${m.kind}]${m.label ? ` ${m.label}:` : ''} ${String(val).slice(0, 320)}`;
  });
  return `\n[多模态感官附带载荷]\n${lines.join('\n')}`;
}

export class LlmRouter implements DreamLlmAdapter, ResurrectionLlmAdapter {
  private config: LlmRouterConfig;

  constructor(config: LlmRouterConfig) {
    this.config = config;
  }

  updateConfig(next: LlmRouterConfig): void {
    this.config = next;
  }

  getConfig(): LlmRouterConfig {
    return this.config;
  }

  isRealLlm(): boolean {
    const ep = this.config.dream ?? this.config.chat;
    return ep.driver !== 'mock' && Boolean(ep.apiKey || ep.baseUrl);
  }

  isRealVision(): boolean {
    const ep = this.config.vision ?? this.config.chat;
    return ep.driver !== 'mock' && Boolean(ep.apiKey || ep.baseUrl);
  }

  private async runEndpoint(
    ep: LlmEndpointConfig,
    systemPrompt: string,
    userText: string,
    images?: Array<{ base64: string; mimeType?: string }>,
    toolOpts?: { bundle?: SoulToolBundle; fallbackSystemPrompt?: string },
  ): Promise<{
    text: string;
    toolCalls: NativeToolCall[];
    rawModelParts?: Array<Record<string, unknown>>;
    rawOpenAiToolCalls?: Array<Record<string, unknown>>;
    modelUsed: string;
    attemptedModels: string[];
    fallbackFrom?: string;
  }> {
    if (ep.driver !== 'mock' && !String(ep.baseUrl ?? '').trim() && !String(ep.apiKey ?? '').trim()) {
      throw new Error('LLM 未配置：请先填写 baseUrl 或 apiKey，已阻止向默认公网端点外发灵魂档案');
    }
    const models = resolveCandidateModels(ep);
    if (!models.length) throw new Error('LLM 调用失败：未配置可用模型');
    const attempts: string[] = [];
    const tried: string[] = [];

    for (let i = 0; i < models.length; i += 1) {
      const m = models[i];
      tried.push(m);
      const callSingle = (sys: string, useTools: boolean): Promise<LlmCallOutcome> => {
        if (ep.driver === 'openai-compatible') {
          const content: unknown = images?.length
            ? [{ type: 'text', text: userText }, ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.base64}` } }))]
            : userText;
          return callOpenAiCompatible(
            ep, m, [{ role: 'system', content: sys }, { role: 'user', content }],
            useTools && toolOpts?.bundle ? { tools: toolOpts.bundle.openAiTools, toolChoice: 'auto' } : undefined,
          );
        }
        const parts: Array<Record<string, unknown>> = [{ text: userText }];
        for (const img of images ?? []) parts.push({ inlineData: { mimeType: img.mimeType || 'image/png', data: img.base64 } });
        return callGeminiRest(ep, m, sys, parts, useTools && toolOpts?.bundle ? { tools: toolOpts.bundle.geminiTools } : undefined);
      };

      const wantTools = Boolean(toolOpts?.bundle);
      let out = await callSingle(systemPrompt, wantTools);
      if (!out.ok && out.toolsUnsupported && wantTools) {
        out = await callSingle(toolOpts?.fallbackSystemPrompt || systemPrompt, false);
      }
      if (out.ok) {
        return {
          text: out.text,
          toolCalls: out.toolCalls ?? [],
          rawModelParts: out.rawModelParts,
          rawOpenAiToolCalls: out.rawOpenAiToolCalls,
          modelUsed: m,
          attemptedModels: tried,
          ...(i > 0 ? { fallbackFrom: models[0] } : {}),
        };
      }
      const statusLabel = out.status ? `HTTP ${out.status}` : '网络异常';
      attempts.push(`[${m}] ${statusLabel}: ${out.err}`);
      if (!out.retryable) break;
    }
    throw new Error(`LLM 调用失败（已尝试 ${attempts.length} 个模型）: ${attempts.join(' | ')}`);
  }

  private async completeAfterToolCalls(
    ep: LlmEndpointConfig,
    model: string,
    followSystemPrompt: string,
    userPromptText: string,
    images: Array<{ base64: string; mimeType?: string }> | undefined,
    first: { toolCalls: NativeToolCall[]; rawModelParts?: Array<Record<string, unknown>>; rawOpenAiToolCalls?: Array<Record<string, unknown>> },
    toolBundle?: SoulToolBundle,
  ): Promise<{ ok: boolean; text: string; err?: string }> {
    try {
      let out: LlmCallOutcome;
      if (ep.driver === 'openai-compatible') {
        const userContent: unknown = images?.length
          ? [{ type: 'text', text: userPromptText }, ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.base64}` } }))]
          : userPromptText;
        const toolResults = first.toolCalls.map((tc) => ({
          role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: true, status: 'accepted' }),
        }));
        const assistantToolCalls = first.rawOpenAiToolCalls?.length
          ? first.rawOpenAiToolCalls
          : first.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
        out = await callOpenAiCompatible(ep, model, [
          { role: 'system', content: followSystemPrompt },
          { role: 'user', content: userContent },
          { role: 'assistant', content: null, tool_calls: assistantToolCalls },
          ...toolResults,
        ], toolBundle ? { tools: toolBundle.openAiTools, toolChoice: 'none' } : undefined);
      } else {
        const userParts: Array<Record<string, unknown>> = [{ text: userPromptText }];
        for (const img of images ?? []) userParts.push({ inlineData: { mimeType: img.mimeType || 'image/png', data: img.base64 } });
        const modelParts = first.rawModelParts?.length
          ? first.rawModelParts
          : first.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.args } }));
        const fnRespParts = first.toolCalls.map((tc) => ({
          functionResponse: { name: tc.name, response: { ok: true, status: 'accepted' } },
        }));
        out = await callGeminiRest(ep, model, followSystemPrompt, [], {
          rawContents: [{ role: 'user', parts: userParts }, { role: 'model', parts: modelParts }, { role: 'user', parts: fnRespParts }],
          ...(toolBundle ? { tools: toolBundle.geminiTools, toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
        });
      }
      return out.ok ? { ok: true, text: out.text } : { ok: false, text: '', err: out.err || `HTTP ${out.status}` };
    } catch (err) {
      return { ok: false, text: '', err: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(input: ChatTurnInput): Promise<ChatTurnResult> {
    const fullUserText = `${input.userText}${formatModalitiesNote(input.modalities)}`;
    if (this.config.chat.driver === 'mock') {
      const mockOut = runExperienceAwareMockChat({
        systemPrompt: input.systemPrompt, userText: fullUserText, speaker: input.speaker,
        bodyType: input.bodyType, soulName: input.soulName, catchphrase: input.catchphrase,
        availableActions: input.availableActions, modalities: input.modalities,
        observeMode: input.observeMode, recalledExperiences: input.recalledExperiences, drives: input.drives,
      });
      return { ...mockOut, driver: 'mock', model: 'soul-offline-mock' };
    }
    const useNative = this.config.chat.toolCalling !== 'tag';
    const toolBundle = useNative ? buildSoulToolBundle(input.availableActions, input.observeMode) : undefined;
    const extCtx = input.externalSystemContext?.trim()
      ? `\n\n## 当前外部躯体客户端环境与指令说明\n请保持你的灵魂人格与跨躯体记忆，同时按需遵循以下客户端环境状态与命令规范：\n${input.externalSystemContext.trim().slice(0, 4000)}`
      : '';
    const baseSystem = `${input.systemPrompt}${extCtx}`;
    const fullSystem = `${baseSystem}${buildMetaInstruction(input.availableActions, input.observeMode, useNative)}`;
    const fallbackSystem = `${baseSystem}${buildMetaInstruction(input.availableActions, input.observeMode, false)}`;
    const userPromptText = `[${input.bodyType}] ${input.speaker}: ${fullUserText}`;

    const first = await this.runEndpoint(this.config.chat, fullSystem, userPromptText, input.images, {
      bundle: toolBundle, fallbackSystemPrompt: fallbackSystem,
    });
    let finalText = first.text;
    let toolFollowUpFailed = false;
    let toolFollowUpError: string | undefined;

    if (!finalText && first.toolCalls.length > 0) {
      const stateCall = first.toolCalls.find((tc) => tc.name === SOUL_STATE_TOOL_NAME);
      const explicitSpeak = typeof stateCall?.args.speak === 'boolean' ? stateCall.args.speak : undefined;
      if (explicitSpeak !== false && (!input.observeMode || explicitSpeak === true)) {
        const followSys = `${baseSystem}\n\n请基于刚刚提交的状态与动作工具，直接用自然温暖的语言回复对方（不要输出 <soul_meta> 或 JSON）。`;
        const followUp = await this.completeAfterToolCalls(
          this.config.chat, first.modelUsed, followSys, userPromptText, input.images, first, toolBundle,
        );
        if (followUp.ok && followUp.text.trim()) {
          finalText = followUp.text;
        } else {
          toolFollowUpFailed = true;
          toolFollowUpError = followUp.err || '工具二轮补全失败';
        }
      }
    }

    const merged = mergeDualTrackTurn({
      rawText: finalText, toolCalls: first.toolCalls, toolBundle,
      allowedActions: input.availableActions, defaultSpeak: !input.observeMode,
    });
    const reply = toolFollowUpFailed ? '' : merged.reply;
    const actions = toolFollowUpFailed ? [] : merged.actions;
    const freeWill = evaluateFreeWillDecision({
      userText: input.userText, replyText: reply, rawStance: merged.rawStance,
      rawReason: merged.rawReason, recalledExperiences: input.recalledExperiences ?? [], bodyType: input.bodyType,
    });
    return {
      reply,
      decidedToSpeak: toolFollowUpFailed ? false : merged.decidedToSpeak,
      mood: merged.mood,
      actions,
      freeWill,
      ...(merged.selfImportant ? { selfImportant: true, selfImportantReason: merged.selfImportantReason } : {}),
      driver: this.config.chat.driver,
      model: first.modelUsed,
      toolCallMode: merged.toolCallMode,
      ...(toolFollowUpFailed ? { toolFollowUpFailed: true, toolFollowUpError } : {}),
      attemptedModels: first.attemptedModels,
      ...(first.fallbackFrom ? { fallbackFrom: first.fallbackFrom } : {}),
    };
  }

  async dreamSummarize(prompt: string): Promise<string> {
    const ep = this.config.dream ?? this.config.chat;
    return (await this.runEndpoint(ep, '你是严谨温柔的长期记忆整理器，仅输出要求格式的 JSON。', prompt)).text;
  }

  async writeInnerNote(prompt: string): Promise<string> {
    const ep = this.config.dream ?? this.config.chat;
    return (await this.runEndpoint(ep, '你是温柔真实的灵魂，请用第一人称自然写下简短内心随笔，仅输出纯文本，绝不输出 JSON。', prompt)).text;
  }

  async reconstructAnalyze(prompt: string): Promise<string> {
    const ep = this.config.dream ?? this.config.chat;
    return (await this.runEndpoint(ep, '你是严谨而温柔的灵魂档案重构师，忠实溯源绝不虚伪捏造，仅输出 JSON。', prompt)).text;
  }

  async extractFromImage(prompt: string, imageBase64: string, mimeType = 'image/png'): Promise<string> {
    const ep = this.config.vision ?? this.config.chat;
    const clean = imageBase64.replace(/^data:[^;]+;base64,/, '');
    return (await this.runEndpoint(ep, '你是忠实还原碎片记忆的档案员。', prompt, [{ base64: clean, mimeType }])).text;
  }
}
