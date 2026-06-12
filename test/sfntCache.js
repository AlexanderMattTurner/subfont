const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('sfntCache', function () {
  it('should return the buffer directly when format is sfnt', async function () {
    const buffer = Buffer.from('test');
    const convertStub = sinon.stub();
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: { detectFormat: sinon.stub().returns('sfnt') },
      './fontConverter': { convert: convertStub },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', buffer);
    expect(convertStub, 'was not called');
  });

  it('should route woff2 through a worker', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: { detectFormat: sinon.stub().returns('woff2') },
      './fontConverter': { convert: convertStub },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
  });

  it('should ask the worker for sfnt output and bypass fontverter.convert for woff2 input', async function () {
    const buffer = Buffer.from('woff2-routing');
    const workerConverted = Buffer.from('worker-converted');
    const convertStub = sinon.stub().resolves(workerConverted);
    const fontverterConvertStub = sinon
      .stub()
      .resolves(Buffer.from('fontverter-converted'));
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
        convert: fontverterConvertStub,
      },
      './fontConverter': { convert: convertStub },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', workerConverted);
    expect(fontverterConvertStub, 'was not called');
    expect(convertStub, 'to have a call satisfying', [buffer, 'sfnt']);
  });

  it('should request sfnt output from the worker in the detectFormat fallback', async function () {
    const buffer = Buffer.from('garbage-fallback-args');
    const convertStub = sinon.stub().resolves(Buffer.from('converted'));
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().throws(new Error('Unknown format')),
      },
      './fontConverter': { convert: convertStub },
    });

    await toSfnt(buffer);
    expect(convertStub, 'to have a call satisfying', [buffer, 'sfnt']);
  });

  it('should convert non-woff2 non-sfnt via fontverter directly', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub();
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff'),
        convert: sinon.stub().resolves(converted),
      },
      './fontConverter': { convert: convertStub },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
    expect(convertStub, 'was not called');
  });

  it('should fall back to worker when detectFormat throws', async function () {
    const buffer = Buffer.from('garbage');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().throws(new Error('Unknown format')),
      },
      './fontConverter': { convert: convertStub },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
  });

  it('should cache results for the same buffer', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: { detectFormat: sinon.stub().returns('woff2') },
      './fontConverter': { convert: convertStub },
    });

    await toSfnt(buffer);
    await toSfnt(buffer);
    expect(convertStub, 'was called once');
  });

  it('should evict cache on rejection so retries work', async function () {
    const buffer = Buffer.from('test');
    let callCount = 0;
    const convertStub = sinon.stub().callsFake(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve(Buffer.from('ok'));
    });
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: { detectFormat: sinon.stub().returns('woff2') },
      './fontConverter': { convert: convertStub },
    });

    await expect(toSfnt(buffer), 'to be rejected with', 'fail');
    const result = await toSfnt(buffer);
    expect(result, 'to equal', Buffer.from('ok'));
  });
});
