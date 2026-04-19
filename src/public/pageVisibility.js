export function collapseHtmlSiblings($w, keepIds = []) {
  const keep = new Set((Array.isArray(keepIds) ? keepIds : []).map((id) => String(id || '').trim()).filter(Boolean));
  try {
    const selection = $w('HtmlComponent');
    if (!selection || typeof selection.forEach !== 'function') return;
    selection.forEach((component) => {
      try {
        const id = `#${String(component?.id || '').trim()}`;
        if (!id || keep.has(id)) return;
        try { component.collapse(); } catch (_) {}
        try { component.hide(); } catch (_) {}
      } catch (_) {}
    });
  } catch (_) {}
}
