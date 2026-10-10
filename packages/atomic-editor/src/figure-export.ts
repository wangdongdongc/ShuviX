// Figure export hook for the ```svg and ```mermaid previews.
//
// The editor does not own an export UI — ShuviX's export panel is a React
// component that lives in the host (it is shared with the chat's figure
// cards). This file only paints a hover button on a rendered figure and hands
// the host what it needs to build the panel: which kind of fence, its source,
// the button to anchor to, and the cell holding the figure as it is on screen.
//
// No host config → no button. A vendored consumer that never wires export
// gets exactly the upstream widgets.

export type FigureExportKind = 'svg' | 'mermaid';

export interface FigureExportRequest {
  kind: FigureExportKind;
  /** The fence body, as written. */
  code: string;
  /** The button that was clicked — the panel aligns itself to it. */
  anchor: HTMLElement;
  /** The cell holding the rendered (already sanitized) <svg>. */
  figure: HTMLElement;
}

export interface FigureExportHandler {
  /** Accessible name / tooltip of the button (the host localizes it). */
  label: string;
  onExport: (request: FigureExportRequest) => void;
}

/**
 * Read at paint time, not at extension construction: the editor builds its
 * extensions once per document, while the host's handler (and its label,
 * after a language switch) may change without a remount.
 */
export interface FigureExportConfig {
  handler: () => FigureExportHandler | null;
}

// lucide "download", inlined — the editor has no icon dependency. Static
// markup we wrote ourselves; nothing from the document reaches it.
const DOWNLOAD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

/**
 * Add the export button to a rendered figure widget. `wrap` is the widget
 * root (positioned relative by the stylesheet); `figure` is the cell that
 * holds the <svg>. Returns nothing when the host has no handler.
 */
export function attachFigureExport(
  config: FigureExportConfig | undefined,
  kind: FigureExportKind,
  code: string,
  wrap: HTMLElement,
  figure: HTMLElement,
): void {
  const handler = config?.handler();
  if (!handler) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-atomic-figure-export';
  button.setAttribute('data-figure-export', kind);
  button.setAttribute('aria-label', handler.label);
  button.title = handler.label;
  button.innerHTML = DOWNLOAD_ICON;
  // The label was read at paint time; a widget that outlives a UI language
  // switch (widgets compare by source only) would keep the old one. Refresh
  // it whenever the button is about to be seen.
  const refreshLabel = (): void => {
    const label = config?.handler()?.label;
    if (label && label !== button.title) {
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  };
  wrap.addEventListener('mouseenter', refreshLabel);
  button.addEventListener('focus', refreshLabel);
  // The widget reveals its source on mousedown (fenced-preview's
  // revealOnClick, registered on the wrap). A press on the button must not
  // bubble there, or opening the panel would also turn the figure back
  // into raw markup under it.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Re-read: the handler may have been swapped since the button was painted.
    const current = config?.handler();
    current?.onExport({ kind, code, anchor: button, figure });
  });
  wrap.appendChild(button);
}
