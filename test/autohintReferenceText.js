const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const { toSfnt } = require('../lib/sfntCache');
const {
  isAutohinted,
  withAutohintReferenceChars,
} = require('../lib/autohintReferenceText');
const { AUTOHINT_REFERENCE_CHARS } = require('../lib/autohintReferenceChars');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');
const getFontInfo = require('../lib/getFontInfo');

const testdata = (...parts) =>
  pathModule.resolve(__dirname, '..', 'testdata', ...parts);
const UNHINTED_LATIN = testdata(
  'iframe',
  'SourceSerifVariable-Roman.ttf.woff2'
);
const HINTED_LATIN = testdata('subsetFonts', 'Roboto-500.ttf');

// A minimal sfnt holding only the given tables, each a Uint8Array.
function sfntWith(tables) {
  const tags = Object.keys(tables);
  const headerLength = 12 + 16 * tags.length;
  const length = tags.reduce((sum, tag) => sum + tables[tag].length, 0);
  const sfnt = new Uint8Array(headerLength + length);
  const view = new DataView(sfnt.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tags.length);
  let offset = headerLength;
  tags.forEach((tag, i) => {
    const record = 12 + 16 * i;
    sfnt.set(Buffer.from(tag, 'latin1'), record);
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, tables[tag].length);
    sfnt.set(tables[tag], offset);
    offset += tables[tag].length;
  });
  return sfnt;
}

function maxpWithInstructions(maxSizeOfInstructions) {
  const maxp = new Uint8Array(32);
  new DataView(maxp.buffer).setUint16(26, maxSizeOfInstructions);
  return maxp;
}

const charsOf = async (font) =>
  (await getFontInfo(font)).characterSet.map((cp) => String.fromCodePoint(cp));

describe('autohintReferenceText', function () {
  describe('isAutohinted', function () {
    const glyf = new Uint8Array(4);
    [
      ['unhinted TrueType', { glyf, maxp: maxpWithInstructions(0) }, true],
      ['TrueType with fpgm', { glyf, fpgm: new Uint8Array(2) }, false],
      ['TrueType with prep', { glyf, prep: new Uint8Array(2) }, false],
      [
        'TrueType with glyph instructions',
        { glyf, maxp: maxpWithInstructions(12) },
        false,
      ],
      [
        'TrueType with empty fpgm and prep',
        { glyf, fpgm: new Uint8Array(0), prep: new Uint8Array(0) },
        true,
      ],
      ['CFF', { 'CFF ': new Uint8Array(4) }, false],
    ].forEach(([label, tables, expected]) => {
      it(`should return ${expected} for ${label}`, function () {
        expect(isAutohinted(sfntWith(tables)), 'to be', expected);
      });
    });

    [
      ['a truncated table directory', sfntWith({ glyf }).subarray(0, 20)],
      [
        'a table past the end of the font',
        sfntWith({ glyf: new Uint8Array(8) }).subarray(0, 32),
      ],
    ].forEach(([label, sfnt]) => {
      it(`should throw for ${label}`, function () {
        expect(() => isAutohinted(sfnt), 'to throw');
      });
    });

    [
      [UNHINTED_LATIN, true],
      [HINTED_LATIN, false],
    ].forEach(([path, expected]) => {
      it(`should return ${expected} for ${pathModule.basename(path)}`, async function () {
        const sfnt = await toSfnt(fs.readFileSync(path));
        expect(isAutohinted(sfnt), 'to be', expected);
      });
    });
  });

  describe('withAutohintReferenceChars', function () {
    [
      ['Latin', 'ab', `ab${AUTOHINT_REFERENCE_CHARS.Latn}`],
      ['Cyrillic', 'дом', `дом${AUTOHINT_REFERENCE_CHARS.Cyrl}`],
      ['digits', '123', `123${AUTOHINT_REFERENCE_CHARS.Latn}`],
      ['kana', 'かな', `かな${AUTOHINT_REFERENCE_CHARS.Hani}`],
      ['Hangul', '한', `한${AUTOHINT_REFERENCE_CHARS.Hani}`],
      ['private-use', '\ue000', '\ue000'],
    ].forEach(([label, text, expected]) => {
      it(`should append the reference characters of the autohinter scripts of ${label} text`, function () {
        expect(withAutohintReferenceChars(text), 'to equal', expected);
      });
    });
  });

  describe('in subsetFontWithGlyphs', function () {
    [
      [UNHINTED_LATIN, true, 'to contain'],
      [UNHINTED_LATIN, false, 'not to contain'],
      [HINTED_LATIN, true, 'not to contain'],
    ].forEach(([path, autohintReferenceChars, assertion]) => {
      it(`should ${assertion === 'to contain' ? 'add' : 'not add'} reference letters to ${pathModule.basename(path)} when the option is ${autohintReferenceChars}`, async function () {
        const subset = await subsetFontWithGlyphs(fs.readFileSync(path), 'ab', {
          targetFormat: 'truetype',
          autohintReferenceChars,
        });
        expect(await charsOf(subset), assertion, 'H', 'o', 'x');
      });
    });
  });
});
