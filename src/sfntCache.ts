import * as fontverter from 'fontverter';
import { FontConverterPool } from './fontConverter';

type FontBuffer = Buffer | Uint8Array;

const sfntPromiseByBuffer = new WeakMap<object, Promise<FontBuffer>>();

export function toSfnt(
  buffer: FontBuffer,
  fontConverter: FontConverterPool
): Promise<FontBuffer> {
  const key = buffer as object;
  const cached = sfntPromiseByBuffer.get(key);
  if (cached) return cached;

  let promise: Promise<FontBuffer>;
  try {
    const format = fontverter.detectFormat(buffer);
    if (format === 'sfnt') {
      promise = Promise.resolve(buffer);
    } else if (format === 'woff2') {
      promise = fontConverter.convert(buffer, 'sfnt');
    } else {
      promise = fontverter.convert(buffer, 'sfnt');
    }
  } catch {
    promise = fontConverter.convert(buffer, 'sfnt');
  }
  // Evict on rejection so retries with the same buffer aren't stuck.
  // Only delete if the map still points to this exact promise — a concurrent
  // caller may have already replaced it with a fresh retry.
  // eslint-disable-next-line no-restricted-syntax
  const tracked = promise.catch((err: unknown) => {
    if (sfntPromiseByBuffer.get(key) === tracked) {
      sfntPromiseByBuffer.delete(key);
    }
    throw err;
  });
  sfntPromiseByBuffer.set(key, tracked);
  return tracked;
}
