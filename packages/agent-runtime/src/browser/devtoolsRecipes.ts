/**
 * `cdp` / `events` 逃生口的约定与配方 —— 内置 browser MCP server 的 `cdp_recipes` 工具返回它。
 *
 * 不复述 CDP 协议本身（模型已经懂），只讲本工具在协议之上加的约定和几个高价值配方。
 * ~700 tokens，不值得常驻在 `cdp` 的工具描述里：用到逃生口的会话是少数，按需取一次即可。
 *
 * 按端能力生成：提到的每一个工具都得真在这台 server 的工具表上（扩展没有 upload_file）——
 * 教模型去用一个它手里没有的工具，是在教一条死路。
 */
import type { BrowserCaps } from './backend'

export function devtoolsRecipes(caps: BrowserCaps): string {
  const gated = [
    'Page.navigate and Network.loadNetworkResource are checked exactly like navigate',
    caps.upload
      ? 'DOM.setFileInputFiles and the files of Input.dispatchDragEvent exactly like upload_file'
      : ''
  ]
    .filter(Boolean)
    .join(', and ')
  const requestBody = caps.network
    ? 'cdp(Network.enable) → reproduce → network(tabId) for the list (each line starts with its requestId)'
    : 'cdp(Network.enable) → reproduce → events(event:"Network.requestWillBeSent") for the requestIds'
  const ownTools = caps.upload
    ? 'Hovering and file uploads have their own tools (hover, upload_file) — prefer them over Input.dispatchMouseEvent and DOM.setFileInputFiles.'
    : 'Hovering has its own tool (hover) — prefer it over Input.dispatchMouseEvent.'

  return `# cdp / events — conventions and recipes

The other browser tools cover the common flows. For anything else, drive the raw Chrome DevTools Protocol:
  cdp(tabId, method:"Domain.method"[, params])   — send one CDP command to the tab
  events(tabId[, event][, sinceSeq][, limit])    — pull buffered events (see below)

## Conventions this tool adds on top of raw CDP

- Safety: methods in known domains run directly. Domains and methods outside the tab (Browser, Target, Tracing, SystemInfo, Tethering, Page.close, Page.crash, Security.setIgnoreCertificateErrors) are refused. ${gated}. Careful with Fetch.enable — interception pauses every matching request until you continue it.
- uid macros: anywhere in params you may write {"$uid":"e7"} → the element's backendNodeId, {"$uidX":"e7"} / {"$uidY":"e7"} → its centre x / y (scrolled into view first). uids come from snapshot; this is how snapshot connects to CSS / DOM / Input by element.
- Events are pull-based: after cdp(Domain.enable) that domain's events are buffered with a monotonic seq. Pull them with events; pass sinceSeq=<the last nextSeq> to get only new ones. The buffer keeps ~1000 entries.
- Large results (traces, big response bodies, heap snapshots) are not returned inline: depending on the host they are written to a file whose path is returned (read or grep it), or truncated with a note. Network.getResponseBody bodies in base64 are decoded for you.
- Dialogs: alert / confirm / prompt are dismissed automatically so they cannot wedge automation; take over with cdp(Page.handleJavaScriptDialog, {accept:true[, promptText]}).

## Recipes

- Inspect a request / response body: ${requestBody} → cdp(Network.getResponseBody, {requestId:"<id>"}). Request body: cdp(Network.getRequestPostData, {requestId}); headers: events(event:"Network.responseReceived").
- Responsive layout: cdp(Emulation.setDeviceMetricsOverride, {width:390, height:844, deviceScaleFactor:3, mobile:true}) → screenshot → cdp(Emulation.clearDeviceMetricsOverride) when done.
- Why a style is not applied: snapshot → cdp(CSS.enable) → cdp(DOM.getDocument) → cdp(DOM.pushNodesByBackendIdsToFrontend, {backendNodeIds:[{"$uid":"e7"}]}) → cdp(CSS.getMatchedStylesForNode, {nodeId:<that id>}).
- Core Web Vitals / LCP: cdp(PerformanceTimeline.enable, {eventTypes:["largest-contentful-paint","layout-shift"]}) → navigate(tabId, nav:"reload") → events(event:"PerformanceTimeline.timelineEventAdded").
- Storage: cdp(Network.getCookies) (includes HttpOnly); cdp(DOMStorage.enable) + events for localStorage; cdp(IndexedDB.requestDatabaseNames, {securityOrigin:"https://…"}).
- Breakpoint-style debugging: cdp(Debugger.enable) → cdp(Debugger.setBreakpointByUrl, {...}) → trigger it → events(event:"Debugger.paused") → cdp(Debugger.evaluateOnCallFrame, {...}) → cdp(Debugger.resume).

${ownTools}`
}
