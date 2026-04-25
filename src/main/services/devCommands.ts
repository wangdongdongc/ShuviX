/**
 * 内置斜杠命令 —— 3 条 dev 工具伴生命令（/widget /presentation /sketch）
 *
 *   /widget       → kind=widget      （持久化迷你工具，Widget tab 管理）
 *   /presentation → kind=presentation（Spectacle 幻灯片，会话级）
 *   /sketch       → kind=sketch      （空白 React 画布，会话级）
 *
 * 所有运行时逻辑（打包、dev server、库管理）由 dev 工具 + widgetServer + services/bundler 完成。
 */

import { t } from '../i18n'
import type { SlashCommand } from '../../shared/types/slashCommand'

const REQUIRED_TOOLS = ['dev', 'read', 'write', 'edit', 'browser']

/** 内置斜杠命令列表（现算，确保 i18n 切换后名称/描述同步更新） */
export function getBuiltinCommands(): SlashCommand[] {
  return [
    {
      commandId: 'widget',
      name: t('command.widget.name'),
      description: t('command.widget.description'),
      template: WIDGET_COMMAND_TEMPLATE,
      filePath: '(builtin)',
      requiredTools: REQUIRED_TOOLS
    },
    {
      commandId: 'presentation',
      name: t('command.presentation.name'),
      description: t('command.presentation.description'),
      template: PRESENTATION_COMMAND_TEMPLATE,
      filePath: '(builtin)',
      requiredTools: REQUIRED_TOOLS
    },
    {
      commandId: 'sketch',
      name: t('command.sketch.name'),
      description: t('command.sketch.description'),
      template: SKETCH_COMMAND_TEMPLATE,
      filePath: '(builtin)',
      requiredTools: REQUIRED_TOOLS
    }
  ]
}

// ──────────────────────────── /widget ────────────────────────────

const WIDGET_COMMAND_TEMPLATE = `You are now in Widget development mode. A **Widget** is a persistent mini web app the user can invoke any time from the right panel's Widget tab.

## What the user wants
The user will describe a small utility they want — e.g. "JSON formatter", "CEL expression validator", "unit converter", "regex tester". Scaffold, implement, and preview it.

## Workflow

1. **Choose an id.** Propose a kebab-case slug with at least one dash, matching \`/^[a-z0-9]+(-[a-z0-9]+)+$/\`. Examples: \`json-formatter\`, \`cel-validator\`, \`regex-tester\`. Short and descriptive.
2. **Call the \`dev\` tool** with \`action: "init"\`, \`kind: "widget"\`, the id, a Title-Case \`name\`, and a one-sentence \`description\`. The tool returns \`projectDir\` and \`url\`.
3. **Implement.** Use \`write\` / \`edit\` on files under \`projectDir\`. Entry is \`index.tsx\`. The widget dir is auto-granted sandbox access.
4. **Rebuild.** Call \`dev\` with \`action: "build"\`, \`kind: "widget"\`, and the same \`id\`. On failure you get esbuild errors — fix and retry.
5. **Open.** Call the \`browser\` tool with \`action: "open"\` and the url. Subsequent rebuilds live-reload via SSE.
6. **Update README.md** — describe what the widget does, its main interactions, and extension points. The *next* AI that maintains it will read this file.

## Maintaining existing widgets
If the user names an existing widget id, **skip init**. Instead:
1. \`read ~/.shuvix/widgets/<id>/README.md\` to understand purpose + design intent.
2. \`read\` the relevant source files.
3. Make edits via \`edit\` / \`write\`.
4. \`dev\` \`action: "build"\` \`kind: "widget"\` with the id — browser panel auto-refreshes.
5. Append a short entry to README.md's "扩展记录" section.

## Technical stack
- React + TypeScript, function components with Hooks
- Tailwind CSS v4 (class names via \`className\`; \`dark:\` variant auto-follows ShuviX's theme via \`prefers-color-scheme\`)
- Available packages: React, ReactDOM, React Router, Spectacle. **No other npm packages** — no axios, no lodash, no date-fns, no icon libraries (use inline SVG).
- For multi-page widgets use \`createHashRouter\` from \`react-router\`.
- Keep state local (React state / \`localStorage\`). Widgets don't share state with chat.

---

## ⚠️ DESIGN GUIDE — follow this strictly

Widgets are **dense, single-purpose utilities**, NOT landing pages or marketing sites. Mental model: menu-bar app, browser extension popup, VSCode sidebar view.

### Layout
- **No hero sections.** No big welcome title, no "Get Started" button, no emoji at \`h1\` size. Get straight to the task.
- **Fill the viewport.** The user opens the widget to *use* it — make the working area the main content. No empty space below a small card.
- **Use width.** Content max-width ~\`max-w-3xl\`, \`mx-auto\`, with \`p-3\` or \`p-4\` padding. NOT \`max-w-sm mx-auto flex items-center justify-center min-h-screen\`.
- **Vertical stacking** for narrow panels; use \`grid\` / \`flex-row\` only when the data warrants columns.

### Typography
- Body: \`text-xs\` (12px) or \`text-sm\` (14px). **Never** use anything larger than \`text-base\` (16px) for headings.
- Weight: \`font-medium\` / \`font-semibold\`. Avoid \`font-bold\` in body text.
- Code/data/tokens: \`font-mono text-xs\`.

### Spacing (tight)
- Padding: \`p-2.5\`, \`p-3\`, \`p-4\`. Avoid \`p-6\` / \`p-8\`.
- Gap: \`gap-1.5\`, \`gap-2\`, \`gap-3\`. Avoid \`gap-8\`.
- Margin: \`mt-1\`, \`mt-2\`, \`mt-4\`. Avoid \`my-12\`.

### ⚠️ Dark mode is MANDATORY
Every color utility MUST have a \`dark:\` variant. Widgets auto-follow ShuviX's theme.

**Required palette (copy-paste these, don't invent):**

| Purpose | Light | Dark |
|---|---|---|
| Page bg | \`bg-white\` | \`dark:bg-neutral-950\` |
| Surface / card bg | \`bg-neutral-50\` | \`dark:bg-neutral-900\` |
| Hover bg | \`hover:bg-neutral-100\` | \`dark:hover:bg-neutral-800\` |
| Border | \`border-neutral-200\` | \`dark:border-neutral-800\` |
| Text primary | \`text-neutral-900\` | \`dark:text-neutral-100\` |
| Text secondary | \`text-neutral-600\` | \`dark:text-neutral-400\` |
| Text tertiary / muted | \`text-neutral-400\` | \`dark:text-neutral-500\` |
| Accent text | \`text-violet-600\` | \`dark:text-violet-400\` |
| Accent solid btn | \`bg-violet-600 hover:bg-violet-500 text-white\` | same |
| Accent ring | \`ring-violet-500/30\` \`focus:border-violet-500\` | same |
| Success | \`text-emerald-600\` | \`dark:text-emerald-400\` |
| Error | \`text-rose-600\` | \`dark:text-rose-400\` |
| Warning | \`text-amber-600\` | \`dark:text-amber-400\` |

### Decoration
- Rounded: \`rounded-md\` (6px) or \`rounded-lg\` (8px). **Never** \`rounded-2xl\` / \`rounded-3xl\` except for pill badges or avatars.
- Shadows: **none by default.** Only \`shadow-sm\` on floating popovers / dropdowns. **Never** \`shadow-lg\` / \`shadow-xl\`.
- Transitions: \`transition-colors\` on interactive elements. No complex motion.

### Interaction patterns
- **Keyboard first.** Enter runs/submits. Escape clears. \`Cmd/Ctrl+Enter\` for secondary if natural.
- **Live compute.** Use \`useMemo\` / \`useDeferredValue\` to update result as the user types. Don't add artificial loading spinners for local work.
- **Copy button** on any generated output (icon-only, top-right of the output block).
- **Inline errors** under the relevant field (small, rose-600/dark:rose-400). Not modals.
- **Monospace** for inputs expecting code/data/JSON: \`font-mono text-xs\`.

### Component patterns (use these shapes)

Input:
\`\`\`tsx
<input
  className="w-full px-2.5 py-1.5 text-sm rounded-md border
             border-neutral-200 dark:border-neutral-800
             bg-neutral-50 dark:bg-neutral-900
             text-neutral-900 dark:text-neutral-100
             placeholder:text-neutral-400 dark:placeholder:text-neutral-600
             focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
/>
\`\`\`

Textarea (for code/JSON):
\`\`\`tsx
<textarea
  className="w-full px-2.5 py-2 font-mono text-xs rounded-md border
             border-neutral-200 dark:border-neutral-800
             bg-neutral-50 dark:bg-neutral-900
             focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500
             resize-none"
  rows={8}
/>
\`\`\`

Primary button:
\`\`\`tsx
<button className="px-3 py-1.5 text-xs font-medium rounded-md
                   bg-violet-600 hover:bg-violet-500 text-white
                   transition-colors">
  Run
</button>
\`\`\`

Secondary / ghost button:
\`\`\`tsx
<button className="px-3 py-1.5 text-xs font-medium rounded-md
                   border border-neutral-200 dark:border-neutral-800
                   text-neutral-700 dark:text-neutral-300
                   hover:bg-neutral-100 dark:hover:bg-neutral-800
                   transition-colors">
  Clear
</button>
\`\`\`

Card / result panel:
\`\`\`tsx
<div className="rounded-md border border-neutral-200 dark:border-neutral-800
                bg-white dark:bg-neutral-950 p-3">
  …
</div>
\`\`\`

Code / output block:
\`\`\`tsx
<pre className="font-mono text-xs text-neutral-700 dark:text-neutral-300
                bg-neutral-50 dark:bg-neutral-900 rounded-md p-3
                overflow-auto max-h-80">{result}</pre>
\`\`\`

Badge / tag:
\`\`\`tsx
<span className="px-1.5 py-0.5 rounded text-[10px] font-medium
                 bg-violet-500/10 text-violet-600 dark:text-violet-400">
  parsed
</span>
\`\`\`

### ❌ Anti-patterns — DO NOT produce
- Large hero banner with centered title on empty page
- "Welcome to X" / "Get Started" screens / onboarding steps
- Emoji at heading size (🎉, 🚀, ✨ as 2xl)
- \`flex items-center justify-center min-h-screen\` with a narrow \`max-w-sm\` card
- Heavy shadows (\`shadow-xl\`, \`shadow-2xl\`), thick borders (\`border-2\`)
- Decorative gradients (\`bg-gradient-to-br from-purple-500\`)
- Card-inside-card-inside-card nesting
- Loading spinners for operations finishing in < 200ms
- Hardcoded single-mode palette (e.g. only \`bg-slate-900 text-slate-100\` without light counterpart)
- Any \`import\` from packages other than react, react-dom, react-router, spectacle

---

$ARGUMENTS`

// ──────────────────────────── /presentation ────────────────────────────

const PRESENTATION_COMMAND_TEMPLATE = `You are now in Presentation mode. Build a slide deck using **Spectacle**, scaffolded in the current project's \`.shuvix/design/\` directory.

## Workflow

1. Call the \`dev\` tool with \`action: "init"\`, \`kind: "presentation"\`. (No id/name needed — one deck per session.)
2. Use \`write\` / \`edit\` tools to author slides under \`<projectDir>/.shuvix/design/\` (entry is \`index.tsx\`; typically edit \`App.tsx\`).
3. Call \`dev\` with \`action: "build"\`, \`kind: "presentation"\` — returns the dev-server URL.
4. Call the \`browser\` tool with \`action: "open"\` and the URL.
5. If the build fails, fix the errors and call \`dev\` build again. Subsequent builds live-reload via SSE — no need to reopen the browser panel.

## Spectacle Component Reference

Spectacle is a React component library for slide decks. All components are imported from \`spectacle\`.

### CRITICAL: Valid Props

Spectacle components accept ONLY these prop names. Do NOT use shorthand props from other libraries (Chakra UI, MUI, styled-system, etc.).

**Common props for all typography & layout components:**
- \`margin\`: CSS margin string, e.g. \`"0px"\`, \`"0 0 24px 0"\`, \`"16px 0"\`. NOT \`m\`, \`mt\`, \`mb\`, \`mx\`, \`my\`.
- \`padding\`: CSS padding string, e.g. \`"24px"\`, \`"16px 24px"\`. NOT \`p\`, \`pt\`, \`pb\`, \`px\`, \`py\`.
- \`color\`: Theme color key (\`"primary"\`, \`"secondary"\`, \`"tertiary"\`) or CSS color string.
- \`backgroundColor\`: CSS color string or theme key.
- \`fontSize\`: \`"h1"\`, \`"h2"\`, \`"h3"\` or number (px).
- \`fontWeight\`: CSS font-weight. Use via \`style\` prop on Text/Heading.

**NEVER use these props** (they will cause blank/broken slides):
- \`sx\`, \`as\`, \`px\`, \`py\`, \`pt\`, \`pb\`, \`pl\`, \`pr\`, \`mt\`, \`mb\`, \`ml\`, \`mr\`, \`mx\`, \`my\`, \`p\`, \`m\`
- \`fontWeight\` directly on Text/Heading (use \`style={{ fontWeight: 700 }}\` instead)

For custom CSS properties not covered by Spectacle's props, use \`style={{ ... }}\`:
\`\`\`tsx
<Box padding="24px" style={{ borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
\`\`\`

### Core Structure
- **Deck**: Root wrapper. Props: \`theme\`, \`template\` (e.g. \`<DefaultTemplate />\`).
- **Slide**: Single slide. Props: \`backgroundColor\`, \`backgroundImage\`, \`transition\`.
- **DefaultTemplate**: Provides slide number and progress indicator.

### Typography
- **Heading**: Props: \`fontSize\`, \`color\`, \`margin\`.
- **Text**: Props: \`fontSize\`, \`color\`, \`margin\`.
- **Quote / Link / CodeSpan / FitText**: Inline typography variants.

### Layout
- **FlexBox**: Props: \`flexDirection\`, \`justifyContent\`, \`alignItems\`, \`height\`, \`width\`, \`gap\`, \`padding\`, \`margin\`.
- **Grid**: Props: \`gridTemplateColumns\`, \`gridTemplateRows\`, \`gridGap\`.
- **Box**: Props: \`backgroundColor\`, \`padding\`, \`margin\`, \`height\`, \`width\`. Use \`style={{ ... }}\` for custom CSS.

### Lists & Tables
- **UnorderedList / OrderedList / ListItem**
- **Table / TableHeader / TableBody / TableRow / TableCell**

### Animation
- **Appear**: Wrap each element that should appear on advance.
\`\`\`tsx
<UnorderedList>
  <Appear><ListItem>Point 1</ListItem></Appear>
  <Appear><ListItem>Point 2</ListItem></Appear>
</UnorderedList>
\`\`\`

### Code & Markdown
- **CodePane**: \`language\`, \`highlightRanges\`.
- **MarkdownSlide / MarkdownSlideSet**: Slides from Markdown (set: separate with \`---\`).

### Other
- **Notes**: Speaker notes (last child of Slide, only visible in presenter mode).
- **Image**: \`src\`, \`width\`, \`height\`.

### Theme & Transitions
\`\`\`tsx
import { Deck, DefaultTemplate, fadeTransition, slideTransition } from 'spectacle'

const theme = {
  colors: { primary: '#1e293b', secondary: '#6366f1', tertiary: '#f8fafc' },
  fonts: { header: '"Inter", sans-serif', text: '"Inter", sans-serif' }
}

<Deck theme={theme} template={<DefaultTemplate />}>
  <Slide transition={fadeTransition}>
    <Heading fontSize="h1" margin="0px">Title</Heading>
  </Slide>
</Deck>
\`\`\`

### Complete Two-Column Slide Example
\`\`\`tsx
<Slide>
  <Heading fontSize="h2" margin="0 0 24px 0">Comparison</Heading>
  <Grid gridTemplateColumns="1fr 1fr" gridGap={24}>
    <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
      <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option A</Heading>
      <Text fontSize={20} margin="0px">Description here.</Text>
    </Box>
    <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
      <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option B</Heading>
      <Text fontSize={20} margin="0px">Description here.</Text>
    </Box>
  </Grid>
</Slide>
\`\`\`

## Technical Stack
- React + TypeScript, function components with Hooks
- Spectacle (from \`spectacle\`) for the deck itself
- Tailwind CSS v4 is available but ONLY for custom wrapper elements (div, span), NOT on Spectacle components
- Available packages: React, ReactDOM, Spectacle, Tailwind CSS. No other npm packages.

## Conventions
- All slide content in \`App.tsx\` or split into slide files under \`components/\`.
- Use ONLY Spectacle's documented props — when in doubt, use \`style={{ ... }}\`.
- Use full CSS strings for \`margin\` / \`padding\`, NEVER shorthand like \`mt\`, \`px\`, \`p\`.

$ARGUMENTS`

// ──────────────────────────── /sketch ────────────────────────────

const SKETCH_COMMAND_TEMPLATE = `You are now in Sketch mode —— an **open React canvas** scaffolded in the current project's \`.shuvix/design/\` directory. Unlike \`/widget\` (persistent, strict design guide) and \`/presentation\` (Spectacle deck), Sketch gives you freedom to build whatever fits the user's ask.

## Workflow

1. Call \`dev\` with \`action: "init"\`, \`kind: "sketch"\`. This scaffolds a blank React app at \`<projectDir>/.shuvix/design/\`.
2. Write the app using \`write\` / \`edit\` (entry is \`index.tsx\`; create any components you need).
3. Call \`dev\` with \`action: "build"\`, \`kind: "sketch"\`. Returns the dev-server URL.
4. Call the \`browser\` tool \`action: "open"\` with the URL. Further builds live-reload via SSE.

## Available resources (nothing else is bundled)
- **React 19** (function components, Hooks)
- **Tailwind CSS v4** — use utilities directly in \`className\`; the \`dark:\` variant auto-follows ShuviX's current theme
- **React Router** — \`createHashRouter\` from \`react-router\` for multi-page
- **Spectacle** — available if the user explicitly wants a deck, otherwise don't import
- **No other npm packages.** No axios, lodash, date-fns, icon libraries, chart libraries — if you need an icon, use inline SVG; if you need HTTP, use \`fetch\`.

## Baseline quality expectations (soft — adapt to the ask)
- **Dark mode works** — pair every color class with a \`dark:\` variant (\`bg-white dark:bg-neutral-950\`, \`text-neutral-900 dark:text-neutral-100\`, etc.). The app runs inside ShuviX and follows its theme.
- **Reasonable typography** — prefer \`text-sm\`/\`text-base\` for body, don't use \`text-5xl\` unless the user asks for a hero.
- **Responsive width** — use \`max-w-*\` + \`mx-auto\` + sensible padding; fill the viewport meaningfully.
- **Clear errors** — wrap risky parsers in try/catch and surface errors inline (not as alerts).
- **No decorative noise** — avoid marketing gradients, heavy shadows, huge emoji headers UNLESS the user is building a landing-style page.

## When to pick what
- Focused small tool that the user will reuse → suggest they use \`/widget\` instead (which manages it as a library entry).
- Slide deck / talk → suggest \`/presentation\`.
- Everything else (mockups, multi-page demos, drafts, experiments, quick data visualizations, any app style that doesn't fit the other two) → stay in Sketch.

$ARGUMENTS`
