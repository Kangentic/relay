import type { RawData } from 'ws';

/**
 * Preallocated send-option objects for the forwarding hot path, so relaying
 * a frame never allocates a fresh options literal per message.
 */
export const BINARY_SEND_OPTIONS = Object.freeze({ binary: true });
export const TEXT_SEND_OPTIONS = Object.freeze({ binary: false });

/** Computes the byte length of a raw WebSocket message without copying it. */
export function byteLengthOfRawData(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
