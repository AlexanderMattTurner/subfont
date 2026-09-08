// Byte-size regression checks for subsetFontWithGlyphs. Each `it()` asserts
// a hard upper bound on output bytes; bump only after confirming the
// regression isn't a real loss.
const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const fontverter = require('fontverter');
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
    // Retaining the 12-byte gasp table also adds a 16-byte SFNT directory entry.
    // Lower bound guards against corrupted/truncated output.
    expect(result.length, 'to be greater than or equal to', 500);
    expect(result.length, 'to be less than or equal to', 1158);
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
    { name: 'Roboto-400', path: ROBOTO, maxWoff2Bytes: 650 },
    { name: 'IBMPlexSans-Regular', path: IBM_PLEX_SANS, maxWoff2Bytes: 4250 },
  ].forEach(({ name, path, maxWoff2Bytes }) => {
    it(`${name} script filtering removes data within the woff2 size budget`, async function () {
      const buf = fs.readFileSync(path);
      const baseOpts = { targetFormat: 'woff2', featureTags: [] };
      const all = await subsetFontWithGlyphs(buf, PANGRAM, baseOpts);
      const latnOnly = await subsetFontWithGlyphs(buf, PANGRAM, {
        ...baseOpts,
        scriptTags: ['DFLT', 'latn'],
      });
      expect(latnOnly.length, 'to be greater than', 100);
      expect(latnOnly.length, 'to be less than or equal to', maxWoff2Bytes);
      // Compression is not monotonic: retaining gasp makes IBM Plex's
      // filtered WOFF2 28 bytes larger despite removing 24 SFNT bytes.
      const allSfnt = await fontverter.convert(all, 'truetype');
      const latnSfnt = await fontverter.convert(latnOnly, 'truetype');
      expect(latnSfnt.length, 'to be less than', allSfnt.length);
    });
  });
});
