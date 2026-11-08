import {
  AUTOHINT_REFERENCE_CHARS,
  AUTOHINT_SCRIPT_RANGES,
} from './autohintReferenceChars';

// The bytes of `tag`'s table in a single-font sfnt, or undefined when the
// table is absent or empty.
function sfntTable(sfnt: Uint8Array, tag: string): Uint8Array | undefined {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = view.getUint16(4);
  if (12 + 16 * numTables > sfnt.byteLength) {
    throw new Error('sfnt table directory is truncated');
  }
  for (let i = 0; i < numTables; i++) {
    const record = 12 + 16 * i;
    const recordTag = String.fromCharCode(...sfnt.subarray(record, record + 4));
    if (recordTag !== tag) continue;
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > sfnt.byteLength) {
      throw new Error(`sfnt ${tag} table runs past the end of the font`);
    }
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

// The autohinter script whose metrics hint `codePoint`'s glyph, if any.
function autohintScriptOf(codePoint: number): string | undefined {
  let lo = 0;
  let hi = AUTOHINT_SCRIPT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last, script] = AUTOHINT_SCRIPT_RANGES[mid];
    if (codePoint < first) hi = mid - 1;
    else if (codePoint > last) lo = mid + 1;
    else return script;
  }
  return undefined;
}

// `text` plus the characters the autohinter measures stem widths and
// alignment zones on, for each autohinter script `text`'s characters fall in
// (by codepoint range, as Skrifa assigns them: digits are Latin, kana and
// Hangul are CJK). It measures them in the font it is given, so a subset
// missing "H" or "o" snaps its glyphs to different zones than the full font.
// The subsetter ignores characters the font lacks.
export function withAutohintReferenceChars(text: string): string {
  const scripts = new Set<string>();
  for (const char of text) {
    const script = autohintScriptOf(char.codePointAt(0) as number);
    if (script) scripts.add(script);
  }
  let reference = '';
  for (const script of scripts) reference += AUTOHINT_REFERENCE_CHARS[script];
  return text + reference;
}
