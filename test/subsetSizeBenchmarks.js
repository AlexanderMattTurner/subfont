// Byte-size regression checks for subsetFontWithGlyphs. Each `it()` asserts
// a hard upper bound on output bytes; bump only after confirming the
// regression isn't a real loss.
const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');

const PANGRAM = 'The quick brown fox jumps over the lazy dog 0123456789';

function tableSet(buf) {
  const numTables = buf.readUInt16BE(4);
  const set = new Set();
  for (let i = 0; i < numTables; i++) {
    set.add(buf.slice(12 + i * 16, 16 + i * 16).toString('ascii'));
  }
  return set;
}

const ROBOTO = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/Roboto-400.ttf'
);
const IBM_PLEX_SANS = pathModule.resolve(
  __dirname,
  '../testdata/referenceImages/fontVariant/IBMPlexSans-Regular.woff'
);

describe('subset size benchmarks', function () {
  this.timeout(60000);

  it('Roboto-400 truetype subset stays compact while preserving gasp', async function () {
    const buf = fs.readFileSync(ROBOTO);
    const result = await subsetFontWithGlyphs(buf, PANGRAM, {
      targetFormat: 'truetype',
      featureTags: [],
    });
    // The 2,400-byte budget includes the original hint programs and hdmx.
    // Lower bound guards against corrupted/truncated output.
    expect(result.length, 'to be greater than or equal to', 500);
    expect(result.length, 'to be less than or equal to', 2400);
    expect(tableSet(result).has('gasp'), 'to be true');
  });

  it('Roboto-400 woff2 subset produces a sane-sized output', async function () {
    const buf = fs.readFileSync(ROBOTO);
    const result = await subsetFontWithGlyphs(buf, PANGRAM, {
      targetFormat: 'woff2',
      featureTags: [],
    });
    // woff2 of a Latin pangram should be compact but non-trivial
    expect(result.length, 'to be greater than or equal to', 300);
    expect(result.length, 'to be less than or equal to', 2000);
  });

  [
    { name: 'Roboto-400', path: ROBOTO, maxWoff2Bytes: 1400 },
    { name: 'IBMPlexSans-Regular', path: IBM_PLEX_SANS, maxWoff2Bytes: 6200 },
  ].forEach(({ name, path, maxWoff2Bytes }) => {
    it(`${name} retains rendering data within the woff2 size budget`, async function () {
      const result = await subsetFontWithGlyphs(
        fs.readFileSync(path),
        PANGRAM,
        {
          targetFormat: 'woff2',
          featureTags: [],
        }
      );
      expect(result.length, 'to be greater than', 100);
      expect(result.length, 'to be less than or equal to', maxWoff2Bytes);
    });
  });
});
