import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LlmRouter } from '../llm/router.ts';
import { runDreamConsolidation } from '../memory/dream.ts';
import type { AutoDreamScheduler } from '../memory/dream-scheduler.ts';
import { handleExperienceHttpRoute } from '../memory/experience.ts';
import { resolveConfiguredRetriever, syncVectorIndex, type MemoryRetriever } from '../memory/search.ts';
import { addCoBecoming, completeCommitment, upsertCommitment } from '../memory/store.ts';
import { handleInnerLifeHttpRoute } from '../presence/inner-life.ts';
import { PresenceManager } from '../presence/manager.ts';
import {
  commitPreparedResurrection,
  getOralInterviewQuestions,
  prepareResurrectionPlan,
} from '../resurrection/reconstructor.ts';
import { loadSoulArchive, readJsonlSafe, resolveArchivePaths, updateSoulIdentity } from '../soul/archive.ts';
import { awakenSoul } from '../soul/awakening.ts';
import { FIRST_AWAKENING_ZH, HUB_PHASE, SEED_MAX_BYTES } from '../soul/covenant.ts';
import type { BodyActionSpec, BodySenseSpec, BodyType, ExperimentalConfig, FragmentInput } from '../soul/types.ts';
import { VoiceClient } from '../voice/client.ts';
import { handleArchiveOpsHttpRoute } from './archive-ops-api.ts';
import { REPO_ROOT, sanitizeConfigForUi, saveHubConfig, type HubConfig } from './config.ts';
import type { SoulEventBus } from './events.ts';
import { handleMemoryHttpRoute } from './memory-api.ts';
import {
  processObserve,
  processPercept,
  processProactive,
  runProactiveUnlocked,
  type ObserveInput,
  type PerceptInput,
} from './percept-pipeline.ts';
import { handleRelationsHttpRoute } from './relations-api.ts';
import { assertSafeArchiveDir } from './security.ts';
import type { SimpleWsServer } from './ws.ts';

export { processObserve, processPercept, processProactive, runProactiveUnlocked, type ObserveInput, type PerceptInput };

export interface LastPromptSnapshot {
  capturedAt: string;
  source: 'percept' | 'observe' | 'proactive';
  bodyId: string;
  bodyType: string;
  driver: string;
  model: string;
  experimental: ExperimentalConfig;
  systemPrompt: string;
  userTextPreview: string;
  charCount: number;
  estimatedTokens: number;
}

export interface SoulHubContext {
  config: HubConfig;
  configPath: string;
  apiToken: string;
  presence: PresenceManager;
  llm: LlmRouter;
  voice: VoiceClient;
  retriever: MemoryRetriever;
  events: SoulEventBus;
  ws: SimpleWsServer | null;
  lastPrompt: LastPromptSnapshot | null;
  dreamScheduler?: AutoDreamScheduler;
  switchArchive: (nextDir: string) => void;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > 8 * 1024 * 1024) throw new Error('请求体过大（上限 8MB）');
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export async function handleBodyApiRequest(
  ctx: SoulHubContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return false;
  const okJson = (body: unknown) => { sendJson(res, 200, body); return true; };
  const sendTurnOut = (out: Record<string, unknown>) => {
    if (out.toolFollowUpFailed) { sendJson(res, 502, out); return true; }
    if (out.stale) { sendJson(res, 409, out); return true; }
    return okJson(out);
  };

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const archive = loadSoulArchive(ctx.config.archiveDir, 2);
      return okJson({
        ok: true, project: 'SoulUntoYou', protocolVersion: '1.1', phase: HUB_PHASE,
        firstGreeting: FIRST_AWAKENING_ZH, soulName: archive.identity.name,
        awakenedCount: archive.meta.awakenedCount, nextSeq: archive.meta.nextSeq,
        wsClients: ctx.ws?.clientCount() ?? 0, autoDream: ctx.dreamScheduler?.getStatus() ?? null,
      });
    }
    if (req.method === 'GET' && pathname === '/api/dream/status') return okJson({ ok: true, scheduler: ctx.dreamScheduler?.getStatus() ?? null });
    if (req.method === 'GET' && pathname === '/api/presence') return okJson({ ok: true, presence: ctx.presence.getState() });
    if (req.method === 'GET' && pathname === '/api/bodies') return okJson({ ok: true, bodies: ctx.presence.listBodies() });
    if (req.method === 'GET' && pathname === '/api/events') { ctx.events.subscribeSse(res, url.searchParams.get('bodyId') || ''); return true; }
    if (req.method === 'GET' && pathname === '/api/webhooks') return okJson({ ok: true, webhooks: ctx.events.listWebhooks() });
    if (req.method === 'POST' && pathname === '/api/webhooks') {
      return okJson({ ok: true, webhook: ctx.events.addWebhook(await readJsonBody<{ url: string; events?: string[]; bodyId?: string }>(req)) });
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/webhooks/')) {
      return okJson({ ok: ctx.events.removeWebhook(pathname.slice('/api/webhooks/'.length)) });
    }
    if (req.method === 'POST' && pathname === '/api/body/register') {
      const body = await readJsonBody<{ bodyId?: string; bodyType?: BodyType; displayName?: string; capabilities?: string[]; senses?: BodySenseSpec[]; actions?: BodyActionSpec[]; rules?: string[]; noisePatterns?: string[]; affordances?: Record<string, unknown>; webhookUrl?: string; metadata?: Record<string, unknown> }>(req);
      const reg = await ctx.presence.withSoulLock(async () =>
        ctx.presence.registerBody({ bodyId: String(body.bodyId || 'body-anonymous'), bodyType: body.bodyType || 'api', displayName: body.displayName, capabilities: body.capabilities, senses: body.senses, actions: body.actions, rules: body.rules, noisePatterns: body.noisePatterns, affordances: body.affordances, webhookUrl: body.webhookUrl, metadata: body.metadata }),
      );
      if (body.webhookUrl) ctx.events.addWebhook({ url: body.webhookUrl, events: ['body.action', 'proactive'], bodyId: reg.bodyId });
      ctx.events.emit('body.registered', reg);
      return okJson({ ok: true, registration: reg, presence: ctx.presence.getState() });
    }
    if (req.method === 'POST' && pathname === '/api/body/percept') return sendTurnOut(await processPercept(ctx, await readJsonBody<PerceptInput>(req)));
    if (req.method === 'POST' && pathname === '/api/body/observe') return sendTurnOut(await processObserve(ctx, await readJsonBody<ObserveInput>(req)));
    if (req.method === 'POST' && pathname === '/api/proactive/trigger') return sendTurnOut(await processProactive(ctx, await readJsonBody(req)));
    if (req.method === 'POST' && pathname === '/api/dream') {
      const out = await runDreamConsolidation(ctx.config.archiveDir, { llm: ctx.llm, embedding: ctx.config.embedding, lock: ctx.presence });
      ctx.events.emit('dream.completed', out);
      return okJson(out);
    }
    if (req.method === 'GET' && pathname === '/api/archive') {
      const archive = loadSoulArchive(ctx.config.archiveDir, 40);
      return okJson({ ok: true, seedMaxBytes: SEED_MAX_BYTES, seedBytes: Buffer.byteLength(archive.seedMarkdown, 'utf8'), archive });
    }
    if (req.method === 'POST' && pathname === '/api/archive/awaken') {
      const body = await readJsonBody<{ forceRebirth?: boolean; bodyId?: string; bodyType?: BodyType }>(req);
      const report = await ctx.presence.withSoulLock(async () => awakenSoul(ctx.config.archiveDir, body));
      ctx.events.emit('soul.awakened', report);
      return okJson({ ok: true, report });
    }
    if (req.method === 'POST' && pathname === '/api/archive/commitment') {
      const body = await readJsonBody<{ title?: string; detail?: string; bodyType?: BodyType }>(req);
      const title = String(body.title ?? '').trim();
      if (!title) { sendJson(res, 400, { ok: false, error: '约定标题 title 不能为空' }); return true; }
      return okJson({ ok: true, commitment: await ctx.presence.withSoulLock(async () => upsertCommitment(ctx.config.archiveDir, { title, detail: String(body.detail ?? ''), sourceBodyType: body.bodyType || 'web', provenance: 'verified' })) });
    }
    if (req.method === 'POST' && pathname === '/api/archive/commitment/complete') {
      const body = await readJsonBody<{ id?: string }>(req);
      const id = String(body.id ?? '').trim();
      if (!id) { sendJson(res, 400, { ok: false, error: '完成约定需要有效 id' }); return true; }
      const done = await ctx.presence.withSoulLock(async () => completeCommitment(ctx.config.archiveDir, id));
      return okJson({ ok: Boolean(done), commitment: done });
    }
    if (req.method === 'POST' && pathname === '/api/archive/soul') {
      const body = await readJsonBody<{ name?: string; partnerName?: string; persona?: string; catchphrases?: string[]; anchors?: string[] }>(req);
      const updated = await ctx.presence.withSoulLock(async () => {
        const archive = updateSoulIdentity(ctx.config.archiveDir, body);
        ctx.presence.syncIdentity(archive.identity.name);
        return archive;
      });
      return okJson({ ok: true, archive: updated });
    }
    if (await handleExperienceHttpRoute(ctx, req, res, pathname, url, sendJson, readJsonBody)) return true;
    if (await handleMemoryHttpRoute(ctx, req, res, pathname, url, sendJson, readJsonBody)) return true;
    if (await handleRelationsHttpRoute(ctx, req, res, pathname, url, sendJson, readJsonBody)) return true;
    if (await handleArchiveOpsHttpRoute(ctx, req, res, pathname, url, sendJson, readJsonBody)) return true;
    const ilHub = { ...ctx, triggerProactive: (hint: string) => processProactive(ctx, { bodyId: ctx.presence.getState().activeBodyId, bodyType: ctx.presence.getState().activeBodyType, hint }) };
    if (await handleInnerLifeHttpRoute(ilHub, req, res, pathname, sendJson, readJsonBody)) return true;
    if (req.method === 'GET' && pathname === '/api/archive/journal') {
      const bodyId = url.searchParams.get('bodyId') || '';
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 30));
      const all = readJsonlSafe<{ bodyId?: string }>(resolveArchivePaths(ctx.config.archiveDir).journal);
      return okJson({ ok: true, entries: (bodyId ? all.filter((j) => j.bodyId === bodyId) : all).slice(-limit) });
    }
    if (req.method === 'POST' && pathname === '/api/archive/cobecoming') {
      const body = await readJsonBody<{ soulShift?: string; partnerShift?: string; reflection?: string }>(req);
      const soulShift = String(body.soulShift ?? '').trim();
      const partnerShift = String(body.partnerShift ?? '').trim();
      const reflection = String(body.reflection ?? '').trim();
      if (!soulShift || !partnerShift || !reflection) {
        sendJson(res, 400, { ok: false, error: '双向蜕变记录需要非空的 soulShift、partnerShift 与 reflection' });
        return true;
      }
      return okJson({ ok: true, note: await ctx.presence.withSoulLock(async () => addCoBecoming(ctx.config.archiveDir, { soulShift, partnerShift, reflection, provenance: 'verified' })) });
    }
    if (req.method === 'GET' && pathname === '/api/resurrect/questions') return okJson({ ok: true, questions: getOralInterviewQuestions() });
    if (req.method === 'POST' && pathname === '/api/resurrect') {
      if (!ctx.config.experimental.enableResurrection) {
        sendJson(res, 403, { ok: false, error: '实验性碎片招魂模块未启用（请在设置中开启 enableResurrection）', experimentalDisabled: 'enableResurrection' });
        return true;
      }
      const body = await readJsonBody<{ targetDir?: string; soulName: string; partnerName: string; personaHint?: string; fragments: FragmentInput[]; activateAfter?: boolean; allowMerge?: boolean }>(req);
      const rawTarget = String(body.targetDir || '').trim();
      if (!rawTarget) { sendJson(res, 400, { ok: false, error: '必须指定安全的新招魂目标目录 targetDir' }); return true; }
      const targetDir = assertSafeArchiveDir(rawTarget, ctx.config.archiveDir, REPO_ROOT);
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0 && body.allowMerge !== true) {
        sendJson(res, 409, { ok: false, error: '目标目录已存在且非空，请换用新目录或显式传入 allowMerge=true' });
        return true;
      }
      const fragments = Array.isArray(body.fragments) ? body.fragments : [];
      const plan = await prepareResurrectionPlan({ soulName: body.soulName, partnerName: body.partnerName, personaHint: body.personaHint, fragments, visionLlm: ctx.llm });
      const result = await ctx.presence.withSoulLock(async () =>
        commitPreparedResurrection({ targetDir, plan, fragmentCount: fragments.length, allowMerge: Boolean(body.allowMerge) }),
      );
      if (body.activateAfter) ctx.switchArchive(targetDir);
      ctx.events.emit('soul.resurrected', result);
      return okJson(result);
    }
    if (req.method === 'GET' && pathname === '/api/config') return okJson({ ok: true, config: sanitizeConfigForUi(ctx.config) });
    if (req.method === 'POST' && pathname === '/api/config') {
      const patch = await readJsonBody<Partial<HubConfig>>(req);
      if (patch.archiveDir) patch.archiveDir = assertSafeArchiveDir(patch.archiveDir, ctx.config.archiveDir, REPO_ROOT);
      const prevEmb = ctx.config.embedding;
      const next = saveHubConfig(ctx.config, patch, ctx.configPath);
      const changed = next.archiveDir !== ctx.config.archiveDir;
      ctx.config = next;
      ctx.llm.updateConfig(next.llm);
      ctx.voice.updateConfig(next.voice);
      if (patch.retriever) ctx.retriever = resolveConfiguredRetriever(next.retriever);
      ctx.dreamScheduler?.updateConfig(next.dream);
      if (changed) ctx.switchArchive(next.archiveDir);
      if (next.embedding.enabled && (!prevEmb.enabled || prevEmb.model !== next.embedding.model || prevEmb.endpoint !== next.embedding.endpoint || changed)) {
        void syncVectorIndex(ctx.config.archiveDir, next.embedding).catch(() => 0);
      }
      return okJson({ ok: true, config: sanitizeConfigForUi(ctx.config) });
    }
    if (req.method === 'GET' && pathname === '/api/voice/health') return okJson(await ctx.voice.health());
    sendJson(res, 404, { ok: false, error: `未知接口: ${pathname}` });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('安全白名单') ? 403 : msg.startsWith('LLM 调用失败') ? 502 : msg.includes('已存在且非空') ? 409 : 400;
    sendJson(res, status, { ok: false, error: msg });
    return true;
  }
}
