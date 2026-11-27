import { afterEach, expect, test, vi } from 'vitest';
import { NativeClient } from '../adapters/native';

type Request = { requestId: string; type: string };

function nativeTransport() {
  const ports: ReturnType<typeof makePort>[] = [];

  function makePort() {
    const messages: ((value: unknown) => void)[] = [];
    const disconnects: (() => void)[] = [];
    const requests: Request[] = [];
    return {
      requests,
      onMessage: { addListener: (listener: (value: unknown) => void) => messages.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
      postMessage: (request: Request) => requests.push(request),
      reply(request: Request, payload: unknown, protocolVersion = 1) {
        for (const listener of messages) {
          listener({ type: 'RESPONSE', protocolVersion, requestId: request.requestId, ok: true, payload });
        }
      },
      disconnect() {
        for (const listener of disconnects) listener();
      },
    };
  }

  vi.stubGlobal('chrome', {
    runtime: {
      connectNative: () => {
        const port = makePort();
        ports.push(port);
        return port;
      },
    },
  });
  return ports;
}

const hello = { version: '0.1.0', maxFrameBytes: 524288, languages: ['rust'] };
afterEach(() => vi.unstubAllGlobals());

test('one handshake serves concurrent callers and replies are matched by request ID', async () => {
  const ports = nativeTransport();
  const native = new NativeClient();
  const ping = native.request('PING', {});
  const tools = native.request('GET_TOOLCHAINS', {});
  await vi.waitFor(() => expect(ports).toHaveLength(1));
  expect(ports[0].requests.map((request) => request.type)).toEqual(['HELLO']);

  ports[0].reply(ports[0].requests[0], hello);
  await vi.waitFor(() => expect(ports[0].requests).toHaveLength(3));
  ports[0].reply(ports[0].requests[2], { toolchains: [] });
  ports[0].reply(ports[0].requests[1], { status: 'PONG' });

  await expect(tools).resolves.toEqual({ toolchains: [] });
  await expect(ping).resolves.toEqual({ status: 'PONG' });
});

test('disconnect rejects pending requests and the next user request reconnects after backoff', async () => {
  const ports = nativeTransport();
  const native = new NativeClient();
  const old = native.request('PING', {});
  await vi.waitFor(() => expect(ports).toHaveLength(1));
  ports[0].reply(ports[0].requests[0], hello);
  await vi.waitFor(() => expect(ports[0].requests).toHaveLength(2));

  const rejected = expect(old).rejects.toThrow('NATIVE_HOST_DISCONNECTED');
  ports[0].disconnect();
  await rejected;
  const next = native.request('PING', {});
  await Promise.resolve();
  expect(ports).toHaveLength(1);
  await vi.waitFor(() => expect(ports).toHaveLength(2));
  ports[1].reply(ports[1].requests[0], hello);
  await vi.waitFor(() => expect(ports[1].requests).toHaveLength(2));
  ports[1].reply(ports[1].requests[1], { status: 'PONG' });
  await expect(next).resolves.toEqual({ status: 'PONG' });
});

test('a reply with another protocol version fails the handshake explicitly', async () => {
  const ports = nativeTransport();
  const native = new NativeClient();
  const pending = native.request('PING', {});
  const rejected = expect(pending).rejects.toThrow('PROTOCOL_VERSION_MISMATCH');
  await vi.waitFor(() => expect(ports).toHaveLength(1));
  ports[0].reply(ports[0].requests[0], hello, 2);
  await rejected;
});
