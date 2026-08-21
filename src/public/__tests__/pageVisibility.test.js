import { collapseHtmlSiblings } from '../pageVisibility.js';

// A backroom page embeds one HtmlComponent and has to hide every other one on
// the page. Getting the keep-set wrong hides the component the page is built
// around, so the page renders empty with nothing in the console.

function component(id) {
  return { id, collapse: jest.fn(), collapsed: false, hide: jest.fn() };
}
/** A $w that answers the type selector with the given components. */
function pageWith(components) {
  return jest.fn((selector) => {
    if (selector !== 'HtmlComponent') return null;
    return { forEach: (fn) => components.forEach(fn) };
  });
}

describe('collapsing the other HtmlComponents', () => {
  test('collapses and hides every component not kept', () => {
    const a = component('html1');
    const b = component('html2');
    collapseHtmlSiblings(pageWith([a, b]), ['#html1']);

    expect(a.collapse).not.toHaveBeenCalled();
    expect(a.hide).not.toHaveBeenCalled();
    expect(b.collapse).toHaveBeenCalled();
    expect(b.hide).toHaveBeenCalled();
  });

  test('the keep list is matched with the # prefix the page uses', () => {
    // Components report a bare id; the keep list is written as selectors. The
    // function adds the # before comparing, so callers pass '#html1'.
    const a = component('html1');
    collapseHtmlSiblings(pageWith([a]), ['#html1']);
    expect(a.collapse).not.toHaveBeenCalled();
  });

  test('a keep entry without the prefix does not match, and the component is hidden', () => {
    const a = component('html1');
    collapseHtmlSiblings(pageWith([a]), ['html1']);
    expect(a.collapse).toHaveBeenCalled();
  });

  test('whitespace around a keep entry is trimmed', () => {
    const a = component('html1');
    collapseHtmlSiblings(pageWith([a]), ['  #html1  ']);
    expect(a.collapse).not.toHaveBeenCalled();
  });

  test('blank keep entries are ignored rather than matching everything', () => {
    // The `.filter(Boolean)` on the keep list cannot actually change the answer:
    // every component id is compared with a `#` prefix, so a blank entry would
    // never match one anyway. Pinned as behaviour rather than as a claim about
    // which line enforces it.
    const a = component('html1');
    collapseHtmlSiblings(pageWith([a]), ['', '   ', null, undefined]);
    expect(a.collapse).toHaveBeenCalled();
  });

  test('with no keep list at all, everything is collapsed', () => {
    const a = component('html1');
    const b = component('html2');
    collapseHtmlSiblings(pageWith([a, b]));
    expect(a.collapse).toHaveBeenCalled();
    expect(b.collapse).toHaveBeenCalled();
  });

  test('a keep list that is not an array is treated as empty', () => {
    const a = component('html1');
    collapseHtmlSiblings(pageWith([a]), '#html1');
    expect(a.collapse).toHaveBeenCalled();
  });

  test('several components can be kept', () => {
    const a = component('html1');
    const b = component('html2');
    const c = component('html3');
    collapseHtmlSiblings(pageWith([a, b, c]), ['#html1', '#html3']);

    expect(a.collapse).not.toHaveBeenCalled();
    expect(b.collapse).toHaveBeenCalled();
    expect(c.collapse).not.toHaveBeenCalled();
  });
});

describe('when the page is not what it expects', () => {
  test('a component whose collapse throws is still hidden', () => {
    const a = component('html1');
    a.collapse = jest.fn(() => { throw new Error('not collapsible'); });
    expect(() => collapseHtmlSiblings(pageWith([a]), [])).not.toThrow();
    expect(a.hide).toHaveBeenCalled();
  });

  test('a component whose hide throws does not stop the ones after it', () => {
    const a = component('html1');
    a.hide = jest.fn(() => { throw new Error('not hideable'); });
    const b = component('html2');
    collapseHtmlSiblings(pageWith([a, b]), []);
    expect(b.collapse).toHaveBeenCalled();
  });

  test('a component with no id is collapsed rather than skipped', () => {
    // Note the `!id` guard in the source can never fire: the id is built as
    // `#${...}`, so it is at least '#' and always truthy. A component with no id
    // therefore falls through to being collapsed, which is what this asserts.
    const a = component(undefined);
    collapseHtmlSiblings(pageWith([a]), ['#html1']);
    expect(a.collapse).toHaveBeenCalled();
  });

  test('a $w that returns nothing for the type selector is a no-op', () => {
    expect(() => collapseHtmlSiblings(jest.fn(() => null), ['#html1'])).not.toThrow();
  });

  test('a selection with no forEach is a no-op', () => {
    expect(() => collapseHtmlSiblings(jest.fn(() => ({})), ['#html1'])).not.toThrow();
  });

  test('a $w that throws is a no-op rather than an error on page load', () => {
    const $w = jest.fn(() => { throw new Error('page not ready'); });
    expect(() => collapseHtmlSiblings($w, ['#html1'])).not.toThrow();
  });
});
