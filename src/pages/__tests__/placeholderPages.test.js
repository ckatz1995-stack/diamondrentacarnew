import { installPageEnv } from '../../../test/helpers/fakePageEnv.js';

// Two pages kept in the repo as placeholders until the Wix editor confirms
// whether the matching pages still exist. They register a ready callback and do
// nothing, and that is the whole of what these assert — so if project logic is
// ever added to one, it arrives without a test and this stops being true.

const PLACEHOLDERS = [
  ['New Page', () => import('../New Page.zv4ph.js')],
  ['Dashboard', () => import('../Dashboard.eh252.js')],
];

let env;

afterEach(() => {
  if (env) env.restore();
  env = null;
});

describe.each(PLACEHOLDERS)('%s', (name, importer) => {
  test('registers a ready callback and does nothing on the page', async () => {
    jest.resetModules();
    const html = { id: 'anything', type: 'HtmlComponent', postMessage: jest.fn(), show: jest.fn(), collapse: jest.fn(), hide: jest.fn() };
    env = installPageEnv({ '#anything': html });

    await expect(env.start(importer)).resolves.toBeUndefined();

    expect(html.postMessage).not.toHaveBeenCalled();
    expect(html.show).not.toHaveBeenCalled();
    expect(html.collapse).not.toHaveBeenCalled();
  });
});
