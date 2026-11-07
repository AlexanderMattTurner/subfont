const expect = require('unexpected');

const scriptContext = (text, langs = []) => ({ text, langs });
const {
  otScriptTagsForText,
  _otTagsForScript,
} = require('../lib/otScriptTags');

describe('otScriptTags', function () {
  describe('_otTagsForScript', function () {
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
        expect(_otTagsForScript(script), 'to equal', tags);
      });
    });
  });

  describe('otScriptTagsForText', function () {
    [
      ['Latin text', 'Hello, world 42', ['DFLT', 'dflt', 'latn', 'math']],
      [
        'Latin with a combining acute (Script_Extensions includes Cyrl and Grek)',
        'café',
        ['DFLT', 'dflt', 'latn', 'math'],
      ],
      ['Cyrillic text', 'Привет', ['DFLT', 'cyrl', 'dflt', 'latn', 'math']],
      [
        'Greek mixed into Latin',
        'π day',
        ['DFLT', 'dflt', 'grek', 'latn', 'math'],
      ],
      [
        'Devanagari with a danda',
        'नमस्ते।',
        ['DFLT', 'dev2', 'dev3', 'deva', 'dflt', 'latn', 'math'],
      ],
      ['Syriac', 'ܫܠܡܐ', ['DFLT', 'dflt', 'latn', 'math', 'syrc']],
      ['Arabic Extended-A', 'ࢠ', ['DFLT', 'arab', 'dflt', 'latn', 'math']],
      [
        'Japanese',
        '日本語のテキスト',
        ['DFLT', 'dflt', 'hani', 'kana', 'latn', 'math'],
      ],
    ].forEach(([label, text, tags]) => {
      it(`should select ${tags.join(', ')} for ${label}`, function () {
        expect(
          otScriptTagsForText(text, scriptContext(text)),
          'to equal',
          tags
        );
      });
    });

    it('should keep every script a Common character extends to when none is present', function () {
      // U+0964 DEVANAGARI DANDA is Script=Common, shared by Indic scripts.
      expect(
        otScriptTagsForText('ab\u0964', scriptContext('ab\u0964')),
        'to equal',
        [
          ...['DFLT', 'beng', 'bng2', 'bng3', 'dev2', 'dev3', 'deva', 'dflt'],
          ...['dogr', 'gjr2', 'gjr3', 'gong', 'gonm', 'gran', 'gujr', 'gur2'],
          ...['gur3', 'guru', 'knd2', 'knd3', 'knda', 'latn', 'mahj', 'math'],
          ...['mlm2', 'mlm3', 'mlym', 'nand', 'onao', 'ory2', 'ory3', 'orya'],
          ...['sind', 'sinh', 'sylo', 'takr', 'taml', 'tel2', 'tel3', 'telu'],
          ...['tirh', 'tml2', 'tml3'],
        ]
      );
    });

    it('should keep the scripts of the pages the font appears on', function () {
      // Digits set in this font inside a Cyrillic paragraph shape as cyrl.
      expect(
        otScriptTagsForText('abc 123', scriptContext('Привет abc 123')),
        'to equal',
        ['DFLT', 'cyrl', 'dflt', 'latn', 'math']
      );
    });

    [
      ['digits and punctuation', '0123 .,!'],
      ['a lone combining mark', '\u0301'],
      ['an empty string', ''],
      ['private-use characters', '\ue000\ue001'],
      ['a codepoint unassigned in this runtime', 'ab\u0378'],
    ].forEach(([label, text]) => {
      it(`should retain all scripts for ${label}`, function () {
        expect(
          otScriptTagsForText(text, scriptContext(text)),
          'to be undefined'
        );
      });
    });

    [
      ['ru', ['DFLT', 'cyrl', 'dflt', 'latn', 'math']],
      ['ja', ['DFLT', 'dflt', 'hani', 'kana', 'latn', 'math']],
      ['', ['DFLT', 'dflt', 'latn', 'math']],
    ].forEach(([lang, tags]) => {
      it(`should keep the scripts lang="${lang}" implies`, function () {
        // A digit run on a lang="ru" page shapes as cyrl.
        expect(
          otScriptTagsForText('ab 123', scriptContext('ab 123', [lang])),
          'to equal',
          tags
        );
      });
    });

    [
      ['an unknown script', scriptContext('abc\u0378')],
      ['an invalid lang', scriptContext('abc', ['x-foo'])],
    ].forEach(([label, ctx]) => {
      it(`should retain all scripts when the page context has ${label}`, function () {
        expect(otScriptTagsForText('abc', ctx), 'to be undefined');
      });
    });
  });
});
