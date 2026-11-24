import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmEndpointConfig, LlmRouterConfig } from '../llm/router.ts';
import type { DreamSchedulerConfig } from '../memory/dream-scheduler.ts';
import type { EmbeddingConfig, RerankConfig, RetrieverConfig } from '../memory/search.ts';
import { readJsonSafe, writeJsonAtomic } from '../soul/archive.ts';
import type { ExperimentalConfig } from '../soul/types.ts';
import type { VoiceConfig } from '../voice/client.ts';
import { isLoopbackBindHost } from './security.ts';

export type { ExperimentalConfig };

export const DEFAULT_EXPERIMENTAL_CONFIG: ExperimentalConfig = {
  enableEmotion: false,
  enableInnerLife: false,
  enableFreeWill: false,
  enableHeartbeat: false,
  enableResurrection: false,
};

export interface HubConfig {
  host: string;
  port: number;
  archiveDir: string;
  llm: LlmRouterConfig;
  embedding: EmbeddingConfig;
  rerank: RerankConfig;
  retriever: RetrieverConfig;
  voice: VoiceConfig;
  dream: DreamSchedulerConfig;
  experimental: ExperimentalConfig;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

export function demoTemplateArchiveDir(): string {
  return path.join(REPO_ROOT, 'examples', 'demo-soul');
}

export function defaultArchiveDir(): string {
  return path.join(REPO_ROOT, 'private-souls', 'default-soul');
}

export function defaultConfigPath(): string {
  return process.env.SOUL_CONFIG
    ? path.resolve(process.env.SOUL_CONFIG)
    : path.join(REPO_ROOT, 'soul-hub.local.json');
}

export function defaultHubConfig(): HubConfig {
  return {
    host: '127.0.0.1',
    port: Number(process.env.SOUL_PORT) || 7777,
    archiveDir: process.env.SOUL_ARCHIVE_DIR ? path.resolve(process.env.SOUL_ARCHIVE_DIR) : defaultArchiveDir(),
    llm: {
      chat: {
        driver: 'mock', model: 'soul-offline-mock', baseUrl: '', apiKey: '',
        projectId: '', location: 'us-central1', temperature: 0.7,
      },
    },
    embedding: {
      enabled: false,
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-embedding:0.6b',
      apiKey: '',
    },
    rerank: {
      enabled: false,
      endpoint: '',
      model: 'Qwen/Qwen3-Reranker-0.6B',
      apiKey: '',
      timeoutMs: 8000,
      topN: 5,
      minScore: 0.25,
      protocol: 'auto',
    },
    retriever: { mode: 'builtin', endpoint: '', apiKey: '', timeoutMs: 4000, topK: 5, minScore: 0.12 },
    voice: { enabled: false, driver: 'gsv', baseUrl: 'http://127.0.0.1:8765', character: 'default' },
    dream: { enabled: true, idleMinutes: 15, minPendingEntries: 4, checkIntervalSec: 60 },
    experimental: { ...DEFAULT_EXPERIMENTAL_CONFIG },
  };
}

function normalizeExperimental(patch: Partial<ExperimentalConfig> | undefined, base: ExperimentalConfig): ExperimentalConfig {
  return {
    enableEmotion: patch?.enableEmotion !== undefined ? Boolean(patch.enableEmotion) : base.enableEmotion,
    enableInnerLife: patch?.enableInnerLife !== undefined ? Boolean(patch.enableInnerLife) : base.enableInnerLife,
    enableFreeWill: patch?.enableFreeWill !== undefined ? Boolean(patch.enableFreeWill) : base.enableFreeWill,
    enableHeartbeat: patch?.enableHeartbeat !== undefined ? Boolean(patch.enableHeartbeat) : base.enableHeartbeat,
    enableResurrection: patch?.enableResurrection !== undefined ? Boolean(patch.enableResurrection) : base.enableResurrection,
  };
}

export function loadHubConfig(configPath = defaultConfigPath()): HubConfig {
  const base = defaultHubConfig();
  const saved = readJsonSafe<Partial<HubConfig>>(configPath, {});
  return {
    host: saved.host || base.host,
    port: Number(process.env.SOUL_PORT) || Number(saved.port) || base.port,
    archiveDir: process.env.SOUL_ARCHIVE_DIR
      ? path.resolve(process.env.SOUL_ARCHIVE_DIR)
      : saved.archiveDir
        ? path.resolve(saved.archiveDir)
        : base.archiveDir,
    llm: {
      chat: { ...base.llm.chat, ...(saved.llm?.chat || {}) },
      ...(saved.llm?.dream ? { dream: saved.llm.dream } : {}),
      ...(saved.llm?.vision ? { vision: saved.llm.vision } : {}),
    },
    embedding: { ...base.embedding, ...(saved.embedding || {}) },
    rerank: { ...base.rerank, ...(saved.rerank || {}) },
    retriever: { ...base.retriever, ...(saved.retriever || {}) },
    voice: { ...base.voice, ...(saved.voice || {}) },
    dream: { ...base.dream, ...(saved.dream || {}) },
    experimental: normalizeExperimental(saved.experimental, base.experimental),
  };
}

function maskKey(val?: string): string {
  const s = String(val ?? '').trim();
  if (!s) return '';
  if (s.length <= 6) return '****';
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

export function sanitizeConfigForUi(cfg: HubConfig): Record<string, unknown> {
  const maskEp = (ep?: LlmEndpointConfig) =>
    ep ? { ...ep, apiKey: maskKey(ep.apiKey), hasApiKey: Boolean(ep.apiKey) } : undefined;
  return {
    host: cfg.host,
    port: cfg.port,
    archiveDir: cfg.archiveDir,
    llm: {
      chat: maskEp(cfg.llm.chat),
      ...(cfg.llm.dream ? { dream: maskEp(cfg.llm.dream) } : {}),
      ...(cfg.llm.vision ? { vision: maskEp(cfg.llm.vision) } : {}),
    },
    embedding: { ...cfg.embedding, apiKey: maskKey(cfg.embedding.apiKey), hasApiKey: Boolean(cfg.embedding.apiKey) },
    rerank: { ...cfg.rerank, apiKey: maskKey(cfg.rerank.apiKey), hasApiKey: Boolean(cfg.rerank.apiKey) },
    retriever: { ...cfg.retriever, apiKey: maskKey(cfg.retriever.apiKey), hasApiKey: Boolean(cfg.retriever.apiKey) },
    voice: { ...cfg.voice, apiKey: maskKey(cfg.voice.apiKey) },
    dream: { ...cfg.dream },
    experimental: { ...cfg.experimental },
  };
}

function mergeSecret(incoming: unknown, current: string | undefined): string {
  const s = String(incoming ?? '').trim();
  if (!s || s.includes('****')) return current || '';
  return s;
}

const clampNum = (v: unknown, fb: number, min: number, max: number, int = false): number => {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) return fb;
  const clamped = Math.max(min, Math.min(max, n));
  return int ? Math.round(clamped) : Number(clamped.toFixed(4));
};

export function saveHubConfig(
  current: HubConfig,
  patch: Partial<HubConfig>,
  configPath = defaultConfigPath(),
): HubConfig {
  const nextChat: LlmEndpointConfig = {
    ...current.llm.chat,
    ...(patch.llm?.chat || {}),
    apiKey: mergeSecret(patch.llm?.chat?.apiKey, current.llm.chat.apiKey),
  };
  const requestedHost = typeof patch.host === 'string' ? patch.host.trim() : '';
  const safeHost = requestedHost
    ? (isLoopbackBindHost(requestedHost) ? requestedHost : (() => { throw new Error('禁止通过接口将监听地址修改为非回环地址'); })())
    : current.host;
  const protoPatch = patch.rerank?.protocol;
  const rerankProtocol = protoPatch === 'dashscope' || protoPatch === 'standard' || protoPatch === 'auto'
    ? protoPatch
    : current.rerank.protocol;
  const next: HubConfig = {
    host: safeHost,
    port: Number(patch.port) || current.port,
    archiveDir: patch.archiveDir ? path.resolve(patch.archiveDir) : current.archiveDir,
    llm: {
      chat: nextChat,
      ...(patch.llm?.dream
        ? { dream: { ...(current.llm.dream || nextChat), ...patch.llm.dream, apiKey: mergeSecret(patch.llm.dream.apiKey, current.llm.dream?.apiKey) } }
        : current.llm.dream ? { dream: current.llm.dream } : {}),
      ...(patch.llm?.vision
        ? { vision: { ...(current.llm.vision || nextChat), ...patch.llm.vision, apiKey: mergeSecret(patch.llm.vision.apiKey, current.llm.vision?.apiKey) } }
        : current.llm.vision ? { vision: current.llm.vision } : {}),
    },
    embedding: {
      ...current.embedding,
      ...(patch.embedding || {}),
      apiKey: mergeSecret(patch.embedding?.apiKey, current.embedding.apiKey),
      ...(patch.embedding?.dimensions !== undefined
        ? { dimensions: clampNum(patch.embedding.dimensions, 0, 0, 8192, true) || undefined }
        : {}),
    },
    rerank: {
      enabled: patch.rerank?.enabled !== undefined ? Boolean(patch.rerank.enabled) : current.rerank.enabled,
      endpoint: patch.rerank?.endpoint !== undefined ? String(patch.rerank.endpoint).trim() : current.rerank.endpoint,
      model: patch.rerank?.model !== undefined ? String(patch.rerank.model).trim() : current.rerank.model,
      apiKey: mergeSecret(patch.rerank?.apiKey, current.rerank.apiKey),
      timeoutMs: clampNum(patch.rerank?.timeoutMs, current.rerank.timeoutMs ?? 8000, 500, 30_000, true),
      topN: clampNum(patch.rerank?.topN, current.rerank.topN ?? 5, 1, 20, true),
      minScore: clampNum(patch.rerank?.minScore, current.rerank.minScore ?? 0.25, 0, 1),
      protocol: rerankProtocol,
    },
    retriever: {
      mode: patch.retriever?.mode === 'http' ? 'http' : patch.retriever?.mode === 'builtin' ? 'builtin' : current.retriever.mode,
      endpoint: patch.retriever?.endpoint !== undefined ? String(patch.retriever.endpoint).trim() : current.retriever.endpoint,
      apiKey: mergeSecret(patch.retriever?.apiKey, current.retriever.apiKey),
      timeoutMs: clampNum(patch.retriever?.timeoutMs, current.retriever.timeoutMs ?? 4000, 500, 30_000, true),
      topK: clampNum(patch.retriever?.topK, current.retriever.topK ?? 5, 1, 20, true),
      minScore: clampNum(patch.retriever?.minScore, current.retriever.minScore ?? 0.12, 0, 1),
    },
    voice: {
      ...current.voice,
      ...(patch.voice || {}),
      apiKey: mergeSecret(patch.voice?.apiKey, current.voice.apiKey),
    },
    dream: {
      enabled: patch.dream?.enabled !== undefined ? Boolean(patch.dream.enabled) : current.dream.enabled,
      idleMinutes: clampNum(patch.dream?.idleMinutes, current.dream.idleMinutes, 0, 10_080),
      minPendingEntries: clampNum(patch.dream?.minPendingEntries, current.dream.minPendingEntries, 1, 500, true),
      checkIntervalSec: patch.dream?.checkIntervalSec !== undefined && Number.isFinite(Number(patch.dream.checkIntervalSec)) && Number(patch.dream.checkIntervalSec) > 0
        ? Number(patch.dream.checkIntervalSec)
        : current.dream.checkIntervalSec,
    },
    experimental: normalizeExperimental(patch.experimental, current.experimental),
  };
  writeJsonAtomic(configPath, next);
  return next;
}
