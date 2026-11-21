import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_WS_BUFFER_BYTES = 2 * 1024 * 1024;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 75_000;

export interface WsClient {
  id: string;
  socket: Duplex;
  buffer: Buffer;
  bodyId?: string;
  lastPongAt: number;
}

export type WsMessageHandler = (client: WsClient, text: string) => void | Promise<void>;

export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code: number, reason = ''): Buffer {
  const rBuf = reason ? Buffer.from(reason, 'utf8') : Buffer.alloc(0);
  const payload = Buffer.alloc(2 + rBuf.length);
  payload.writeUInt16BE(code, 0);
  if (rBuf.length) rBuf.copy(payload, 2);
  return encodeWsFrame(0x8, payload);
}

function decodeFrames(buf: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer; errorCode?: number } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if (!fin || opcode === 0x0) {
      return { frames, rest: Buffer.alloc(0), errorCode: 1002 };
    }
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buf.length) break;
      payloadLen = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buf.length) break;
      const bigLen = buf.readBigUInt64BE(cursor);
      if (bigLen > BigInt(MAX_WS_PAYLOAD_BYTES)) {
        return { frames, rest: Buffer.alloc(0), errorCode: 1009 };
      }
      payloadLen = Number(bigLen);
      cursor += 8;
    }
    if (payloadLen > MAX_WS_PAYLOAD_BYTES) {
      return { frames, rest: Buffer.alloc(0), errorCode: 1009 };
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buf.length) break;

    const maskKey = masked ? buf.subarray(cursor, cursor + 4) : null;
    cursor += maskLen;
    const rawPayload = Buffer.from(buf.subarray(cursor, cursor + payloadLen));
    if (maskKey) {
      for (let i = 0; i < rawPayload.length; i += 1) {
        rawPayload[i] ^= maskKey[i % 4];
      }
    }
    frames.push({ opcode, payload: rawPayload });
    offset = cursor + payloadLen;
  }

  return { frames, rest: buf.subarray(offset) };
}

export class SimpleWsServer {
  private readonly clients: Set<WsClient>;
  private readonly onMessage: WsMessageHandler;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(onMessage: WsMessageHandler) {
    this.clients = new Set<WsClient>();
    this.onMessage = onMessage;
    this.pingTimer = setInterval(() => this.sweepAndPing(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private sweepAndPing(): void {
    const now = Date.now();
    for (const client of this.clients) {
      if (client.socket.destroyed || now - client.lastPongAt > PONG_TIMEOUT_MS) {
        try { client.socket.destroy(); } catch {}
        this.clients.delete(client);
        continue;
      }
      try {
        client.socket.write(encodeWsFrame(0x9, Buffer.alloc(0)));
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private closeClient(client: WsClient, code: number): void {
    try {
      if (!client.socket.destroyed) client.socket.write(encodeCloseFrame(code));
      client.socket.destroy();
    } catch {}
    this.clients.delete(client);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    const keyHeader = req.headers['sec-websocket-key'];
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (!key) {
      socket.destroy();
      return false;
    }
    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    const client: WsClient = {
      id: crypto.randomUUID().slice(0, 8),
      socket,
      buffer: Buffer.alloc(0),
      lastPongAt: Date.now(),
    };
    this.clients.add(client);

    socket.on('data', (chunk: Buffer) => {
      if (client.buffer.length + chunk.length > MAX_WS_BUFFER_BYTES) {
        this.closeClient(client, 1009);
        return;
      }
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const { frames, rest, errorCode } = decodeFrames(client.buffer);
      client.buffer = rest;
      for (const frame of frames) {
        client.lastPongAt = Date.now();
        if (frame.opcode === 0x8) {
          this.closeClient(client, 1000);
          return;
        }
        if (frame.opcode === 0x9) {
          try { socket.write(encodeWsFrame(0xA, frame.payload)); } catch {}
          continue;
        }
        if (frame.opcode === 0xA) continue;
        if (frame.opcode === 0x1) {
          void Promise.resolve(this.onMessage(client, frame.payload.toString('utf8'))).catch(() => {});
        }
      }
      if (errorCode) {
        this.closeClient(client, errorCode);
      }
    });

    const cleanup = () => {
      this.clients.delete(client);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    return true;
  }

  getOnlineBodyIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.clients) {
      const id = String(c.bodyId || '').trim();
      if (id && !c.socket.destroyed) ids.add(id);
    }
    return ids;
  }

  sendJson(client: WsClient, data: unknown): void {
    if (client.socket.destroyed) return;
    try {
      const payload = Buffer.from(JSON.stringify(data), 'utf8');
      client.socket.write(encodeWsFrame(0x1, payload));
    } catch {}
  }

  broadcastJson(data: unknown): void {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    const frame = encodeWsFrame(0x1, payload);
    for (const client of this.clients) {
      if (!client.socket.destroyed) {
        try {
          client.socket.write(frame);
        } catch {}
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    clearInterval(this.pingTimer);
    for (const client of this.clients) {
      try {
        client.socket.write(encodeCloseFrame(1000));
        client.socket.destroy();
      } catch {}
    }
    this.clients.clear();
  }
}
