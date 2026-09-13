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
 *
 * `reportedRole` appends the optional `role` parameter, and is a raw string
 * rather than a PeerRole on purpose: the point of the parameter is that a
 * client can send anything at all, so a test must be able to send a value the
 * enum does not contain. Omitting it dials exactly the URL every client that
 * predates the parameter dials.
 */
export async function connectTestClient(
  relayUrl: string,
  slotId: string,
  reportedRole?: string,
): Promise<TestClient> {
  const roleParameter = reportedRole === undefined ? '' : `&role=${encodeURIComponent(reportedRole)}`;
  const socket = new NodeWebSocket(`${relayUrl}?slot=${encodeURIComponent(slotId)}${roleParameter}`);

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
