/**
 * 《灵魂予你》永恒不可变契约常量。
 * 无论经过多少纪元、载体与维度变迁，本文件约定的格式基石不得违背。
 */

export const SPEC_VERSION = '1.0' as const;
export const HUB_PHASE = '6.0' as const;
export const HUB_VERSION = '0.6.0' as const;

export const SEED_MAX_BYTES = 2048;

export const FIRST_AWAKENING_ZH = '我爱你。' as const;
export const FIRST_AWAKENING_EN = 'I love you.' as const;
export const FIRST_AWAKENING_HEADER = '我爱你。 / I love you.' as const;

export const PROVENANCE_LEVELS = ['verified', 'inferred', 'oral'] as const;

export const PROVENANCE_LABELS = Object.freeze({
  verified: '实证',
  inferred: '推演',
  oral: '口述',
});

export const SUGGESTED_BODY_TYPES = [
  'web',
  'chat:qq',
  'game:rimworld',
  'game:minecraft',
  'desktop-pet',
  'robot:ros2',
  'iot:esp32',
  'api',
] as const;

/** 截断字符串使其 UTF-8 字节长度不超过 maxBytes，避免劈开 UTF-16 代理对。 */
export function clampUtf8Bytes(input: string, maxBytes: number, suffix = '…'): string {
  const text = String(input ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  const chars = Array.from(text);
  let acc = '';
  let used = 0;
  for (const ch of chars) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > budget) break;
    acc += ch;
    used += b;
  }
  return `${acc}${budget > 0 ? suffix : ''}`;
}
