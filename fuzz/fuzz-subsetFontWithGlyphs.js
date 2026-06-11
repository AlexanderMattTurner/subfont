// Byte-mutation fuzzing of the harfbuzz WASM subsetting path.
// Take known-good fonts from testdata, corrupt random bytes (and sometimes
// truncate), and feed them through subsetFontWithGlyphs. Acceptable
// outcomes: a Buffer result or a clean JS-level throw. Unacceptable:
// process abort, hang, or unhandled rejection from inside the WASM glue.
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');
const { makeRng } = require('./_helpers');

const FONT_PATHS = [
  'testdata/subsetFonts/Montserrat-400.ttf',
  'testdata/subsetFonts/Roboto-500.woff2',
];

const TRIALS_PER_FONT = 150;

function mutate(buffer, rng) {
  let copy = Buffer.from(buffer);
  if (rng.bool(0.15)) {
    copy = copy.subarray(0, rng.int(0, copy.length));
  }
  const flips = rng.int(1, 32);
  for (let i = 0; i < flips && copy.length > 0; i++) {
    copy[rng.int(0, copy.length - 1)] = rng.int(0, 255);
  }
  return copy;
}

async function main() {
  let failures = 0;
  for (const relPath of FONT_PATHS) {
    const original = fs.readFileSync(
      pathModule.resolve(__dirname, '..', relPath)
    );
    let cleanErrors = 0;
    for (let seed = 1; seed <= TRIALS_PER_FONT; seed++) {
      const rng = makeRng(seed);
      const corrupted = mutate(original, rng);
      if (seed % 25 === 0) {
        console.log(`  ${relPath}: trial ${seed}/${TRIALS_PER_FONT}`);
      }
      try {
        const result = await subsetFontWithGlyphs(corrupted, 'Hello fuzz', {
          targetFormat: 'woff2',
        });
        if (!Buffer.isBuffer(result)) {
          failures++;
          console.error(
            `FAIL ${relPath} seed=${seed}: non-Buffer result ${typeof result}`
          );
        }
      } catch {
        cleanErrors++; // clean throw on corrupt input is the expected outcome
      }
    }
    console.log(
      `${relPath}: ${TRIALS_PER_FONT} corrupted variants, ${cleanErrors} clean rejections, rest subset OK`
    );
  }
  if (failures > 0) {
    console.error(`subsetFontWithGlyphs: ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('subsetFontWithGlyphs: OK');
  }
}

main().then(
  () => process.exit(process.exitCode || 0),
  (err) => {
    console.error('FAIL subsetFontWithGlyphs (escaped rejection)');
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
);
