import type { RawData } from 'ws';

/** Computes the byte length of a raw WebSocket message without copying it. */
export function byteLengthOfRawData(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
