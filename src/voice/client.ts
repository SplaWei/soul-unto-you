export interface VoiceConfig {
  enabled: boolean;
  driver: 'gsv' | 'openai';
  baseUrl: string;
  character?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface VoiceHealthResult {
  ok: boolean;
  enabled: boolean;
  driver: string;
  detail: string;
}

export class VoiceClient {
  private config: VoiceConfig;

  constructor(config: VoiceConfig) {
    this.config = config;
  }

  updateConfig(next: VoiceConfig): void {
    this.config = next;
  }

  async health(): Promise<VoiceHealthResult> {
    if (!this.config.enabled) {
      return { ok: false, enabled: false, driver: this.config.driver, detail: '声带接口未启用（可随时在设置中打开）' };
    }
    const base = this.config.baseUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 2500),
      });
      return {
        ok: res.ok,
        enabled: true,
        driver: this.config.driver,
        detail: res.ok ? `声带服务在线 (${base})` : `声带响应 HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        enabled: true,
        driver: this.config.driver,
        detail: `声带暂未连接 (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  async speakToBase64(text: string): Promise<{ ok: boolean; mimeType?: string; base64?: string; reason?: string }> {
    if (!this.config.enabled) return { ok: false, reason: 'voice-disabled' };
    const clean = String(text ?? '').trim();
    if (!clean) return { ok: false, reason: 'empty-text' };
    const base = this.config.baseUrl.replace(/\/+$/, '');
    try {
      if (this.config.driver === 'gsv') {
        const res = await fetch(`${base}/v1/speak/file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, character: this.config.character || 'default' }),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 25000),
        });
        if (!res.ok) return { ok: false, reason: `gsv-http-${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, mimeType: 'audio/wav', base64: buf.toString('base64') };
      }
      const res = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: 'tts-1', input: clean, voice: this.config.character || 'alloy' }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 25000),
      });
      if (!res.ok) return { ok: false, reason: `tts-http-${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, mimeType: 'audio/mpeg', base64: buf.toString('base64') };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
