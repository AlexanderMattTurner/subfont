const expect = require('unexpected');
const injectSubsetDefinitions = require('../lib/injectSubsetDefinitions');

describe('injectSubsetDefinitions', function () {
  const webfontNameMap = {
    'times new roman': 'times new roman__subset',
  };

  it('should inject before a doublequoted font family name', function () {
    expect(
      injectSubsetDefinitions('"times new roman"', webfontNameMap),
      'to equal',
      '\'times new roman__subset\', "times new roman"'
    );
  });

  it('should inject before a singlequoted font family name', function () {
    expect(
      injectSubsetDefinitions("'times new roman'", webfontNameMap),
      'to equal',
      "'times new roman__subset', 'times new roman'"
    );
  });

  it('should inject before a "bareword" font family name', function () {
    expect(
      injectSubsetDefinitions('times new roman', webfontNameMap),
      'to equal',
      "'times new roman__subset', times new roman"
    );
  });

  it('should match the font-family case sensitively', function () {
    expect(
      injectSubsetDefinitions('Times new rOman', webfontNameMap),
      'to equal',
      "'times new roman__subset', Times new rOman"
    );
  });

  it('should tolerate multiple spaces between words', function () {
    expect(
      injectSubsetDefinitions('times   new   roman', webfontNameMap),
      'to equal',
      "'times new roman__subset', times   new   roman"
    );
  });

  it('should ignore occurrences that are immediately preceded by other barewords', function () {
    expect(
      injectSubsetDefinitions('sorry times new roman, other', webfontNameMap),
      'to equal',
      'sorry times new roman, other'
    );
  });

  it('should ignore occurrences that are succeeded by other barewords', function () {
    expect(
      injectSubsetDefinitions('times new roman yeah', webfontNameMap),
      'to equal',
      'times new roman yeah'
    );
  });

  it('should not inject the subset into a value that already has it, same casing', function () {
    expect(
      injectSubsetDefinitions(
        "'times new roman__subset', times new roman",
        webfontNameMap
      ),
      'to equal',
      "'times new roman__subset', times new roman"
    );
  });

  it('should not inject the subset into a value that already has it, case difference in existing value', function () {
    expect(
      injectSubsetDefinitions(
        "'TIMES new roman__subset', times new roman",
        webfontNameMap
      ),
      'to equal',
      "'TIMES new roman__subset', times new roman"
    );
  });

  it('should not inject the subset into a value that already has it, case difference in webfontNameMap value', function () {
    expect(
      injectSubsetDefinitions("'times new roman__subset', times new roman", {
        'times new roman': 'TIMES new roman__subset',
      }),
      'to equal',
      "'times new roman__subset', times new roman"
    );
  });

  it('should escape singlequotes in the subset font name', function () {
    expect(
      injectSubsetDefinitions('"times new roman"', {
        'times new roman': "times'new'roman__subset",
      }),
      'to equal',
      "'times\\'new\\'roman__subset', \"times new roman\""
    );
  });

  it('should escape backslashes in the subset font name before quoting', function () {
    // A literal `\` followed by the closing `'` would otherwise form a CSS
    // escape sequence rather than a literal backslash followed by a quote.
    expect(
      injectSubsetDefinitions('"times new roman"', {
        'times new roman': 'times\\new\\roman__subset',
      }),
      'to equal',
      '\'times\\\\new\\\\roman__subset\', "times new roman"'
    );
  });

  it('should inject before a bareword font family that follows a quoted one not in the map', function () {
    const map = {
      'times new roman': 'times new roman__subset',
    };
    expect(
      injectSubsetDefinitions('"Arial", times new roman', map),
      'to equal',
      '"Arial", \'times new roman__subset\', times new roman'
    );
  });

  it('should inject into a font list where an unquoted family follows a quoted one', function () {
    const map = {
      roboto: 'roboto__subset',
    };
    expect(
      injectSubsetDefinitions('"Open Sans", Roboto, sans-serif', map),
      'to equal',
      '"Open Sans", \'roboto__subset\', Roboto, sans-serif'
    );
  });

  describe('when replaceOriginal is true', function () {
    it('should replace a "bareword" font family name that is the last token', function () {
      expect(
        injectSubsetDefinitions('times new roman', webfontNameMap, true),
        'to equal',
        "'times new roman__subset'"
      );
    });

    it('should replace a "bareword" font family name before a comma', function () {
      expect(
        injectSubsetDefinitions('times new roman, serif', webfontNameMap, true),
        'to equal',
        "'times new roman__subset', serif"
      );
    });

    it('should replace a quoted font family name before a comma', function () {
      expect(
        injectSubsetDefinitions(
          '"times new roman", serif',
          webfontNameMap,
          true
        ),
        'to equal',
        "'times new roman__subset', serif"
      );
    });
  });
});
