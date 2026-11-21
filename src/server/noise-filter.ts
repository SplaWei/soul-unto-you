const DEFAULT_SYSTEM_NOISE_PATTERNS: RegExp[] = [
  /^(?:Set\s+.*game mode|Set own game mode|Summoned new|Gave \d+|Teleported|Killed|Time set|Weather set|Changed game rule|Saved the game|Saving\.\.\.|Applied effect|Cleared the inventory|Experience set|Difficulty set)/i,
  /^(?:已将.*游戏模式|已召唤|给予了?\s*\d+|已传送|已将时间设为|已将天气设为|已保存游戏|正在保存|已更改游戏规则|已清除.*物品栏)/,
  /^(?:\[Server\]|\[System\]|\[RCON\]|\[Console\]|Server thread\/(?:INFO|WARN))/i,
];

export function stripFormattingNoise(text: string): string {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectSystemNoise(
  rawText: string,
  opts?: {
    bodyType?: string;
    noisePatterns?: string[];
    metadata?: Record<string, unknown>;
  },
): { isNoise: boolean; cleanedText: string; reason?: string } {
  const cleanedText = stripFormattingNoise(rawText);
  if (opts?.metadata?.realityFeedback || opts?.metadata?.forceKeep === true) {
    return { isNoise: false, cleanedText };
  }
  if (!cleanedText) {
    return { isNoise: true, cleanedText: '', reason: 'empty-after-strip' };
  }

  for (const rawPat of opts?.noisePatterns ?? []) {
    const pat = String(rawPat ?? '').trim();
    if (!pat || pat.length > 200) continue;
    try {
      if (new RegExp(pat, 'i').test(cleanedText)) {
        return { isNoise: true, cleanedText, reason: 'body-noise-pattern' };
      }
    } catch {}
  }

  const bodyType = String(opts?.bodyType || '').trim();
  const isSystemContext =
    bodyType.startsWith('game:') ||
    opts?.metadata?.source === 'system' ||
    opts?.metadata?.isSystemNotice === true;

  if (isSystemContext) {
    for (const re of DEFAULT_SYSTEM_NOISE_PATTERNS) {
      if (re.test(cleanedText)) {
        return { isNoise: true, cleanedText, reason: 'system-echo-noise' };
      }
    }
  }

  return { isNoise: false, cleanedText };
}
