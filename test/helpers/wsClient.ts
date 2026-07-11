import { WebSocket as NodeWebSocket, type RawData } from 'ws';

export interface TestClient {
  readonly socket: NodeWebSocket;
  send(data: RawData): void;
  nextMessage(): Promise<{ data: RawData; isBinary: boolean }>;
  nextClose(): Promise<{ code: number; reason: string }>;
  close(): void;
}

/**
 * Opens a `ws` client against `relayUrl?slot=<slotId>` and resolves once the
 * connection is open. Queues every 'message' from the moment the socket is
 * created (before the 'open' handshake even completes), not just once
 * nextMessage() is called: the relay can flush a buffered frame to this
 * client synchronously as part of pairing, which can beat a lazily
 * attached 'once' listener, and a JS EventEmitter never redelivers an
 * event to a listener registered after it fired.
 */
export async function connectTestClient(relayUrl: string, slotId: string): Promise<TestClient> {
  const socket = new NodeWebSocket(`${relayUrl}?slot=${encodeURIComponent(slotId)}`);

  const messageQueue: Array<{ data: RawData; isBinary: boolean }> = [];
  const pendingWaiters: Array<(message: { data: RawData; isBinary: boolean }) => void> = [];

  socket.on('message', (data: RawData, isBinary: boolean) => {
    const waiter = pendingWaiters.shift();
    if (waiter) waiter({ data, isBinary });
    else messageQueue.push({ data, isBinary });
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return {
    socket,
    send: (data) => socket.send(data as never),
    nextMessage: () =>
      new Promise((resolve) => {
        const queued = messageQueue.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        pendingWaiters.push(resolve);
      }),
    nextClose: () =>
      new Promise((resolve) => {
        socket.once('close', (code: number, reasonBuffer: Buffer) => resolve({ code, reason: reasonBuffer.toString() }));
      }),
    close: () => socket.close(),
  };
}
