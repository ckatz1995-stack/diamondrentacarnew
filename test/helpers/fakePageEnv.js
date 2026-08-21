// A stand-in for the Velo page runtime, so a page controller can be loaded and
// driven in a test.
//
// A controller is a top-level script: it calls `$w.onReady(...)` as a side
// effect of being imported, and reaches components through the `$w` global. So a
// test has to install the global first, import the module, then run the ready
// callback by hand and wait for it — which is what `start()` does.

/**
 * One page component. Covers the surface the controllers actually use: the
 * message and click handlers, the show/hide/collapse/expand quartet, and
 * postMessage. Everything else is a plain settable property, which is how the
 * controllers set `height`, `text` and `src`.
 */
export function createComponent(selector, overrides = {}) {
  const handlers = { message: [], click: [], change: [] };
  const component = {
    // Velo components report a bare id; the leading '#' belongs to the selector
    // and is re-added by callers that compare the two. Storing the selector here
    // would make a page's own component look like a stranger to any code that
    // does that — collapseHtmlSiblings, for one.
    id: String(selector || '').replace(/^#/, ''),
    selector: String(selector || ''),
    type: 'HtmlComponent',
    posted: [],
    shown: 0,
    hidden: 0,
    expanded: 0,
    collapsed: 0,
    onMessage(fn) { handlers.message.push(fn); return component; },
    onClick(fn) { handlers.click.push(fn); return component; },
    onChange(fn) { handlers.change.push(fn); return component; },
    show() { component.shown += 1; return component; },
    hide() { component.hidden += 1; return component; },
    expand() { component.expanded += 1; return component; },
    collapse() { component.collapsed += 1; return component; },
    postMessage(payload) { component.posted.push(payload); },
    /** Delivers an inbound message as the embedded page would. */
    async emitMessage(event) {
      for (const fn of handlers.message) await fn(event);
    },
    async emitClick(event) {
      for (const fn of handlers.click) await fn(event);
    },
    /** Every payload posted so far, with JSON strings parsed back. */
    postedMessages() {
      return component.posted.map((p) => {
        if (typeof p !== 'string') return p;
        try { return JSON.parse(p); } catch (_) { return p; }
      });
    },
    postedOfType(type) {
      return component.postedMessages().filter((p) => p && p.type === type);
    },
    ...overrides,
  };
  return component;
}

/**
 * Installs a `$w` global backed by the given components, keyed by selector
 * ('#bookingsHtml'). Selecting by type ('HtmlComponent') returns a forEach-able
 * selection, which is what resolveHtmlComponent and collapseHtmlSiblings use.
 */
export function installPageEnv(components = {}) {
  const byId = new Map(Object.entries(components));
  const readyCallbacks = [];

  const $w = (selector) => {
    const key = String(selector || '');
    if (byId.has(key)) return byId.get(key);
    if (key === 'HtmlComponent') {
      const items = Array.from(byId.values()).filter((c) => c.type === 'HtmlComponent');
      return { forEach: (fn) => items.forEach(fn), length: items.length };
    }
    return null;
  };
  $w.onReady = (fn) => { readyCallbacks.push(fn); };

  const previous = global.$w;
  global.$w = $w;

  // masterPage listens on `window` rather than on a component. The node test
  // environment has no window, so one is provided with just the listener
  // surface, and `emitWindowMessage` delivers an event to it.
  const windowListeners = { message: [] };
  const previousWindow = global.window;
  global.window = {
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn);
    },
  };

  return {
    $w,
    async emitWindowMessage(event) {
      for (const fn of (windowListeners.message || [])) await fn(event);
    },
    windowListenerCount: () => (windowListeners.message || []).length,
    component: (id) => byId.get(id),
    /**
     * Imports the controller and runs its ready callback.
     *
     * Deliberately does NOT call jest.resetModules(): a page controller holds
     * module-level state, so each test needs a fresh copy of it — but resetting
     * here would give the controller a different `wix-location`, `wix-storage`
     * and `wix-data` than the test is holding, and nothing the test set up would
     * be visible to it. The caller resets first and then imports *everything*
     * dynamically, so the controller and the test share one generation.
     */
    async start(importer) {
      await importer();
      if (!readyCallbacks.length) throw new Error('fakePageEnv: the module registered no $w.onReady callback');
      for (const fn of readyCallbacks) await fn();
    },
    restore() {
      if (previous === undefined) delete global.$w;
      else global.$w = previous;
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    },
  };
}
