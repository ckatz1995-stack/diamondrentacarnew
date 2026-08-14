// Minimal stand-in for the 'wix-data' Velo backend module.
// Only exists so files under test that `import wixData from 'wix-data'` at
// module scope can load under Jest; tests exercising real query/insert/update
// behavior should override these with jest.fn() mocks per-test.
const notImplemented = (method) => () => {
  throw new Error(`wix-data mock: '${method}' was not mocked for this test`);
};

export default {
  query: notImplemented('query'),
  insert: notImplemented('insert'),
  update: notImplemented('update'),
  remove: notImplemented('remove'),
  get: notImplemented('get'),
};
