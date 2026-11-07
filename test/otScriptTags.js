const expect = require('unexpected');
const { otScriptTagsForText, otTagsForScript } = require('../lib/otScriptTags');

describe('otScriptTags', function () {
  describe('otTagsForScript', function () {
    [
      ['Latn', ['latn']],
      ['Cyrl', ['cyrl']],
      ['Deva', ['dev3', 'dev2', 'deva']],
      ['Mymr', ['mym2', 'mymr']],
      ['Hira', ['kana']],
      ['Laoo', ['lao ']],
      ['Yiii', ['yi  ']],
      ['Hang', ['hang', 'jamo']],
    ].forEach(([script, tags]) => {
      it(`should map ${script} to ${tags.join(', ')}`, function () {
        expect(otTagsForScript(script), 'to equal', tags);
      });
    });
  });

  describe('otScriptTagsForText', function () {
    [
      ['Latin text', 'Hello, world 42', ['DFLT', 'dflt', 'latn']],
      [
        'Latin with a combining acute (Script_Extensions includes Cyrl and Grek)',
        'café',
        ['DFLT', 'dflt', 'latn'],
      ],
      ['Cyrillic text', 'Привет', ['DFLT', 'cyrl', 'dflt', 'latn']],
      ['Greek mixed into Latin', 'π day', ['DFLT', 'dflt', 'grek', 'latn']],
      [
        'Devanagari with a danda',
        'नमस्ते।',
        ['DFLT', 'dev2', 'dev3', 'deva', 'dflt', 'latn'],
      ],
      ['Syriac', 'ܫܠܡܐ', ['DFLT', 'dflt', 'latn', 'syrc']],
      ['Arabic Extended-A', 'ࢠ', ['DFLT', 'arab', 'dflt', 'latn']],
      [
        'Japanese',
        '日本語のテキスト',
        ['DFLT', 'dflt', 'hani', 'kana', 'latn'],
      ],
    ].forEach(([label, text, tags]) => {
      it(`should select ${tags.join(', ')} for ${label}`, function () {
        expect(otScriptTagsForText(text), 'to equal', tags);
      });
    });

    it('should keep every script a lone Common character extends to', function () {
      // U+0964 DEVANAGARI DANDA is Script=Common, shared by Indic scripts.
      const tags = otScriptTagsForText('ab।');
      expect(tags, 'to contain', 'dev2', 'deva', 'bng2', 'beng', 'latn');
    });

    [
      ['digits and punctuation', '0123 .,!'],
      ['an empty string', ''],
      ['private-use characters', ''],
    ].forEach(([label, text]) => {
      it(`should retain all scripts for ${label}`, function () {
        expect(otScriptTagsForText(text), 'to be undefined');
      });
    });
  });
});
