import { AUTOHINT_REFERENCE_CHARS } from './autohintReferenceChars';
import { unicodeScriptsOf } from './otScriptTags';

// The bytes of `tag`'s table in a single-font sfnt, or undefined when the
// table is absent or empty.
function sfntTable(sfnt: Uint8Array, tag: string): Uint8Array | undefined {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + 16 * i;
    const recordTag = String.fromCharCode(...sfnt.subarray(record, record + 4));
    if (recordTag !== tag) continue;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    return length ? sfnt.subarray(offset, offset + length) : undefined;
  }
  return undefined;
}

// Whether Chrome autohints this sfnt. Skrifa's Engine::AutoFallback uses the
// autohinter only for TrueType outlines without a hinting program: no fpgm or
// prep, and zero maxp.maxSizeOfInstructions (skrifa/src/outline/glyf/mod.rs).
// CFF outlines use the PostScript hinter.
export function isAutohinted(sfnt: Uint8Array): boolean {
  if (!sfntTable(sfnt, 'glyf')) return false;
  if (sfntTable(sfnt, 'fpgm') || sfntTable(sfnt, 'prep')) return false;
  const maxp = sfntTable(sfnt, 'maxp');
  if (!maxp || maxp.length < 28) return true;
  return new DataView(maxp.buffer, maxp.byteOffset).getUint16(26) === 0;
}

// `text` plus the characters the autohinter measures stem widths and
// alignment zones on, for each script in `text`. It measures them in the font
// it is given, so a subset missing "H" or "o" snaps its glyphs to different
// zones than the full font. The subsetter ignores characters the font lacks.
export function withAutohintReferenceChars(text: string): string {
  let reference = '';
  for (const script of unicodeScriptsOf(text)) {
    reference += AUTOHINT_REFERENCE_CHARS[script] ?? '';
  }
  return text + reference;
}
