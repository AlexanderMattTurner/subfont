function unescapeCssString(str: string): string {
  return str.replace(
    /\\([0-9a-f]{1,6})(\s?)/gi,
    (match, hexChars: string, followingWhitespace: string) => {
      try {
        return `${String.fromCodePoint(parseInt(hexChars, 16))}${
          hexChars.length === 6 ? followingWhitespace : ''
        }`;
      } catch {
        return match;
      }
    }
  );
}

function unquote(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(
    /^'([^']*)'$|^"([^"]*)"$/,
    (
      _match,
      singleQuoted: string | undefined,
      doubleQuoted: string | undefined
    ) =>
      singleQuoted !== undefined
        ? unescapeCssString(singleQuoted.replace(/\\'/g, "'"))
        : unescapeCssString((doubleQuoted ?? '').replace(/\\"/g, '"'))
  );
}

export = unquote;
