import type { LlmEndpointConfig } from './router.ts';
import type { NativeToolCall } from './tools.ts';

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmCallOutcome {
  status: number;
  ok: boolean;
  text: string;
  err: string;
  retryable: boolean;
  toolCalls?: NativeToolCall[];
  rawModelParts?: Array<Record<string, unknown>>;
  rawOpenAiToolCalls?: Array<Record<string, unknown>>;
  toolsUnsupported?: boolean;
  usage?: LlmTokenUsage;
}

function extractUsage(raw: Record<string, unknown> | undefined): LlmTokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  const promptTokens = num(raw.prompt_tokens ?? raw.promptTokenCount);
  const completionTokens = num(raw.completion_tokens ?? raw.candidatesTokenCount);
  const totalTokens = num(raw.total_tokens ?? raw.totalTokenCount);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function resolveCandidateModels(ep: LlmEndpointConfig): string[] {
  const rawList = [ep.model, ...(Array.isArray(ep.fallbackModels) ? ep.fallbackModels : [])];
  const flat: string[] = [];
  for (const item of rawList) {
    for (const part of String(item ?? '').split(',')) {
      const m = part.trim();
      if (m) flat.push(m);
    }
  }
  return Array.from(new Set(flat));
}

const MODEL_UNAVAILABLE_RE = /(model.*not found|unknown model|does not exist|invalid.*model|deprecated|decommissioned)/i;

/** 优先判定是否为端点/模型不支持原生 tools 参数的 400/422 错误，避免被 retryable 抢先短路。 */
export function isToolsUnsupportedError(status: number, errBody: string, hadTools: boolean): boolean {
  if (!hadTools || (status !== 400 && status !== 422)) return false;
  if (MODEL_UNAVAILABLE_RE.test(errBody)) return false;
  const mentionsTool = /(tool|function|declaration|tool_choice)/i.test(errBody);
  const mentionsUnsupported = /(not support|unsupported|unknown field|unrecognized|invalid.*argument|disabled)/i.test(errBody);
  return mentionsTool && mentionsUnsupported;
}

export function isRetryableHttpError(status: number, errBody: string, hadTools = false): boolean {
  if (isToolsUnsupportedError(status, errBody, hadTools)) return false;
  if (status === 0) return true;
  if (status === 404 || status === 408 || status === 410 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
    return true;
  }
  if ((status === 400 || status === 403) && /(model.*not found|not supported|does not exist|unknown model|invalid.*model|deprecated|decommissioned|not available)/i.test(errBody)) {
    return true;
  }
  return false;
}

function parseToolArgs(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs as Record<string, unknown>;
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  return {};
}

function extractHttpErrorMessage(raw: string, fallbackStatusText: string): string {
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string };
      const nested = typeof parsed?.error === 'object' ? parsed.error?.message : parsed?.error;
      const msg = String(nested || parsed?.message || '').trim();
      if (msg) return msg.slice(0, 240);
    } catch {}
    return trimmed.replace(/\s+/g, ' ').slice(0, 240);
  }
  return (fallbackStatusText || '未知错误').slice(0, 240);
}

function formatNetworkError(err: unknown, timeoutMs: number): LlmCallOutcome {
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timed?\s*out/i.test(err.message));
  const msg = isTimeout
    ? `请求超时 (${timeoutMs}ms)`
    : `网络请求异常: ${err instanceof Error ? err.message : String(err)}`;
  return { status: 0, ok: false, text: '', err: msg.slice(0, 240), retryable: true };
}

export async function callOpenAiCompatible(
  cfg: LlmEndpointConfig,
  model: string,
  messages: Array<Record<string, unknown>>,
  opts?: { tools?: Array<Record<string, unknown>>; toolChoice?: 'auto' | 'none' },
): Promise<LlmCallOutcome> {
  const rawBase = String(cfg.baseUrl ?? '').trim();
  const apiKey = String(cfg.apiKey ?? '').trim();
  if (!rawBase && !apiKey) {
    return {
      status: 400, ok: false, text: '', retryable: false,
      err: 'OpenAI 兼容驱动未配置 baseUrl 或 apiKey，已阻止向默认公网端点外发数据',
    };
  }
  const base = (rawBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const timeoutMs = cfg.timeoutMs ?? 45000;
  const payload: Record<string, unknown> = { model, messages, temperature: cfg.temperature ?? 0.7 };
  const hadTools = Boolean(opts?.tools?.length);
  if (opts?.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = opts.toolChoice ?? 'auto';
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const errMsg = extractHttpErrorMessage(raw, res.statusText);
      const toolsUnsupported = isToolsUnsupportedError(res.status, errMsg, hadTools);
      return {
        status: res.status, ok: false, text: '', err: errMsg,
        toolsUnsupported,
        retryable: !toolsUnsupported && isRetryableHttpError(res.status, errMsg, hadTools),
      };
    }
    let data: {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> };
        finish_reason?: string;
      }>;
      usage?: Record<string, unknown>;
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { status: res.status, ok: false, text: '', err: `上游返回非 JSON 响应: ${raw.slice(0, 160)}`, retryable: true };
    }
    const choice = data?.choices?.[0];
    const text = String(choice?.message?.content ?? '').trim();
    const rawToolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
    const toolCalls: NativeToolCall[] = [];
    for (let i = 0; i < rawToolCalls.length; i += 1) {
      const tc = rawToolCalls[i] as { id?: string; function?: { name?: string; arguments?: unknown } };
      const name = String(tc?.function?.name ?? '').trim();
      if (!name) continue;
      toolCalls.push({ id: String(tc.id || `call_${i}`), name, args: parseToolArgs(tc.function?.arguments) });
    }
    if (!text && toolCalls.length === 0) {
      const reason = choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : '无输出文本';
      return { status: res.status, ok: false, text: '', err: `模型返回空内容 (${reason})`, retryable: true };
    }
    const usage = extractUsage(data?.usage);
    return {
      status: res.status, ok: true, text, err: '', retryable: false,
      ...(toolCalls.length ? { toolCalls, rawOpenAiToolCalls: rawToolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  } catch (err) {
    return formatNetworkError(err, timeoutMs);
  }
}

export function buildGeminiTarget(cfg: LlmEndpointConfig, model: string): { url: string; headers: Record<string, string> } {
  const apiKey = String(cfg.apiKey ?? '').trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (cfg.driver === 'vertex-express') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    return {
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
      headers,
    };
  }
  if (cfg.driver === 'vertex-ai') {
    const loc = cfg.location || 'us-central1';
    const url = cfg.baseUrl
      ? cfg.baseUrl.replace(/\/+$/, '')
      : `https://${loc}-aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${loc}/publishers/google/models/${model}:generateContent`;
    if (apiKey) {
      if (apiKey.startsWith('ya29.') || apiKey.split('.').length === 3) headers.Authorization = `Bearer ${apiKey}`;
      else headers['x-goog-api-key'] = apiKey;
    }
    return { url, headers };
  }
  const base = (cfg.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  return { url: `${base}/v1beta/models/${model}:generateContent`, headers };
}

export async function callGeminiRest(
  cfg: LlmEndpointConfig,
  model: string,
  systemPrompt: string,
  parts: Array<Record<string, unknown>>,
  opts?: { tools?: Array<Record<string, unknown>>; rawContents?: Array<Record<string, unknown>>; toolConfig?: Record<string, unknown> },
): Promise<LlmCallOutcome> {
  const { url, headers } = buildGeminiTarget(cfg, model);
  const timeoutMs = cfg.timeoutMs ?? 45000;
  const hadTools = Boolean(opts?.tools?.length);
  const payload: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: opts?.rawContents?.length ? opts.rawContents : [{ role: 'user', parts }],
    generationConfig: { temperature: cfg.temperature ?? 0.7 },
  };
  if (opts?.tools?.length) payload.tools = opts.tools;
  if (opts?.toolConfig) payload.toolConfig = opts.toolConfig;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const errMsg = extractHttpErrorMessage(raw, res.statusText);
      const toolsUnsupported = isToolsUnsupportedError(res.status, errMsg, hadTools);
      return {
        status: res.status, ok: false, text: '', err: errMsg,
        toolsUnsupported,
        retryable: !toolsUnsupported && isRetryableHttpError(res.status, errMsg, hadTools),
      };
    }
    let data: {
      candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: Record<string, unknown>;
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { status: res.status, ok: false, text: '', err: `上游返回非 JSON 响应: ${raw.slice(0, 160)}`, retryable: true };
    }
    const candidate = data?.candidates?.[0];
    const rawParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = rawParts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    const toolCalls: NativeToolCall[] = [];
    rawParts.forEach((p, idx) => {
      const fc = p.functionCall as { name?: string; args?: unknown } | undefined;
      const name = String(fc?.name ?? '').trim();
      if (!name) return;
      toolCalls.push({ id: `gem_call_${idx}`, name, args: parseToolArgs(fc?.args) });
    });
    if (!text && toolCalls.length === 0) {
      const reason = data?.promptFeedback?.blockReason || candidate?.finishReason || '无输出文本';
      return { status: res.status, ok: false, text: '', err: `模型返回空内容 (${reason})`, retryable: true };
    }
    const usage = extractUsage(data?.usageMetadata);
    return {
      status: res.status, ok: true, text, err: '', retryable: false,
      ...(toolCalls.length ? { toolCalls, rawModelParts: rawParts } : {}),
      ...(usage ? { usage } : {}),
    };
  } catch (err) {
    return formatNetworkError(err, timeoutMs);
  }
}
