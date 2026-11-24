import type { IncomingMessage, ServerResponse } from 'node:http';
import { runDreamConsolidation } from '../memory/dream.ts';
import { listRelations } from '../memory/relations.ts';
import { recallMemories } from '../memory/search.ts';
import { addEpisode, upsertCommitment } from '../memory/store.ts';
import { loadSoulArchive } from '../soul/archive.ts';
import { HUB_VERSION } from '../soul/covenant.ts';
import type { BodyType } from '../soul/types.ts';
import { processObserve, processPercept, readJsonBody, sendJson, type SoulHubContext } from './body-api.ts';

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: 'soul_perceive',
    description: '以任意躯体（QQ、游戏、桌宠、ESP32/ROS2机器人等）的身份向灵魂说话并获取回复。',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string' },
        bodyType: { type: 'string' },
        speaker: { type: 'string' },
        accountId: { type: 'string' },
        personId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'soul_observe',
    description: '静默投递环境或游戏观察事件，由灵魂记入日志并自主决定是否开口回应或下发动作。',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string' },
        bodyType: { type: 'string' },
        summary: { type: 'string' },
        allowSpeak: { type: 'boolean' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'soul_recall',
    description: '按关键词或语义召回跨躯体共享的历史记忆片段。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, topK: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'soul_remember',
    description: '写入一条重要情景记忆或跨躯体未完成约定。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        bodyType: { type: 'string' },
        isCommitment: { type: 'boolean' },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'soul_commitments',
    description: '查看当前所有未完成约定与跨端承诺。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_presence',
    description: '获取灵魂当前的全局在场状态（此刻在哪个躯体、在干嘛、情绪和近期轨迹）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_dream',
    description: '触发一次做梦记忆整理：提炼情景事件、未完成约定并更新全息种子。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_seed',
    description: '读取当前 ≤2048 字节的 SEED.md 全息灵魂种子。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_relations',
    description: '读取中性跨端实体身份图与人物熟悉度/账号绑定列表。',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function handleMcpRpc(ctx: SoulHubContext, req: McpRequest): Promise<Record<string, unknown> | null> {
  const id = req.id ?? null;
  const method = req.method;

  if (method === 'notifications/initialized') return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'soul-unto-you', version: HUB_VERSION },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          { uri: 'soul://seed', name: '全息灵魂种子 (SEED.md)', mimeType: 'text/markdown' },
          { uri: 'soul://soul', name: '完整灵魂档案 (SOUL.md)', mimeType: 'text/markdown' },
          { uri: 'soul://resurrection', name: '复活说明书 (RESURRECTION.md)', mimeType: 'text/markdown' },
        ],
      },
    };
  }

  if (method === 'resources/read') {
    const uri = String(req.params?.uri ?? '');
    const archive = loadSoulArchive(ctx.config.archiveDir, 5);
    const text = uri === 'soul://seed'
      ? archive.seedMarkdown
      : uri === 'soul://soul'
        ? archive.soulMarkdown
        : archive.resurrectionMarkdown;
    return {
      jsonrpc: '2.0',
      id,
      result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
    };
  }

  if (method === 'tools/call') {
    const name = String(req.params?.name ?? '');
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    let payload: unknown;

    if (name === 'soul_perceive') {
      const meta: Record<string, unknown> = {};
      if (args.accountId) meta.accountId = String(args.accountId);
      if (args.personId) meta.personId = String(args.personId);
      payload = await processPercept(ctx, {
        bodyId: String(args.bodyId || 'mcp-body'),
        bodyType: (String(args.bodyType || 'robot') as BodyType),
        speaker: String(args.speaker || ''),
        text: String(args.text || ''),
        ...(Object.keys(meta).length ? { metadata: meta } : {}),
      });
    } else if (name === 'soul_observe') {
      payload = await processObserve(ctx, {
        bodyId: String(args.bodyId || 'mcp-observer'),
        bodyType: (String(args.bodyType || 'robot') as BodyType),
        summary: String(args.summary || ''),
        allowSpeak: args.allowSpeak === true,
      });
    } else if (name === 'soul_recall') {
      payload = await recallMemories(ctx.config.archiveDir, String(args.query || ''), {
        topK: Number(args.topK) || 5,
        minScore: ctx.config.retriever.minScore,
        embedding: ctx.config.embedding,
        rerank: ctx.config.rerank,
        retriever: ctx.retriever,
      });
    } else if (name === 'soul_remember') {
      const bType = (String(args.bodyType || 'api') as BodyType);
      const title = String(args.title || '新记忆');
      const summary = String(args.summary || '');
      payload = await ctx.presence.withSoulLock(async () => {
        const ep = addEpisode(ctx.config.archiveDir, {
          bodyType: bType,
          bodyId: 'mcp-tool',
          title,
          summary,
          provenance: 'verified',
        });
        const commitment = args.isCommitment
          ? upsertCommitment(ctx.config.archiveDir, {
              title,
              detail: summary,
              sourceBodyType: bType,
              provenance: 'verified',
            })
          : null;
        return { episode: ep, commitment };
      });
    } else if (name === 'soul_commitments') {
      const archive = loadSoulArchive(ctx.config.archiveDir, 1);
      payload = archive.commitments.filter((c) => c.status === 'active');
    } else if (name === 'soul_presence') {
      payload = ctx.presence.getState();
    } else if (name === 'soul_dream') {
      payload = await runDreamConsolidation(ctx.config.archiveDir, {
        llm: ctx.llm, embedding: ctx.config.embedding, lock: ctx.presence, experimental: ctx.config.experimental,
      });
    } else if (name === 'soul_seed') {
      const archive = loadSoulArchive(ctx.config.archiveDir, 1);
      payload = { seed: archive.seedMarkdown, bytes: Buffer.byteLength(archive.seedMarkdown, 'utf8') };
    } else if (name === 'soul_relations') {
      payload = listRelations(ctx.config.archiveDir);
    } else {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } };
}

export async function handleMcpHttpRequest(
  ctx: SoulHubContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/mcp') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'MCP HTTP 仅支持 POST JSON-RPC' });
    return true;
  }
  try {
    const rpc = await readJsonBody<McpRequest>(req);
    const out = await handleMcpRpc(ctx, rpc);
    if (!out) {
      res.writeHead(204);
      res.end();
      return true;
    }
    sendJson(res, 200, out);
    return true;
  } catch (err) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
    });
    return true;
  }
}
