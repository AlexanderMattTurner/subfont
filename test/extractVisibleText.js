const expect = require('unexpected');
const extractVisibleText = require('../lib/extractVisibleText');
const { INVISIBLE_ELEMENTS } = require('../lib/extractVisibleText');

describe('extractVisibleText', function () {
  it('should extract plain text content', function () {
    const result = extractVisibleText('<p>Hello, world!</p>');
    expect(result, 'to contain', 'Hello, world!');
  });

  // <head> is only valid as a child of <html> (parser ignores it in body),
  // <embed> is a void element (cannot contain text children).
  const SKIP_GENERIC_TEST = new Set(['head', 'embed']);
  for (const element of INVISIBLE_ELEMENTS) {
    if (SKIP_GENERIC_TEST.has(element)) continue;
    it(`should strip <${element}> elements and their contents`, function () {
      const result = extractVisibleText(
        `<p>visible</p><${element}>hidden content</${element}>`
      );
      expect(result, 'to contain', 'visible');
      expect(result, 'not to contain', 'hidden content');
    });
  }

  it('should decode HTML entities', function () {
    const result = extractVisibleText('<p>&amp; &lt; &gt; &quot; &apos;</p>');
    expect(result, 'to contain', '&');
    expect(result, 'to contain', '<');
    expect(result, 'to contain', '>');
    expect(result, 'to contain', '"');
    expect(result, 'to contain', "'");
  });

  it('should decode numeric HTML entities', function () {
    const result = extractVisibleText('<p>&#65; &#x42;</p>');
    expect(result, 'to contain', 'A');
    expect(result, 'to contain', 'B');
  });

  it('should decode &nbsp; entities', function () {
    const result = extractVisibleText('<p>hello&nbsp;world</p>');
    expect(result, 'to contain', 'hello\u00A0world');
  });

  it('should extract alt attributes from images', function () {
    const result = extractVisibleText(
      '<img alt="descriptive text" src="photo.jpg">'
    );
    expect(result, 'to contain', 'descriptive text');
  });

  it('should not extract title attributes (rendered in the OS font, not webfonts)', function () {
    const result = extractVisibleText(
      '<a title="link tooltip" href="#">click</a>'
    );
    expect(result, 'not to contain', 'link tooltip');
    expect(result, 'to contain', 'click');
  });

  it('should extract placeholder attributes', function () {
    const result = extractVisibleText(
      '<input placeholder="Enter name" type="text">'
    );
    expect(result, 'to contain', 'Enter name');
  });

  it('should not extract aria-label attributes (not visually rendered)', function () {
    const result = extractVisibleText(
      '<button aria-label="Close dialog">X</button>'
    );
    expect(result, 'not to contain', 'Close dialog');
    expect(result, 'to contain', 'X');
  });

  it('should not extract aria-description attributes (not visually rendered)', function () {
    const result = extractVisibleText(
      '<button aria-description="Saves all pending changes">Save</button>'
    );
    expect(result, 'not to contain', 'Saves all pending changes');
    expect(result, 'to contain', 'Save');
  });

  it('should strip HTML comments', function () {
    const result = extractVisibleText(
      '<p>visible</p><!-- hidden comment --><p>also visible</p>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'not to contain', 'hidden comment');
  });

  it('should handle a full HTML document', function () {
    const result = extractVisibleText(`
      <!DOCTYPE html>
      <html>
      <head><title>Page Title</title><style>body{color:red}</style></head>
      <body>
        <h1>Main Heading</h1>
        <p>Paragraph with <strong>bold</strong> text.</p>
        <script>console.log("hidden");</script>
        <img alt="photo description">
      </body>
      </html>
    `);
    // <title> is inside <head>, which is not visible page content
    // (browser tab titles use system fonts, not web fonts)
    expect(result, 'not to contain', 'Page Title');
    expect(result, 'to contain', 'Main Heading');
    expect(result, 'to contain', 'Paragraph with');
    expect(result, 'to contain', 'bold');
    expect(result, 'to contain', 'text.');
    expect(result, 'to contain', 'photo description');
    expect(result, 'not to contain', 'console.log');
    expect(result, 'not to contain', 'color:red');
  });

  it('should handle empty input', function () {
    const result = extractVisibleText('');
    expect(result, 'to be a', 'string');
  });

  it('should handle nested script tags', function () {
    const result = extractVisibleText(
      '<div>before<script type="text/javascript">var s = "<script>nested</script>";</script>after</div>'
    );
    expect(result, 'to contain', 'before');
    expect(result, 'to contain', 'after');
  });

  it('should handle multiple sibling script elements', function () {
    const result = extractVisibleText(
      '<script>hidden_a</script>between<script>hidden_b</script>'
    );
    expect(result, 'to contain', 'between');
    expect(result, 'not to contain', 'hidden_a');
    expect(result, 'not to contain', 'hidden_b');
  });

  it('should not extract value from hidden inputs', function () {
    const result = extractVisibleText('<input type="hidden" value="secret">');
    expect(result, 'not to contain', 'secret');
  });

  it('should handle attributes with HTML entities', function () {
    const result = extractVisibleText('<img alt="Tom &amp; Jerry">');
    expect(result, 'to contain', 'Tom & Jerry');
  });

  it('should handle unquoted attributes', function () {
    const result = extractVisibleText('<img alt=hello>');
    expect(result, 'to contain', 'hello');
  });

  it('should not extract data- attributes that look like extractable attrs', function () {
    // parse5 matches exact attribute names, so data-alt is correctly ignored.
    const result = extractVisibleText(
      '<div data-alt="extra-text">content</div>'
    );
    expect(result, 'to contain', 'content');
    expect(result, 'not to contain', 'extra-text');
  });

  it('should return empty string for null input', function () {
    expect(extractVisibleText(null), 'to equal', '');
  });

  it('should return empty string for undefined input', function () {
    expect(extractVisibleText(undefined), 'to equal', '');
  });

  it('should decode typographic entities', function () {
    const result = extractVisibleText(
      '<p>&ldquo;hello&rdquo; &mdash; &hellip;</p>'
    );
    expect(result, 'to contain', '\u201C');
    expect(result, 'to contain', '\u201D');
    expect(result, 'to contain', '\u2014');
    expect(result, 'to contain', '\u2026');
  });

  it('should extract value from visible inputs', function () {
    const result = extractVisibleText(
      '<input type="text" value="visible-value">'
    );
    expect(result, 'to contain', 'visible-value');
  });

  it('should return independent results for consecutive calls', function () {
    const result1 = extractVisibleText('<p>first</p>');
    const result2 = extractVisibleText('<p>second</p>');
    expect(result1, 'to contain', 'first');
    expect(result2, 'to contain', 'second');
    expect(result2, 'not to contain', 'first');
  });

  it('should not throw on invalid numeric HTML entities', function () {
    // Per the HTML spec parse5 maps out-of-range numeric refs to U+FFFD.
    // The substantive invariant is "doesn't crash"; what character ends up
    // in the output doesn't matter as long as no lone surrogate leaks.
    const result = extractVisibleText(
      '<p>before &#xFFFFFFFF; after &#99999999; end</p>'
    );
    expect(result, 'to contain', 'before');
    expect(result, 'to contain', 'after');
    expect(result, 'to contain', 'end');
  });

  it('should not decode surrogate-half numeric entities into lone surrogates', function () {
    // &#xD800; / &#55296; are high-surrogate code units — not valid scalars.
    // Emitting String.fromCodePoint(0xD800) would corrupt downstream
    // [...string] iteration and confuse harfbuzz / unicode-range emission.
    // parse5 follows the HTML spec and replaces surrogate-range refs with
    // U+FFFD; the invariant we care about is no lone surrogate in output.
    const result = extractVisibleText(
      '<p>x&#xD800;y&#xDFFF;z&#55296;w&#57343;v</p>'
    );
    expect(result, 'to contain', 'x');
    expect(result, 'to contain', 'y');
    expect(result, 'to contain', 'z');
    expect(result, 'to contain', 'w');
    expect(result, 'to contain', 'v');
    // No actual lone-surrogate code units leak into the output.
    for (const ch of result) {
      const cp = ch.codePointAt(0);
      expect(cp < 0xd800 || cp > 0xdfff, 'to be true');
    }
  });

  it('should decode the full HTML5 named-entity set (accented Latin etc.)', function () {
    // Regression: the hand-rolled namedEntities table only covered ~30 of
    // ~2200 HTML5 named entities, so European-language pages using
    // &eacute; / &ouml; for accents silently dropped those glyphs from
    // the subset. parse5 decodes the full set.
    const result = extractVisibleText(
      '<p>caf&eacute; na&iuml;ve &Eacute;cole &ouml;l</p>'
    );
    expect(result, 'to contain', 'café');
    expect(result, 'to contain', 'naïve');
    expect(result, 'to contain', 'École');
    expect(result, 'to contain', 'öl');
  });

  it('should strip invisible elements whose attributes contain ">"', function () {
    // Regression: the previous regex stripper used [^>]* for the opening
    // tag, so an attribute value containing > could trip it. parse5 always
    // gets attribute parsing right.
    const result = extractVisibleText(
      '<svg aria-label="a>b"><text>hidden-svg</text></svg><p>visible</p>'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'not to contain', 'hidden-svg');
  });

  it('should not extract attributes from inside invisible elements', function () {
    const result = extractVisibleText(
      '<p>visible</p><script>var x = "<img alt=\\"hidden-attr\\">";</script><img alt="real-alt">'
    );
    expect(result, 'to contain', 'visible');
    expect(result, 'to contain', 'real-alt');
    expect(result, 'not to contain', 'hidden-attr');
  });

  it('should not leak attributes from inside style blocks', function () {
    const result = extractVisibleText(
      '<style title="style-title">body { color: red; }</style><p title="visible-title">text</p>'
    );
    expect(result, 'to contain', 'text');
    // title is no longer extracted at all (OS-font tooltip, never painted in
    // a webfont), so neither the style-block title nor the paragraph title
    // should appear.
    expect(result, 'not to contain', 'visible-title');
    expect(result, 'not to contain', 'style-title');
  });

  it('should strip invisible blocks across repeated calls', function () {
    // parse5 is stateless across calls; this guards against any future
    // refactor that introduces shared mutable state in the walker.
    for (let i = 0; i < 5; i++) {
      const result = extractVisibleText(
        `<div>visible${i}</div><script>hidden${i}</script><p>after${i}</p>`
      );
      expect(result, 'to contain', `visible${i}`);
      expect(result, 'to contain', `after${i}`);
      expect(result, 'not to contain', `hidden${i}`);
    }
  });
});
