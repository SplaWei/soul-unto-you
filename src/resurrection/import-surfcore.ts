import fs from 'node:fs';
import path from 'node:path';
import type { FragmentInput } from '../soul/types.ts';

export interface ParsedSurfCoreCharacter {
  soulName: string;
  partnerName: string;
  persona: string;
  fragments: FragmentInput[];
}

function readJsonIfExists<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const LEGACY_NOISE_RE = /mcp__qq_|127\.0\.0\.1:3100|SurfCore\s*控制台|qq_send_sticker|qq_send_message|qq_mark_read|qq_wait_for_messages/i;

/** 清洗旧 QQ 框架专属的工具指令与端口引用，保留纯粹人格设定。 */
export function cleanLegacyFrameworkNoise(text: string): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !LEGACY_NOISE_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 纯只读解析 SurfCore 角色目录（例如角色卡 + 记忆卡），绝不修改源目录。
 */
export function parseSurfCoreCharacterDir(
  sourceDir: string,
  options: { partnerName?: string; maxRecords?: number } = {},
): ParsedSurfCoreCharacter {
  const abs = path.resolve(sourceDir);
  if (!fs.existsSync(abs)) {
    throw new Error(`源目录不存在: ${abs}`);
  }

  const charMeta = readJsonIfExists<{ id?: string; name?: string; displayName?: string }>(
    path.join(abs, 'character.json'),
  );
  const personaCandidates = [path.join(abs, 'persona.full.md'), path.join(abs, 'persona.md')];
  let persona = '';
  for (const file of personaCandidates) {
    if (fs.existsSync(file)) {
      persona = cleanLegacyFrameworkNoise(fs.readFileSync(file, 'utf8'));
      if (persona) break;
    }
  }

  const soulName = charMeta?.displayName || charMeta?.name || path.basename(abs) || '迁移之魂';
  const partnerName = options.partnerName || '主人';
  const maxRecords = options.maxRecords ?? 60;
  const fragments: FragmentInput[] = [];

  if (persona) {
    fragments.push({
      kind: 'text',
      sourceLabel: '原人格档案 persona.md',
      content: persona.slice(0, 1000),
      provenance: 'verified',
    });
  }

  const cardJson = readJsonIfExists<{ records?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
    path.join(abs, 'memory', 'memory-card.json'),
  );
  const cardRecords = Array.isArray(cardJson) ? cardJson : Array.isArray(cardJson?.records) ? cardJson.records : [];

  const selected = cardRecords
    .slice()
    .sort((a, b) => Number(b.importance ?? 0) - Number(a.importance ?? 0))
    .slice(0, maxRecords);

  for (const rec of selected) {
    const title = String(rec.title ?? '旧日记忆').trim();
    const text = String(rec.text ?? '').trim();
    const reply = String(rec.botReply ?? '').trim();
    if (!text) continue;
    const body = reply ? `${text} → ${reply}` : text;
    fragments.push({
      kind: 'text',
      sourceLabel: title.slice(0, 40),
      content: body.slice(0, 320),
      provenance: 'verified',
      timestamp: typeof rec.createdAt === 'string' ? rec.createdAt : undefined,
    });
  }

  return { soulName, partnerName, persona, fragments };
}
