const expect = require('unexpected');
const { FontConverterPool } = require('../lib/fontConverter');
const fs = require('fs');
const pathModule = require('path');

const woff2Path = pathModule.resolve(
  __dirname,
  '..',
  'testdata',
  'subsetFonts',
  'Roboto-400.woff2'
);

describe('FontConverterPool', function () {
  let woff2Font;
  let pool;
  before(function () {
    woff2Font = fs.readFileSync(woff2Path);
  });
  beforeEach(function () {
    pool = new FontConverterPool();
  });
  afterEach(async function () {
    await pool.destroy();
  });

  it('should convert a woff2 font to sfnt', async function () {
    const result = await pool.convert(woff2Font, 'sfnt');
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle multiple concurrent conversions', async function () {
    const results = await Promise.all([
      pool.convert(woff2Font, 'sfnt'),
      pool.convert(woff2Font, 'sfnt'),
    ]);
    for (const result of results) {
      expect(result, 'to be a', Buffer);
    }
    expect(results[0].length, 'to equal', results[1].length);
  });

  it('should reject on invalid input', async function () {
    await expect(
      pool.convert(Buffer.from('not a valid font'), 'sfnt'),
      'to be rejected'
    );
  });

  it('should reject convert() after destroy()', async function () {
    await pool.destroy();
    await expect(
      pool.convert(woff2Font, 'sfnt'),
      'to be rejected with',
      'FontConverterPool has been destroyed'
    );
  });
});
