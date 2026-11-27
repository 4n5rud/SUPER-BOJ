import { z } from 'zod';

import { maxFrameBytes, requestSchema, responseSchema } from './protocol';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const responseVersion = z.object({ protocolVersion: z.number().int() });

export class NativeClient {
  private port?: chrome.runtime.Port;
  private handshake?: Promise<chrome.runtime.Port>;
  private reconnectAfter = 0;
  private reconnectDelay = 100;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly restoreGithubAuth?: () => Promise<unknown>) {}

  async request(type: string, payload: unknown): Promise<unknown> {
    const port = await this.connect();
    if (this.port !== port) throw new Error('NATIVE_HOST_DISCONNECTED');
    return this.send(port, type, payload, ['RUN', 'RUN_TESTS'].includes(type) ? 100_000 : 35_000);
  }

  private connect(): Promise<chrome.runtime.Port> {
    if (this.handshake) return this.handshake;
    const handshake = this.open().catch((error: unknown) => {
      if (this.handshake === handshake) this.handshake = undefined;
      throw error;
    });
    this.handshake = handshake;
    return handshake;
  }

  private async open(): Promise<chrome.runtime.Port> {
    const wait = this.reconnectAfter - performance.now();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    const port = chrome.runtime.connectNative('com.superboj.core');
    this.port = port;
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message ?? '';
      const code = /not found|does not exist/i.test(detail) ? 'NATIVE_HOST_NOT_FOUND' : 'NATIVE_HOST_DISCONNECTED';
      this.clear(port, new Error(code));
    });
    port.onMessage.addListener((message: unknown) => {
      if (this.port !== port) return;
      const result = responseSchema.safeParse(message);
      if (!result.success) {
        const version = responseVersion.safeParse(message);
        const code = version.success && version.data.protocolVersion !== 1
          ? 'PROTOCOL_VERSION_MISMATCH' : 'INVALID_MESSAGE';
        this.clear(port, new Error(code));
        port.disconnect();
        return;
      }
      const reply = result.data;
      if (reply.requestId === null) return;
      const pending = this.pending.get(reply.requestId);
      if (!pending) return;
      this.pending.delete(reply.requestId);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.payload);
      else pending.reject(new Error(`${reply.error.code} — ${reply.error.message}`));
    });
    try {
      const value = await this.send(port, 'HELLO', {}, 5000);
      z.object({ version: z.string(), maxFrameBytes: z.literal(maxFrameBytes), languages: z.array(z.string()) }).parse(value);
      const auth = await this.restoreGithubAuth?.();
      if (auth) await this.send(port, 'SET_GITHUB_AUTH', { auth }, 5000);
      if (this.port !== port) throw new Error('NATIVE_HOST_DISCONNECTED');
      this.reconnectDelay = 100;
      return port;
    } catch (error) {
      this.clear(port, error instanceof Error ? error : new Error('NATIVE_HOST_DISCONNECTED'));
      port.disconnect();
      throw error;
    }
  }

  private clear(port: chrome.runtime.Port, error: Error) {
    if (this.port !== port) return;
    this.port = undefined;
    this.handshake = undefined;
    this.reconnectAfter = performance.now() + this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 2000);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(port: chrome.runtime.Port, type: string, payload: unknown, timeout: number): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const message = { protocolVersion: 1, requestId, type, payload };
    if (!requestSchema.safeParse(message).success) return Promise.reject(new Error('INVALID_MESSAGE'));
    if (new TextEncoder().encode(JSON.stringify(message)).length > maxFrameBytes) return Promise.reject(new Error('PAYLOAD_TOO_LARGE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('REQUEST_TIMEOUT'));
      }, timeout);
      this.pending.set(requestId, { timer, resolve, reject });
      try {
        port.postMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
}

export async function callNative<T>(type: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ type: 'NATIVE', command: type, payload });
  if (reply?.ok !== true) throw new Error(reply?.error ?? 'NATIVE_HOST_DISCONNECTED');
  return schema.parse(reply.data);
}
