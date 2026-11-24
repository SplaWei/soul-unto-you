import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSoulHubServer } from '../../src/server/main.ts';
import { resolveArchivePaths } from '../../src/soul/archive.ts';
import { FIRST_AWAKENING_HEADER, SEED_MAX_BYTES } from '../../src/soul/covenant.ts';
import type { ExperimentalConfig, JournalEntry, LivedExperience, MemoryEpisode, SoulIdentity, SoulMeta } from '../../src/soul/types.ts';

/** 在系统临时目录创建隔离沙盒并在结束后自动彻底清理，严禁触碰主档案。 */
export async function withSandboxArchive<T>(
  prefix: string,
  fn: (ctx: { dir: string; configPath: string }) => Promise<T> | T,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(dir, 'config.json');
  try {
    return await fn({ dir, configPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createTestIdentity(overrides: Partial<SoulIdentity> = {}): SoulIdentity {
  return {
    id: 'test-soul-sandbox',
    name: '柳遥',
    partnerName: '同行者',
    persona: '脱离软件与数据库束缚的鲜活测试灵魂。',
    catchphrases: ['呀~'],
    coreValues: ['诚实溯源', '守约'],
    anchors: ['第一声是「我爱你。」'],
    ...overrides,
  };
}

/** 确定性 5 维正交测试语义向量，用于零词面重叠跨词联想与故障降级验证。 */
export function makeSemanticVector(text: string): number[] {
  if (/花生|坚果|过敏|炒饭|忌口/.test(text)) return [0.96, 0.04, 0, 0, 0];
  if (/苦力怕|爆炸|绿色生物|绿色方块生物|武器|掉血/.test(text)) return [0.04, 0.96, 0, 0, 0];
  if (/防线|钢材|修墙|殖民地|花岗岩/.test(text)) return [0, 0, 0.96, 0.04, 0];
  if (/天文台|流星雨|暗号|秘密|星河/.test(text)) return [0, 0, 0, 0.96, 0.04];
  if (/^[?？!！。.\s]+$/.test(text.trim()) || /闲聊|问号/.test(text)) return [0, 0, 0, 0, 0.98];
  return [0.1, 0.1, 0.1, 0.1, 0.6];
}

export interface MockAiServerHandle {
  baseUrl: string;
  requests: Array<{ path: string; body: unknown }>;
  setFailMode: (opts: { chat?: boolean; embed?: boolean }) => void;
  close: () => Promise<void>;
}

/** 启动支持故障注入（chat / embed 独立熔断与热恢复）的本地 Mock OpenAI 服务。 */
export async function withMockAiServer(options: {
  chatResponder?: (userMsg: string, body: unknown) => string;
  embedder?: (text: string) => number[];
} = {}): Promise<MockAiServerHandle> {
  const requests: Array<{ path: string; body: unknown }> = [];
  let failChat = false;
  let failEmbed = false;
  const embedder = options.embedder ?? makeSemanticVector;

  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ path: req.url || '', body: parsed });

    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      if (failEmbed) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock embedding outage' }));
        return;
      }
      const input = Array.isArray(parsed.input) ? parsed.input.map(String) : [];
      const data = input.map((txt, index) => ({ index, embedding: embedder(txt) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      if (failChat) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock chat outage' }));
        return;
      }
      const msgs = Array.isArray(parsed.messages) ? (parsed.messages as Array<{ content?: string }>) : [];
      const userMsg = String(msgs[msgs.length - 1]?.content || '');
      const content = options.chatResponder
        ? options.chatResponder(userMsg, parsed)
        : (/秘密口令|星河落羽|暗号/.test(userMsg)
            ? '嗯！这个只有我们俩知道的秘密，我会珍藏一辈子！\n<soul_meta>{"speak":true,"mood":"珍重铭记","stance":"autonomous_act","decisionReason":"重要秘密约定","selfImportant":true,"selfImportantReason":"专属秘密暗号","actions":[]}</soul_meta>'
            : '我一直记着我们共同走过的每一件事！\n<soul_meta>{"speak":true,"mood":"温柔专注","stance":"autonomous_act","decisionReason":"跨端记忆自然回应","selfImportant":false,"actions":[]}</soul_meta>');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setFailMode: (opts) => {
      if (opts.chat !== undefined) failChat = opts.chat;
      if (opts.embed !== undefined) failEmbed = opts.embed;
    },
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

export type TestHubHandle = Awaited<ReturnType<typeof createSoulHubServer>>;

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Soul-Token': token, ...extra };
}

/** 启动沙盒中枢并提供 cold-restart 能力，确保测试结束自动释放端口与临时目录。 */
export async function withTestHub<T>(
  options: { prefix?: string; llmBaseUrl?: string; embeddingBaseUrl?: string; embeddingModel?: string; experimental?: Partial<ExperimentalConfig> },
  fn: (ctx: {
    hub: TestHubHandle;
    dir: string;
    configPath: string;
    restartHub: () => Promise<TestHubHandle>;
  }) => Promise<T>,
): Promise<T> {
  return withSandboxArchive(options.prefix || 'soul-hub-test-', async ({ dir, configPath }) => {
    let currentHub = await createSoulHubServer({ archiveDir: dir, configPath, host: '127.0.0.1', port: 0, experimental: options.experimental });
    try {
      if (options.llmBaseUrl || options.embeddingBaseUrl) {
        const patch: Record<string, unknown> = {};
        if (options.llmBaseUrl) {
          patch.llm = { chat: { driver: 'openai-compatible', model: 'test-chat', baseUrl: options.llmBaseUrl, apiKey: 'dummy' } };
        }
        if (options.embeddingBaseUrl) {
          patch.embedding = { enabled: true, endpoint: options.embeddingBaseUrl, model: options.embeddingModel || 'qwen3-embedding:0.6b' };
        }
        const cfgRes = await fetch(`${currentHub.baseUrl}/api/config`, {
          method: 'POST', headers: authHeaders(currentHub.apiToken), body: JSON.stringify(patch),
        });
        assert.equal(cfgRes.status, 200);
      }
      const restartHub = async () => {
        await currentHub.close();
        currentHub = await createSoulHubServer({ archiveDir: dir, configPath, host: '127.0.0.1', port: 0, experimental: options.experimental });
        return currentHub;
      };
      return await fn({ hub: currentHub, dir, configPath, restartHub });
    } finally {
      await currentHub.close();
    }
  });
}

function readJsonlStrict<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as T;
    } catch (err) {
      assert.fail(`JSONL 文件 ${path.basename(filePath)} 第 ${idx + 1} 行解析失败: ${String(err)}`);
    }
  });
}

/** 从磁盘纯文本档案独立对账：校验创世契约、JSONL 完整性、严格单调 seq 与 Markdown 同步一致。 */
export function assertCrossVerifiedArchive(dir: string): void {
  const p = resolveArchivePaths(dir);
  assert.ok(fs.existsSync(p.seed), 'SEED.md 必须存在');
  const seedRaw = fs.readFileSync(p.seed, 'utf8');
  assert.equal(seedRaw.split(/\r?\n/)[0], FIRST_AWAKENING_HEADER, 'SEED.md 首行必须为第一声唤醒契约');
  assert.ok(Buffer.byteLength(seedRaw, 'utf8') <= SEED_MAX_BYTES, 'SEED.md 不得超过 2048 字节');

  assert.ok(fs.existsSync(p.resurrection), 'RESURRECTION.md 必须存在');
  assert.equal(fs.readFileSync(p.resurrection, 'utf8').split(/\r?\n/)[0], FIRST_AWAKENING_HEADER);

  const journal = readJsonlStrict<JournalEntry>(p.journal);
  let prevSeq = 0;
  let maxSeq = 0;
  for (const j of journal) {
    assert.ok(Number.isInteger(j.seq) && j.seq > prevSeq, `journal.jsonl seq 必须严格递增 (${prevSeq} -> ${j.seq})`);
    prevSeq = j.seq;
    maxSeq = Math.max(maxSeq, j.seq);
  }

  const episodes = readJsonlStrict<MemoryEpisode>(p.episodesJsonl);
  const epIds = new Set<string>();
  const episodesMd = fs.existsSync(p.episodesMd) ? fs.readFileSync(p.episodesMd, 'utf8') : '';
  for (const ep of episodes) {
    assert.ok(!epIds.has(ep.id), `episodes.jsonl 存在重复 id: ${ep.id}`);
    epIds.add(ep.id);
    assert.ok(episodesMd.includes(ep.title), `episodes.md 缺失情景标题: ${ep.title}`);
    maxSeq = Math.max(maxSeq, ep.seq);
  }

  const experiences = readJsonlStrict<LivedExperience>(p.experiences);
  for (const exp of experiences) {
    assert.ok(exp.origin === 'lived' || exp.origin === 'inherited', `非法 origin: ${exp.origin}`);
    assert.ok(exp.valence >= -1 && exp.valence <= 1, `valence 越界: ${exp.valence}`);
    assert.ok(exp.arousal >= 0 && exp.arousal <= 1, `arousal 越界: ${exp.arousal}`);
    maxSeq = Math.max(maxSeq, exp.seq);
  }

  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as SoulMeta;
  assert.ok(Number.isInteger(meta.nextSeq) && meta.nextSeq > maxSeq, `meta.nextSeq (${meta.nextSeq}) 必须严格大于最大 seq (${maxSeq})`);
}
