import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BodyType } from '../soul/types.ts';
import { processPercept, readJsonBody, sendJson, type SoulHubContext } from './body-api.ts';

interface OpenAiMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

function contentToText(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => p.text || '').join('\n').trim();
  }
  return '';
}

function extractLastUserText(messages: OpenAiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return contentToText(m.content);
  }
  return '';
}

function extractSystemContext(messages: OpenAiMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const txt = contentToText(m.content).trim();
    if (txt) blocks.push(txt);
  }
  return blocks.join('\n\n').trim().slice(0, 4000);
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg).trim();
  } catch {
    return seg.trim();
  }
}

function parseOpenAiProxyRoute(pathname: string): { kind: 'models' | 'chat'; bodyType?: string; bodyId?: string } | null {
  if (pathname === '/v1/models') return { kind: 'models' };
  if (pathname === '/v1/chat/completions') return { kind: 'chat' };
  const m = pathname.match(/^\/v1\/bodies\/([^/]+)\/([^/]+)\/(models|chat\/completions)$/);
  if (!m) return null;
  return {
    kind: m[3] === 'models' ? 'models' : 'chat',
    bodyType: safeDecode(m[1]),
    bodyId: safeDecode(m[2]),
  };
}

function parseModelBodyTag(modelStr?: string): { cleanModel?: string; bodyType?: string; bodyId?: string } {
  const raw = String(modelStr ?? '').trim();
  const slashMatch = raw.match(/^([^@]+)@([^:]+(?::[^:@]+)?)\/(.+)$/);
  if (slashMatch) {
    return { cleanModel: slashMatch[1], bodyType: slashMatch[2], bodyId: slashMatch[3] };
  }
  const colonMatch = raw.match(/^([^@]+)@([^:]+:[^:]+):(.+)$/);
  if (colonMatch) {
    return { cleanModel: colonMatch[1], bodyType: colonMatch[2], bodyId: colonMatch[3] };
  }
  return {};
}

function headerStr(req: IncomingMessage, name: string, fallback = ''): string {
  const val = req.headers[name];
  if (Array.isArray(val)) return String(val[0] ?? fallback).trim();
  return String(val ?? fallback).trim();
}

export async function handleOpenAiProxy(
  ctx: SoulHubContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const route = parseOpenAiProxyRoute(url.pathname);
  if (!route) return false;

  if (req.method === 'GET' && route.kind === 'models') {
    sendJson(res, 200, {
      object: 'list',
      data: [
        {
          id: 'soul-unto-you',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'SoulUntoYou',
        },
      ],
    });
    return true;
  }

  if (req.method === 'POST' && route.kind === 'chat') {
    try {
      const body = await readJsonBody<{
        model?: string;
        stream?: boolean;
        messages?: OpenAiMessage[];
        user?: string;
      }>(req);

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userText = extractLastUserText(messages);
      if (!userText) {
        sendJson(res, 400, { error: { message: 'messages 中缺少 user 内容' } });
        return true;
      }

      const modelTag = parseModelBodyTag(body.model);
      const bodyId = headerStr(req, 'x-body-id') || route.bodyId || modelTag.bodyId || 'openai-proxy-client';
      const bodyType = (headerStr(req, 'x-body-type') || route.bodyType || modelTag.bodyType || 'api') as BodyType;
      const speaker = headerStr(req, 'x-speaker', body.user || '');
      const externalSystemContext = extractSystemContext(messages);

      const result = await processPercept(ctx, {
        bodyId,
        bodyType,
        speaker,
        text: userText,
        externalSystemContext: externalSystemContext || undefined,
      });

      if (!result.ok) {
        const errMsg = 'error' in result && result.error ? String(result.error) : '请求未完成';
        sendJson(res, 'stale' in result && result.stale ? 409 : 502, { error: { message: errMsg } });
        return true;
      }

      const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
      const created = Math.floor(Date.now() / 1000);
      const model = modelTag.cleanModel || body.model || result.model || 'soul-unto-you';

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const chunk1 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: result.reply }, finish_reason: null }],
        };
        const chunk2 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return true;
      }

      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.reply },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        soul_presence: result.presence,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, msg.startsWith('LLM 调用失败') ? 502 : 400, { error: { message: msg } });
      return true;
    }
  }

  return false;
}
