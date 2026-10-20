// The poteto-mode marker: a potato before the working directory on the footer's first
// row, instead of a status row of its own. Pi has no API for decorating its footer, so
// this wraps FooterComponent's renderer the way the subagents package does.

/** Pi-tui's width helpers, passed in because p3stack carries no Pi SDK of its own. */
export interface Measure {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

/** Put `prefix` before the first row, keeping that row within `width`. */
export function prefixFooter(lines: string[], width: number, prefix: string, measure: Measure): string[] {
  if (!prefix || !lines.length || width < 1) return lines;
  let first = prefix + lines[0];
  const over = measure.visibleWidth(first) - width;
  if (over > 0) {
    // A right-aligned label (subagents') sits after a run of plain spaces: give up some
    // of that gap, keeping two, before cutting anything off the end.
    first = first.replace(new RegExp(` {${over + 2},}`), run => run.slice(over));
    if (measure.visibleWidth(first) > width) first = measure.truncateToWidth(first, width, "...");
  }
  return [first, ...lines.slice(1)];
}

type FooterRenderer = { render(width: number): string[] };

/**
 * Compatibility hook, NOT an official Pi extension API: wraps the exported class's
 * renderer so Pi's own footer keeps doing the work. Returns the uninstaller.
 */
export function installFooterPrefix(prototype: FooterRenderer, prefix: () => string, measure: Measure): () => void {
  const original = prototype.render;
  let active = true;
  function render(this: FooterRenderer, width: number) {
    const lines = original.call(this, width);
    if (!active) return lines;
    try { return prefixFooter(lines, width, prefix(), measure); }
    catch { return lines; } // Cosmetic failure must never break the stock footer.
  }
  prototype.render = render;
  return () => {
    active = false;
    // Don't overwrite another extension's later wrapper.
    if (prototype.render === render) prototype.render = original;
  };
}
