import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtomicCodeMirrorEditor,
  wikiLinks,
  type AtomicCodeMirrorEditorHandle,
  type WikiLinkSuggestion,
} from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';
import '@atomic-editor/editor/styles.css';
import {
  SAMPLE_SIZES,
  generateSampleMarkdown,
  type SampleOptions,
  type SampleSize,
} from './sample-content';

type ThemeMode = 'dark' | 'light';

// Injected from package.json at build time via Vite `define` (see
// vite.config.ts), so the version pill can never drift from the real
// published version.
declare const __APP_VERSION__: string;
const VERSION = __APP_VERSION__;

const WIKI_TARGETS: WikiLinkSuggestion[] = [
  { target: 'demo-project-atlas', label: 'Project Atlas', detail: 'Project' },
  { target: 'demo-meeting-notes', label: 'Meeting Notes', detail: 'Recent' },
  { target: 'demo-editor-roadmap', label: 'Editor Roadmap', detail: 'Planning' },
  { target: 'demo-search-fallback', label: 'Search Fallback', detail: 'Content' },
];

const WIKI_SNIPPETS: Record<string, string> = {
  'demo-project-atlas': 'A project planning page used for labeled wiki-link rendering.',
  'demo-meeting-notes': 'Recent notes with a bare wiki-link target that resolves asynchronously.',
  'demo-editor-roadmap': 'A roadmap page for live preview, autocomplete, and deeplink behavior.',
  'demo-search-fallback': 'Fallback result for testing content-like matching in the demo.',
};

// Content feature toggles. Each maps to a `generateSampleMarkdown`
// option so visitors can isolate a feature (or stress a specific block
// type). All default on so first paint shows the full hero.
interface ContentToggles {
  images: boolean;
  tables: boolean;
  lists: boolean;
  code: boolean;
}

const DEFAULT_TOGGLES: ContentToggles = {
  images: true,
  tables: true,
  lists: true,
  code: true,
};

// Spotlight jump targets — each phrase is a literal string present in
// the generated hero, fed to the editor's `revealText()` so the button
// scrolls to and flashes that feature. Gated by the matching content
// toggle so we never offer a jump to a block that was switched off.
const SPOTLIGHTS: { label: string; phrase: string; needs?: keyof ContentToggles }[] = [
  { label: 'Code', phrase: 'Fenced code blocks pick up', needs: 'code' },
  { label: 'Tables', phrase: 'Tables render WYSIWYG', needs: 'tables' },
  { label: 'Checkboxes', phrase: 'Task lists are real checkboxes', needs: 'lists' },
  { label: 'Wiki links', phrase: 'Wiki links connect notes' },
  { label: 'Links', phrase: 'A link to' },
  { label: 'Escapes', phrase: 'Escapes like domain' },
];

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`;
}

function findWikiTarget(target: string): WikiLinkSuggestion | undefined {
  return WIKI_TARGETS.find((candidate) => candidate.target === target);
}

function suggestWikiTargets(query: string): Promise<WikiLinkSuggestion[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return Promise.resolve(WIKI_TARGETS);
  return Promise.resolve(
    WIKI_TARGETS.filter((target) => {
      const snippet = WIKI_SNIPPETS[target.target] ?? '';
      return (
        target.label.toLowerCase().includes(normalized) ||
        target.target.toLowerCase().includes(normalized) ||
        snippet.toLowerCase().includes(normalized)
      );
    }),
  );
}

function readLinkedTargetFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('linkedTarget');
}

function togglesToOptions(t: ContentToggles): SampleOptions {
  return {
    mode: t.images ? 'with images' : 'imageless',
    tables: t.tables ? 'with tables' : 'no tables',
    lists: t.lists ? 'with lists' : 'no lists',
    codeBlocks: t.code ? 'with code blocks' : 'no code blocks',
  };
}

export function App() {
  const [sampleSize, setSampleSize] = useState<SampleSize>('1 page');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [toggles, setToggles] = useState<ContentToggles>(DEFAULT_TOGGLES);
  const [showSource, setShowSource] = useState(false);
  const [liveMarkdown, setLiveMarkdown] = useState('');
  const [copied, setCopied] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  const [perf, setPerf] = useState<{ rendered: number; total: number }>({
    rendered: 0,
    total: 0,
  });
  const [openedWikiTarget, setOpenedWikiTarget] = useState<string | null>(() =>
    readLinkedTargetFromUrl(),
  );
  // Chrome is collapsed by default so the editor takes the whole stage;
  // the "Controls" disclosure reveals sample / content / actions / jump.
  const [controlsOpen, setControlsOpen] = useState(false);

  const editorRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const showSourceRef = useRef(showSource);
  showSourceRef.current = showSource;

  // Probe hook — `?reveal=…` triggers the editor's `initialRevealText`
  // path so the reveal behavior can be driven from the URL (also used
  // by the e2e harness).
  const revealText = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('reveal');
  }, []);

  // Identity for the mounted document. Any change here remounts the
  // editor (fresh cursor/undo). `resetNonce` lets "Reset" force a
  // remount back to the generated sample.
  const documentId = useMemo(
    () =>
      `${sampleSize}|${toggles.images}|${toggles.tables}|${toggles.lists}|${toggles.code}|${resetNonce}`,
    [sampleSize, toggles, resetNonce],
  );

  // Persistence key is independent of `resetNonce` so edits survive a
  // round-trip away and back, while Reset clears the key and remounts.
  const storageKey = useMemo(
    () =>
      `atomic-demo:${sampleSize}|${toggles.images}|${toggles.tables}|${toggles.lists}|${toggles.code}`,
    [sampleSize, toggles],
  );

  const markdownSource = useMemo(() => {
    const generated = generateSampleMarkdown(sampleSize, togglesToOptions(toggles));
    // Deep-link-to-reveal implies "show me this exact content," so start
    // from the canonical doc rather than a saved edit. (This also keeps
    // the e2e reveal probe deterministic.)
    if (revealText) return generated;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved != null) return saved;
    } catch {
      // localStorage unavailable (private mode / sandbox) — fall back.
    }
    return generated;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, sampleSize, toggles, revealText, resetNonce]);

  const documentBytes = useMemo(() => formatBytes(markdownSource.length), [markdownSource]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const handlePopState = () => setOpenedWikiTarget(readLinkedTargetFromUrl());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Virtualization readout: CM6 renders only the lines in (and near) the
  // viewport. Polling the rendered `.cm-line` count against the total
  // line count makes "we only render what you see" visible — pick a
  // large sample and watch the rendered count stay small.
  useEffect(() => {
    const id = window.setInterval(() => {
      const dom = editorRef.current?.getContentDOM();
      const rendered = dom ? dom.querySelectorAll('.cm-line').length : 0;
      const md = editorRef.current?.getMarkdown() ?? '';
      const total = md ? md.split('\n').length : 0;
      setPerf((prev) =>
        prev.rendered === rendered && prev.total === total ? prev : { rendered, total },
      );
    }, 600);
    return () => window.clearInterval(id);
  }, [documentId]);

  const handleMarkdownChange = useCallback(
    (md: string) => {
      try {
        window.localStorage.setItem(storageKey, md);
      } catch {
        // Ignore quota / unavailable storage — persistence is a nicety.
      }
      if (showSourceRef.current) setLiveMarkdown(md);
    },
    [storageKey],
  );

  const wikiLinkExtensions = useMemo(
    () => [
      wikiLinks({
        suggest: suggestWikiTargets,
        resolve: async (target) => {
          const linked = findWikiTarget(target);
          if (!linked) return null;
          return { target, label: linked.label, status: 'resolved' };
        },
        onOpen: (target) => {
          const url = new URL(window.location.href);
          url.searchParams.set('linkedTarget', target);
          window.history.pushState(null, '', url);
          setOpenedWikiTarget(target);
        },
        openOnClick: true,
      }),
    ],
    [],
  );

  const spotlight = useCallback((phrase: string) => {
    editorRef.current?.revealText(phrase);
  }, []);

  const toggleSource = useCallback(() => {
    setShowSource((prev) => {
      const next = !prev;
      showSourceRef.current = next;
      if (next) setLiveMarkdown(editorRef.current?.getMarkdown() ?? '');
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    const md = editorRef.current?.getMarkdown() ?? '';
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — silently no-op.
    }
  }, []);

  const resetDoc = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Ignore unavailable storage.
    }
    setResetNonce((n) => n + 1);
  }, [storageKey]);

  const setToggle = useCallback((key: keyof ContentToggles) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const openedWikiLabel = openedWikiTarget
    ? findWikiTarget(openedWikiTarget)?.label ?? openedWikiTarget
    : null;

  const spotlights = SPOTLIGHTS.filter((s) => !s.needs || toggles[s.needs]);

  return (
    <div className="demo-root" data-theme={theme}>
      <div className="demo-chrome">
        <div className="demo-topbar">
          <h1 className="demo-title">
            <span className="demo-mark-strong">Atomic</span>
            <span className="demo-mark-soft">Editor</span>
          </h1>
          <a
            className="demo-pill demo-pill-accent"
            href="https://www.npmjs.com/package/@atomic-editor/editor"
            target="_blank"
            rel="noopener noreferrer"
          >
            v{VERSION}
          </a>

          <div className="demo-topbar-actions">
            <button
              type="button"
              className="demo-icon-btn"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label="Toggle colour theme"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              className={`demo-btn demo-disclosure${controlsOpen ? ' active' : ''}`}
              onClick={() => setControlsOpen((o) => !o)}
              aria-expanded={controlsOpen}
            >
              Controls <span className="demo-caret">{controlsOpen ? '▾' : '▸'}</span>
            </button>
            <a
              className="demo-github"
              href="https://github.com/kenforthewin/atomic-editor"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub →
            </a>
          </div>
        </div>

        {controlsOpen && (
          <div className="demo-controls-panel">
            <p className="demo-sub">
              CodeMirror 6 markdown editor with Obsidian-style inline live preview.
              Edit anything below — it stays real markdown.
            </p>

            <div className="demo-toolbar">
              <div className="demo-control">
                <span className="demo-control-label">Sample</span>
                <SegmentedControl
                  value={sampleSize}
                  options={SAMPLE_SIZES.map((s) => ({ value: s, label: s }))}
                  onChange={setSampleSize}
                />
                <span className="demo-meta">{documentBytes}</span>
              </div>

              <div className="demo-control">
                <span className="demo-control-label">Content</span>
                <div className="demo-chip-group">
                  <ToggleChip label="Images" on={toggles.images} onClick={() => setToggle('images')} />
                  <ToggleChip label="Tables" on={toggles.tables} onClick={() => setToggle('tables')} />
                  <ToggleChip label="Lists" on={toggles.lists} onClick={() => setToggle('lists')} />
                  <ToggleChip label="Code" on={toggles.code} onClick={() => setToggle('code')} />
                </div>
              </div>

              <div className="demo-actions">
                <button
                  type="button"
                  className={`demo-btn${showSource ? ' active' : ''}`}
                  onClick={toggleSource}
                >
                  {showSource ? 'Hide source' : 'Show source'}
                </button>
                <button type="button" className="demo-btn" onClick={handleCopy}>
                  {copied ? 'Copied ✓' : 'Copy markdown'}
                </button>
                <button type="button" className="demo-btn" onClick={resetDoc} title="Discard edits and reload the sample">
                  Reset
                </button>
                <span
                  className="demo-perf"
                  title="CodeMirror 6 only renders the lines in (and near) the viewport — pick a big sample and watch this stay small."
                >
                  {perf.rendered} / {perf.total} lines rendered
                </span>
              </div>
            </div>

            <div className="demo-spotlight">
              <span className="demo-control-label">Jump to</span>
              {spotlights.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="demo-chip"
                  onClick={() => spotlight(s.phrase)}
                >
                  {s.label}
                </button>
              ))}
              <span className="demo-spotlight-hint">
                {openedWikiLabel
                  ? `opened: ${openedWikiLabel} (${openedWikiTarget})`
                  : 'Cmd/Ctrl-click a wiki link to open it'}
              </span>
            </div>
          </div>
        )}
      </div>

      <main className="demo-canvas">
        <div className="demo-editor-pane">
          <AtomicCodeMirrorEditor
            markdownSource={markdownSource}
            documentId={documentId}
            codeLanguages={ATOMIC_CODE_LANGUAGES}
            initialRevealText={revealText}
            editorHandleRef={editorRef}
            onMarkdownChange={handleMarkdownChange}
            onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
            extensions={wikiLinkExtensions}
          />
        </div>
        {showSource && (
          <aside className="demo-source-pane">
            <div className="demo-source-head">Raw markdown — the source of truth</div>
            <SourceView markdown={liveMarkdown} />
          </aside>
        )}
      </main>
    </div>
  );
}

// Line-numbered raw-markdown view. Caps the numbered render so toggling
// source on a 1000-page sample doesn't spawn 100k DOM nodes — past the
// cap it falls back to a plain scrollable block.
const SOURCE_LINE_CAP = 4000;

function SourceView({ markdown }: { markdown: string }) {
  const lines = useMemo(() => markdown.split('\n'), [markdown]);
  if (lines.length > SOURCE_LINE_CAP) {
    return (
      <pre className="demo-source demo-source-plain">
        <code>{markdown}</code>
      </pre>
    );
  }
  return (
    <div className="demo-source">
      {lines.map((line, i) => (
        <div className="demo-source-line" key={i}>
          <span className="demo-source-ln">{i + 1}</span>
          <span className="demo-source-text">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function ToggleChip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`demo-chip demo-chip-toggle${on ? ' active' : ''}`}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="demo-segmented">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
