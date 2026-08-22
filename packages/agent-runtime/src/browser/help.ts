/**
 * browser 工具的完整手册（action:"help"）—— 按端 caps 过滤，唯一真源。
 *
 * schema/description 只给每个 action 一行（tool.ts）；长尾细节（工作流、uid 生命周期、
 * 组合键表、troubleshooting）全部在这里，agent 需要时一次 help 调用拉全。
 */
import type { BrowserCaps } from './backend'
import { opsForCaps } from './ops'
import { KEY_DEFS } from './keyboard'

export const HELP_TOPICS = [
  'workflow',
  'interaction',
  'navigation',
  'capture',
  'debugging',
  'devtools'
] as const
export type HelpTopic = (typeof HELP_TOPICS)[number]

/** 某端可用的 help topic（devtools 节只在支持 rawCdp 时存在） */
export function helpTopicsForCaps(caps: BrowserCaps): readonly HelpTopic[] {
  return HELP_TOPICS.filter((t) => t !== 'devtools' || caps.rawCdp)
}

function workflowSection(caps: BrowserCaps): string {
  return `## Workflow

Iron rules:
1. ALWAYS take a snapshot before click/fill/type — uids only come from (and are only valid for) the LATEST snapshot of that tab.
2. After navigate, or after a click that changes the page, snapshot again before further interaction.
3. Every action except help/list_tabs/open_tab needs a tabId (from list_tabs or open_tab).

Typical flow:
1. browser(action:"open_tab", url:"https://example.com")   → returns tabId
2. browser(action:"snapshot", tabId)                        → elements with uids
3. browser(action:"click", tabId, uid:"e7")
4. browser(action:"wait_for", tabId, text:"Welcome")
5. browser(action:"screenshot", tabId)${caps.pdf ? '\n6. browser(action:"pdf", tabId, outputPath:"page.pdf")   — export when asked for a PDF' : ''}

If a page is slow, use wait_for instead of guessing; if an element is off-screen, scroll then re-snapshot.`
}

function interactionSection(): string {
  const keys = Object.keys(KEY_DEFS)
    .filter((k) => k !== ' ')
    .join(', ')
  return `## Interaction

- snapshot(tabId) — accessibility tree; each interactive element gets a uid. Re-run whenever the page changes; old uids go stale.
- click(tabId, uid) — trusted mouse click at the element center.
- fill(tabId, uid, text) — REPLACES the current value of an input/textarea (clears first, fires input/change). Use for form fields.
- type(tabId, text[, uid][, submitKey]) — types into the focused element without clearing; pass uid to focus first, submitKey (e.g. "Enter") to submit after. Use for editors/search boxes where fill's clearing is wrong.
- press_key(tabId, key) — single key or combo. Named keys: ${keys}. Combos join with "+": "Control+A", "Meta+Shift+R". Single characters allowed ("a").
- scroll(tabId[, direction][, amount][, uid]) — scrolls the window, or the element when uid is given. Default down 500px.
- <select> dropdowns: click/fill/type do NOT work on them — set the value directly and fire change (see the "Select a dropdown option" recipe under help(topic:"devtools")).`
}

function navigationSection(): string {
  return `## Navigation & tabs

- list_tabs() — tabIds with title/URL. Start here when working with existing pages.
- open_tab(url) — open a NEW tab, returns its tabId. The right way to open a page.
- navigate(tabId, url) — replace the content of an EXISTING tab (or nav:"back"|"forward"|"reload"). All uids become invalid.
- close_tab(tabId) — close a tab when done with it.
- open_tab/navigate accept any URL, including file:// — do NOT open a file:// path the user has not asked for.`
}

function captureSection(caps: BrowserCaps): string {
  const screenshotExtras = [
    caps.fullPageScreenshot ? 'fullPage:true captures beyond the viewport' : '',
    caps.elementScreenshot ? 'uid:"e7" captures a single element (wins over fullPage)' : ''
  ]
    .filter(Boolean)
    .join('; ')
  const screenshotOutput = caps.screenshotToFile
    ? ' Saved as a PNG file; the path is returned — use the read tool to view it.'
    : ' The image is returned inline.'
  return `## Capture & reading

- read_page(tabId) — rendered DOM (after JavaScript) converted to Markdown. Best for reading content, works on authenticated pages/SPAs. Truncated at 200k chars.
- screenshot(tabId) — visual inspection.${screenshotExtras ? ` ${screenshotExtras}.` : ''}${screenshotOutput}${
    caps.pdf
      ? `
- pdf(tabId, outputPath[, pageSize][, landscape][, scale]) — export the page as PDF. outputPath must be inside the session sandbox; relative paths resolve against the workspace.`
      : ''
  }`
}

function debuggingSection(caps: BrowserCaps): string {
  const lines = [
    caps.evaluate
      ? '- evaluate(tabId, expression) — run a JS expression in the page, returns its JSON value (awaits promises). Example: evaluate(tabId, "document.title").'
      : '',
    '- wait_for(tabId, text[, timeout]) — poll until the text appears in the page body; use after navigation or slow loads.',
    caps.network
      ? '- network(tabId) — HTTP requests captured since capture started (first call enables capture; navigate/reload then call again).'
      : '',
    caps.console
      ? '- console(tabId) — console messages/errors captured since capture started (same enable-on-first-call behavior).'
      : ''
  ].filter(Boolean)
  return `## Debugging\n\n${lines.join('\n')}`
}

/**
 * devtools 逃生口手册：不复述 CDP 协议（模型已懂），只讲本工具的约定 + 高价值配方。
 * 仅在端支持 rawCdp 时出现在全量手册里。
 */
function devtoolsSection(): string {
  return `## DevTools escape hatch (cdp / events)

The semantic actions above cover common flows. For anything else, drive the raw Chrome DevTools Protocol:
  cdp(tabId, method:"Domain.method"[, params])   — send one CDP command
  events(tabId[, event][, sinceSeq][, limit])    — pull buffered events (see below)

Conventions (this tool adds these on top of raw CDP):
- **Safety**: methods in known domains run directly; out-of-scope domains and methods (Browser/Target/Tracing/Page.close/Security.setIgnoreCertificateErrors) are blocked. Careful with Fetch.enable — interception pauses all matching requests until you explicitly continue them.
- **uid macros**: anywhere in params you may write {"$uid":"e7"} → the element's backendNodeId, {"$uidX":"e7"}/{"$uidY":"e7"} → its center x/y. uids come from snapshot. This bridges snapshot to raw CDP (CSS/DOM/Input by element).
- **Events are pull-based**: after cdp(Domain.enable), that domain's events are buffered with a monotonic seq. Pull with events(); pass sinceSeq=<last nextSeq> to get only-new. Buffer holds ~1000 entries.
- **Large results auto-spill**: results over ~16KB (trace, big response bodies, heap snapshots) are written to a file; the path is returned — read/grep it. Network.getResponseBody base64 bodies are auto-decoded.
- **Dialogs**: alert/confirm/prompt are auto-dismissed so they can't wedge automation; take over with cdp(Page.handleJavaScriptDialog, {accept:true[, promptText]}).

High-value recipes:
- **Inspect a request/response body**: cdp(Network.enable) → reproduce → network(tabId) for the list (each line starts with {requestId}) → cdp(Network.getResponseBody, {requestId:"<id>"}). Headers: cdp(Network.getRequestPostData / read the response event via events(event:"Network.responseReceived")).
- **Responsive layout**: cdp(Emulation.setDeviceMetricsOverride, {width:390,height:844,deviceScaleFactor:3,mobile:true}) → screenshot → cdp(Emulation.clearDeviceMetricsOverride) when done.
- **Hover (menus/tooltips)**: cdp(Input.dispatchMouseEvent, {type:"mouseMoved", x:{"$uidX":"e7"}, y:{"$uidY":"e7"}}) → snapshot to see what appeared.
- **Select a dropdown option**: cdp(DOM.resolveNode, {backendNodeId:{"$uid":"e7"}}) → objectId, then cdp(Runtime.callFunctionOn, {objectId, functionDeclaration:"function(){this.value='OPTION_VALUE';this.dispatchEvent(new Event('change',{bubbles:true}))}"}). Read the option values from snapshot/read_page first.
- **Upload a file**: cdp(DOM.setFileInputFiles, {files:["/abs/path/file.png"], backendNodeId:{"$uid":"e7"}}) — uid must be the <input type="file"> element.
- **Why is a style not applied**: snapshot → cdp(CSS.enable) → cdp(CSS.getMatchedStylesForNode, {nodeId:...}) — resolve the node via cdp(DOM.getDocument)+DOM.querySelector or push a backendNodeId with {"$uid"}.
- **Core Web Vitals / LCP**: cdp(PerformanceTimeline.enable, {eventTypes:["largest-contentful-paint","layout-shift"]}) → reload → events(event:"PerformanceTimeline.timelineEventAdded").
- **Storage**: cdp(Network.getCookies) (includes HttpOnly), cdp(DOMStorage.enable)+events for localStorage, cdp(IndexedDB.requestDatabaseNames, {securityOrigin:"https://…"}).
- **Breakpoint-style debugging**: cdp(Debugger.enable) → cdp(Debugger.setBreakpointByUrl, {...}) → trigger → events(event:"Debugger.paused") → cdp(Debugger.evaluateOnCallFrame, {...}) → cdp(Debugger.resume).`
}

function actionReference(caps: BrowserCaps): string {
  const lines = opsForCaps(caps)
    .filter((op) => op.name !== 'help')
    .map((op) => `- ${op.usage} — ${op.description}`)
  return `## Action reference\n\n${lines.join('\n')}`
}

const SECTION_BUILDERS: Record<HelpTopic, (caps: BrowserCaps) => string> = {
  workflow: workflowSection,
  interaction: () => interactionSection(),
  navigation: () => navigationSection(),
  capture: captureSection,
  debugging: debuggingSection,
  devtools: () => devtoolsSection()
}

/** 生成手册；带 topic 只回该节，否则全量（按 caps 过滤） */
export function buildBrowserHelp(caps: BrowserCaps, topic?: string): string {
  if (topic && (helpTopicsForCaps(caps) as readonly string[]).includes(topic)) {
    return SECTION_BUILDERS[topic as HelpTopic](caps)
  }
  return [
    '# browser tool manual',
    workflowSection(caps),
    interactionSection(),
    navigationSection(),
    captureSection(caps),
    debuggingSection(caps),
    ...(caps.rawCdp ? [devtoolsSection()] : []),
    actionReference(caps)
  ].join('\n\n')
}
