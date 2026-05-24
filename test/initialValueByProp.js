const expect = require('unexpected');
const initialValueByProp = require('../lib/initialValueByProp');

describe('initialValueByProp', function () {
  it("should have 'normal' as the initial value for font-weight", function () {
    expect(initialValueByProp['font-weight'], 'to equal', 'normal');
  });

  it("should have 'normal' as the initial value for font-style", function () {
    expect(initialValueByProp['font-style'], 'to equal', 'normal');
  });

  it("should have 'normal' as the initial value for font-stretch", function () {
    expect(initialValueByProp['font-stretch'], 'to equal', 'normal');
  });

  it("should have 'inline' as the initial value for display", function () {
    expect(initialValueByProp['display'], 'to equal', 'inline');
  });

  it("should have 'none' as the initial value for animation-name", function () {
    expect(initialValueByProp['animation-name'], 'to equal', 'none');
  });

  it('should have a string value for every key', function () {
    for (const key of Object.keys(initialValueByProp)) {
      expect(initialValueByProp[key], 'to be a', 'string');
    }
  });
});
