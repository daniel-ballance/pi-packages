import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Decorate, don't recreate, Pi's first footer row. Remaining rows are untouched. */
export function decorateFooter(lines: string[], width: number, label: string, dim: (text: string) => string): string[] {
  if (!label || lines.length < 2 || width < 1) return lines;
  const right = dim(truncateToWidth(label, width));
  const gap = width - visibleWidth(lines[0]) - visibleWidth(right);
  if (gap >= 2) return [lines[0] + " ".repeat(gap) + right, ...lines.slice(1)];
  // Never sacrifice the directory/branch or overlap it on narrow terminals.
  return [lines[0], " ".repeat(Math.max(0, width - visibleWidth(right))) + right, ...lines.slice(1)];
}

type FooterRenderer = { render(width: number): string[] };

/**
 * Compatibility hook, NOT an official Pi extension API. Wrapping the exported
 * class's renderer keeps the real session, settings, theme and accounting used
 * by Pi's existing footer instance. No fake AgentSession or copied renderer.
 *
 * Process-wide while installed; intended for Pi's single interactive UI. A
 * completely custom footer that doesn't use FooterComponent is not affected.
 */
export function installFooterDecoration(
  prototype: FooterRenderer,
  label: () => string,
  dim: (text: string) => string,
): () => void {
  const original = prototype.render;
  let active = true;
  function render(this: FooterRenderer, width: number) {
    const lines = original.call(this, width);
    if (!active) return lines;
    try { return decorateFooter(lines, width, label(), dim); }
    catch { return lines; } // Cosmetic failure must never break the stock footer.
  }
  prototype.render = render;
  return () => {
    active = false;
    // Don't overwrite another extension's later wrapper during shutdown.
    if (prototype.render === render) prototype.render = original;
  };
}
