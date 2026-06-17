import * as fontverter from 'fontverter';
import { convert } from './fontConverter';
import { PromiseWeakCache } from './promiseWeakCache';

type FontBuffer = Buffer | Uint8Array;

const sfntCache = new PromiseWeakCache<FontBuffer, FontBuffer>();

export function toSfnt(buffer: FontBuffer): Promise<FontBuffer> {
  return sfntCache.getOrCreate(buffer, () => {
    try {
      const format = fontverter.detectFormat(buffer);
      if (format === 'sfnt') {
        return Promise.resolve(buffer);
      } else if (format === 'woff2') {
        return convert(buffer, 'sfnt');
      } else {
        return fontverter.convert(buffer, 'sfnt');
      }
    } catch {
      // detectFormat throws on corrupt/unrecognized buffers — fall back to
      // the worker pool which has its own format detection.
      return convert(buffer, 'sfnt');
    }
  });
}
