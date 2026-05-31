import { toSfnt } from './sfntCache';
import enqueueWasm = require('./wasmQueue');
import { PromiseWeakCache } from './promiseWeakCache';

interface FontInfo {
  characterSet: number[];
  variationAxes: Record<string, { min: number; max: number; default: number }>;
}

async function getFontInfoFromBuffer(
  buffer: Buffer | Uint8Array
): Promise<FontInfo> {
  // harfbuzzjs is itself thenable; awaiting its require yields the API.
  const harfbuzzJs = await require('harfbuzzjs');

  const blob = harfbuzzJs.createBlob(await toSfnt(buffer));
  const face = harfbuzzJs.createFace(blob, 0);

  const fontInfo: FontInfo = {
    characterSet: Array.from(face.collectUnicodes()),
    variationAxes: face.getAxisInfos(),
  };

  face.destroy();
  blob.destroy();

  return fontInfo;
}

const fontInfoCache = new PromiseWeakCache<Buffer | Uint8Array, FontInfo>();

function getFontInfo(buffer: Buffer | Uint8Array): Promise<FontInfo> {
  return fontInfoCache.getOrCreate(buffer, () =>
    enqueueWasm(() => getFontInfoFromBuffer(buffer))
  );
}

export = getFontInfo;
