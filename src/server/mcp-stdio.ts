import readline from 'node:readline';
import { LlmRouter } from '../llm/router.ts';
import { resolveConfiguredRetriever } from '../memory/search.ts';
import { PresenceManager } from '../presence/manager.ts';
import { VoiceClient } from '../voice/client.ts';
import { defaultConfigPath, loadHubConfig } from './config.ts';
import type { SoulHubContext } from './body-api.ts';
import { SoulEventBus } from './events.ts';
import { handleMcpRpc, type McpRequest } from './mcp.ts';
import { ensureArchiveReady } from './main.ts';

async function runStdio(): Promise<void> {
  const configPath = defaultConfigPath();
  const config = loadHubConfig(configPath);
  ensureArchiveReady(config.archiveDir);

  const ctx: SoulHubContext = {
    config,
    configPath,
    apiToken: '',
    presence: new PresenceManager(config.archiveDir),
    llm: new LlmRouter(config.llm),
    voice: new VoiceClient(config.voice),
    retriever: resolveConfiguredRetriever(config.retriever),
    events: new SoulEventBus(),
    ws: null,
    switchArchive: (nextDir: string) => {
      ensureArchiveReady(nextDir);
      ctx.config.archiveDir = nextDir;
      ctx.presence.switchArchiveDir(nextDir);
    },
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rpc = JSON.parse(trimmed) as McpRequest;
      const out = await handleMcpRpc(ctx, rpc);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: msg } })}\n`,
      );
    }
  }
}

runStdio().catch((err) => {
  console.error('MCP stdio 启动失败:', err);
  process.exitCode = 1;
});
