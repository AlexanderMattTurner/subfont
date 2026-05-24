const expect = require('unexpected');
const { wrapAssetGraphError } = require('../lib/types/shared');

describe('wrapAssetGraphError', function () {
  it('should pass through an Error instance', function () {
    const original = new Error('something broke');
    const result = wrapAssetGraphError(original);
    expect(result, 'to be', original);
    expect(result.message, 'to equal', 'something broke');
  });

  it('should convert a string to an Error', function () {
    const result = wrapAssetGraphError('bad thing happened');
    expect(result, 'to be an', Error);
    expect(result.message, 'to equal', 'bad thing happened');
  });

  it('should convert null to an Error', function () {
    const result = wrapAssetGraphError(null);
    expect(result, 'to be an', Error);
    expect(result.message, 'to equal', 'null');
  });

  it('should attach fallbackAsset when err has no .asset', function () {
    const err = new Error('oops');
    const fallback = { type: 'Html', url: 'https://example.com/' };
    const result = wrapAssetGraphError(err, fallback);
    expect(result.asset, 'to equal', fallback);
  });

  it('should not overwrite existing .asset', function () {
    const existing = { type: 'Css', url: 'https://example.com/style.css' };
    const err = new Error('oops');
    err.asset = existing;
    const fallback = { type: 'Html', url: 'https://example.com/' };
    const result = wrapAssetGraphError(err, fallback);
    expect(result.asset, 'to equal', existing);
  });

  it('should work without fallbackAsset', function () {
    const err = new Error('no fallback');
    const result = wrapAssetGraphError(err);
    expect(result.asset, 'to be undefined');
  });

  it('should convert a non-Error object to an Error via String()', function () {
    const result = wrapAssetGraphError({ message: 'not an Error instance' });
    expect(result, 'to be an', Error);
    expect(result.message, 'to equal', '[object Object]');
  });

  it('should convert undefined to an Error', function () {
    const result = wrapAssetGraphError(undefined);
    expect(result, 'to be an', Error);
    expect(result.message, 'to equal', 'undefined');
  });
});
