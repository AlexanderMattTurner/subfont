// Round-trip property: getUnicodeRanges(codePoints) must serialize to a
// unicode-range string that expands back to exactly the deduped input set.
const getUnicodeRanges = require('../lib/unicodeRange');
const { fuzzLoop, failWith } = require('./_helpers');

function expandRanges(rangeString) {
  if (rangeString === '') return [];
  return rangeString.split(',').flatMap((part) => {
    const m = /^U\+(?<start>[0-9A-F]+)(?:-(?<end>[0-9A-F]+))?$/.exec(part);
    if (!m) failWith(`unparseable range part: ${part}`, rangeString);
    const start = parseInt(m.groups.start, 16);
    const end = m.groups.end !== undefined ? parseInt(m.groups.end, 16) : start;
    if (end < start) failWith(`inverted range: ${part}`, rangeString);
    const out = [];
    for (let cp = start; cp <= end; cp++) out.push(cp);
    return out;
  });
}

fuzzLoop('unicodeRange', 5000, (rng) => {
  const count = rng.int(0, 60);
  const codePoints = [];
  for (let i = 0; i < count; i++) {
    // Mix dense clusters (to exercise range coalescing) with sparse points.
    if (rng.bool(0.5) && codePoints.length > 0) {
      const base = rng.pick(codePoints);
      codePoints.push(base + rng.int(-2, 2));
    } else {
      codePoints.push(rng.int(0, 0x10ffff));
    }
  }
  // Occasionally shuffle in duplicates and unsorted order (already random).
  const negativeFiltered = codePoints.map((cp) => Math.max(0, cp));

  const serialized = getUnicodeRanges(negativeFiltered);
  const expanded = expandRanges(serialized);
  const expected = [...new Set(negativeFiltered)].sort((a, b) => a - b);

  if (
    expanded.length !== expected.length ||
    expanded.some((cp, i) => cp !== expected[i])
  ) {
    failWith(
      `round-trip mismatch: got [${expanded}] expected [${expected}]`,
      negativeFiltered
    );
  }
});
