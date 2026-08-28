/**
 * 共享 CDP 操作实现 —— 纯"对 TabCdpSession 打 CDP 命令"的部分（两端逐字共享）。
 *
 * 从桌面 browserCdpActions / 扩展 browserTools 的交集与并集参数化搬入；
 * 宿主差异（tab 解析、截图、注入、pdf、面板联动）留在各端 BrowserBackend。
 */
import type { TabCdpSession } from './attachManager'
import type { BrowserOpOutput, NavKind, ScrollDirection } from './backend'
import { dispatchKey } from './keyboard'
import { resolveUidMacros } from './cdpPolicy'
import { EXTRACT_PAGE_EXPR, formatReadPage, htmlToMarkdown, type ExtractedPage } from './readPage'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ====== Snapshot ======

export async function snapshotOp(
  session: TabCdpSession,
  pageUrl: string,
  opts: { full?: boolean } = {}
): Promise<BrowserOpOutput> {
  // 扩展端（chrome.debugger）需要先 enable Accessibility 域；Electron 下幂等无害
  await session.send('Accessibility.enable').catch(() => {})
  const { text, elementCount } = await session.controller.buildSnapshot(pageUrl, opts)
  return { text, details: { elementCount } }
}

// ====== Read Page ======

/**
 * 读整页正文（渲染后 DOM → Markdown）。
 *
 * 走 CDP `Runtime.evaluate`，而**不是** Electron 的 `webContents.executeJavaScript` ——
 * 后者的文档白纸黑字写着「Code execution will be suspended until web page stop loading」，
 * 内部会先 await 一次 `did-stop-loading`。碰上**永远加载不完**的页面（某个子资源/iframe
 * 挂着不返回，面板 spinner 一直转）那个 await 永不兑现，read_page 就无限期挂住；而挂住的
 * 工具 promise 又会让 harness 的 abort（要 waitForIdle）跟着卡死 —— 会话既跑不动也停不下来。
 * CDP 的 evaluate 不看加载状态：只要文档已提交、JS 上下文还在就立即返回。
 *
 * 实测（Electron 39，页面挂一个不返回的 iframe，isLoadingMainFrame=true）：
 * webContents.executeJavaScript 4s 内不兑现，mainFrame.executeJavaScript 与
 * Runtime.evaluate 都立即拿到结果。选 CDP 而非 mainFrame 是为了和本文件其余操作同源。
 */
export async function readPageOp(session: TabCdpSession): Promise<BrowserOpOutput> {
  const { result, exceptionDetails } = await session.send<{
    result: { value?: ExtractedPage }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>('Runtime.evaluate', {
    expression: EXTRACT_PAGE_EXPR,
    returnByValue: true
  })

  const extracted = result?.value
  if (exceptionDetails || !extracted) {
    const err = exceptionDetails?.exception?.description || exceptionDetails?.text || 'no result'
    return { text: `Error: failed to read page — ${err}`, details: { error: err } }
  }

  const md = await htmlToMarkdown(extracted.html)
  return { text: formatReadPage(extracted, md) }
}

// ====== Click ======

/** 读当前页面 URL（用于 click 前后对比）；失败返回 null 不影响主流程 */
async function currentUrl(session: TabCdpSession): Promise<string | null> {
  try {
    const { result } = await session.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true
    })
    return typeof result.value === 'string' ? result.value : null
  } catch {
    return null
  }
}

export async function clickOp(session: TabCdpSession, uid: string): Promise<BrowserOpOutput> {
  const urlBefore = await currentUrl(session)
  const { x, y } = await session.controller.resolveCoordinates(uid)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })

  // 等待一小段时间让页面响应
  await sleep(100)

  const node = session.controller.getNode(uid)
  let text = node?.name?.value
    ? `Clicked ${node.role?.value || 'element'} "${node.name.value}" (uid=${uid}).`
    : `Clicked element uid=${uid}.`

  // 页面跳转提示：省掉 agent 一轮盲目 snapshot
  const urlAfter = await currentUrl(session)
  if (urlBefore && urlAfter && urlAfter !== urlBefore) {
    text += ` Page URL changed to ${urlAfter} — take a new snapshot before further interaction.`
  }
  return { text }
}

// ====== Fill ======

export async function fillOp(
  session: TabCdpSession,
  uid: string,
  text: string
): Promise<BrowserOpOutput> {
  // 两端已逐字一致的配方：focus → 清空（触发 input）→ insertText → 触发 change
  await session.controller.focusElement(uid)
  await session.controller.callOnElement<void>(
    uid,
    `function(){ this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }`
  )
  await session.send('Input.insertText', { text })
  await session.controller.callOnElement<void>(
    uid,
    `function(){ this.dispatchEvent(new Event('change', { bubbles: true })); }`
  )
  return { text: `Filled element uid=${uid} with "${truncate(text, 50)}".` }
}

// ====== Type ======

export async function typeOp(
  session: TabCdpSession,
  text: string,
  uid?: string,
  submitKey?: string
): Promise<BrowserOpOutput> {
  if (uid) {
    await session.controller.focusElement(uid)
  }
  await session.send('Input.insertText', { text })
  if (submitKey) {
    await dispatchKey((m, p) => session.send(m, p), submitKey)
  }
  const desc = uid
    ? `Typed "${truncate(text, 50)}" into element uid=${uid}.`
    : `Typed "${truncate(text, 50)}".`
  return { text: desc + (submitKey ? ` Pressed ${submitKey}.` : '') }
}

// ====== Press Key ======

export async function pressKeyOp(session: TabCdpSession, combo: string): Promise<BrowserOpOutput> {
  await dispatchKey((m, p) => session.send(m, p), combo)
  return { text: `Pressed ${combo}.` }
}

// ====== Scroll ======

export async function scrollOp(
  session: TabCdpSession,
  p: { direction?: ScrollDirection; amount?: number; uid?: string }
): Promise<BrowserOpOutput> {
  const direction = p.direction || 'down'
  const amount = p.amount || 500

  let dx = 0
  let dy = 0
  if (direction === 'down') dy = amount
  else if (direction === 'up') dy = -amount
  else if (direction === 'right') dx = amount
  else if (direction === 'left') dx = -amount

  if (p.uid) {
    await session.controller.callOnElement<void>(
      p.uid,
      `function(){ this.scrollBy(${dx}, ${dy}); }`
    )
  } else {
    await session.send('Runtime.evaluate', {
      expression: `window.scrollBy(${dx}, ${dy})`,
      returnByValue: true
    })
  }
  return { text: `Scrolled ${direction} by ${amount}px.` }
}

// ====== Evaluate ======

export async function evaluateOp(
  session: TabCdpSession,
  expression: string
): Promise<BrowserOpOutput> {
  const { result, exceptionDetails } = await session.send<{
    result: { type: string; value?: unknown; description?: string }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })

  if (exceptionDetails) {
    const errMsg = exceptionDetails.exception?.description || exceptionDetails.text
    return { text: `Error: ${errMsg}`, details: { error: errMsg } }
  }

  const text =
    result.value !== undefined
      ? JSON.stringify(result.value, null, 2)
      : result.description || '(undefined)'
  return { text }
}

// ====== Wait For ======

/** wait_for 轮询上限：超长 timeout 会把一轮工具调用挂死，clamp 到 2 分钟 */
const WAIT_FOR_MAX_TIMEOUT = 120_000

export async function waitForOp(
  session: TabCdpSession,
  text: string,
  timeout = 10000,
  signal?: AbortSignal
): Promise<BrowserOpOutput> {
  const interval = 500
  const clamped = Math.min(Math.max(timeout, interval), WAIT_FOR_MAX_TIMEOUT)
  const maxAttempts = Math.ceil(clamped / interval)
  // JSON.stringify 完整转义（含换行/引号），直接得到合法 JS 字符串字面量
  const literal = JSON.stringify(text)

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      return { text: 'Aborted while waiting.', details: { error: 'aborted' } }
    }
    const { result } = await session.send<{ result: { value: boolean } }>('Runtime.evaluate', {
      expression: `document.body && document.body.innerText.includes(${literal})`,
      returnByValue: true
    })
    if (result.value) {
      return { text: `Found text "${truncate(text, 50)}" on page.` }
    }
    await sleep(interval)
  }

  return {
    text: `Timeout: text "${truncate(text, 50)}" not found after ${clamped}ms.`,
    details: { error: 'timeout' }
  }
}

// ====== Navigate ======

export async function navigateOp(
  session: TabCdpSession,
  nav: NavKind,
  url?: string
): Promise<BrowserOpOutput> {
  // 导航使旧 snapshot 的 uid 全部失效
  const invalidate = (): void => session.controller.reset()

  if (nav === 'goto') {
    if (!url) {
      return {
        text: 'Error: "url" is required for navigate (goto).',
        details: { error: 'missing url' }
      }
    }
    await session.send('Page.enable').catch(() => {})
    await session.send('Page.navigate', { url })
    invalidate()
    await sleep(500)
    return { text: `Navigated to ${url}. Call snapshot after it loads.`, details: { url } }
  }

  if (nav === 'back' || nav === 'forward') {
    const offset = nav === 'back' ? -1 : 1
    const { currentIndex, entries } = await session.send<{
      currentIndex: number
      entries: Array<{ id: number }>
    }>('Page.getNavigationHistory')
    const target = entries[currentIndex + offset]
    if (!target) {
      return {
        text: `Error: no navigation history entry to go ${nav} to.`,
        details: { error: 'no history entry' }
      }
    }
    await session.send('Page.navigateToHistoryEntry', { entryId: target.id })
    invalidate()
    await sleep(300)
    return { text: `Navigated ${nav}.` }
  }

  // reload
  await session.send('Page.reload')
  invalidate()
  await sleep(500)
  return { text: 'Page reloaded.' }
}

// ====== Network ======

export async function networkOp(session: TabCdpSession, limit?: number): Promise<BrowserOpOutput> {
  await session.enableNetworkCapture()
  const all = session.getNetworkRequests()

  if (all.length === 0) {
    return {
      text: 'No network requests captured yet. Capture starts when this action is first called — navigate/reload and call again.'
    }
  }

  const entries = limit && limit > 0 ? all.slice(-limit) : all
  const omitted = all.length - entries.length
  const lines = entries.map((e) => {
    const status = e.failed ? 'FAILED' : (e.status ?? '...')
    const size = e.size != null ? formatBytes(e.size) : ''
    // 带 requestId：agent 可用 cdp(Network.getResponseBody, {requestId}) 钻取响应体/headers
    return `{${e.id}} [${e.method}] ${status} ${e.url}${size ? ' (' + size + ')' : ''}`
  })
  const head =
    omitted > 0
      ? `Network requests (last ${entries.length} of ${all.length})`
      : `Network requests (${entries.length})`
  return {
    text: `${head} — use cdp(Network.getResponseBody, {requestId}) with the {id}:\n${lines.join('\n')}`
  }
}

// ====== Console ======

export async function consoleOp(session: TabCdpSession, limit?: number): Promise<BrowserOpOutput> {
  await session.enableConsoleCapture()
  const all = session.getConsoleMessages()

  if (all.length === 0) {
    return {
      text: 'No console messages captured yet. Capture starts when this action is first called — interact/reload and call again.'
    }
  }

  const entries = limit && limit > 0 ? all.slice(-limit) : all
  const lines = entries.map((e) => {
    const loc = e.url ? ` (${e.url}${e.lineNumber != null ? ':' + e.lineNumber : ''})` : ''
    return `[${e.type}] ${e.text}${loc}`
  })
  const head =
    entries.length < all.length
      ? `Console messages (last ${entries.length} of ${all.length})`
      : `Console messages (${entries.length})`
  return { text: `${head}:\n${lines.join('\n')}` }
}

// ====== 原生 CDP 逃生口 ======

/** 结果超此字节数时落盘（避免巨型 trace/响应体撑爆上下文） */
const CDP_INLINE_LIMIT = 16_000

/** base64 → UTF-8（跨 Node/浏览器；解码失败返回 null 保留原 base64） */
function decodeBase64Utf8(b64: string): string | null {
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    }
    // Node 回退
    return Buffer.from(b64, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

/** 落盘回调：写内容返回可读路径（宿主注入；不传则内联截断） */
export type CdpSpill = (content: string, ext: string) => Promise<string>

/**
 * 发一条原生 CDP 命令。method 的安全分类/询问已由 tool 层完成，这里只：
 *   1. 解析 params 里的 uid 宏（{$uid}/{$uidX}/{$uidY} → backendNodeId / 坐标）
 *   2. 发送命令
 *   3. getResponseBody 的 base64 自动解码；结果过大则落盘（spill）返回摘要 + 路径
 */
export async function cdpOp(
  session: TabCdpSession,
  method: string,
  params: Record<string, unknown> | undefined,
  spill?: CdpSpill
): Promise<BrowserOpOutput> {
  // enable 类命令：先确保对话框监听（Page.enable 时顺带），并让该域后续事件进缓冲
  const resolved = params
    ? ((await resolveUidMacros(params, session.controller)) as Record<string, unknown>)
    : undefined

  let result: unknown
  try {
    result = await session.send(method, resolved)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `CDP error (${method}): ${msg}`, details: { error: msg, method } }
  }

  // getResponseBody：base64 自动解码，便于直接读文本响应体
  if (method === 'Network.getResponseBody' && result && typeof result === 'object') {
    const r = result as { body?: string; base64Encoded?: boolean }
    if (typeof r.body === 'string' && r.base64Encoded) {
      const decoded = decodeBase64Utf8(r.body)
      if (decoded != null) {
        r.body = decoded
        r.base64Encoded = false
      }
    }
  }

  const json = result === undefined ? '(no result)' : JSON.stringify(result, null, 2)
  if (json.length <= CDP_INLINE_LIMIT) {
    return { text: `${method} →\n${json}`, details: { method } }
  }

  // 过大：落盘（若宿主提供）或截断
  if (spill) {
    const path = await spill(json, 'json')
    return {
      text: `${method} → result is large (${json.length} chars), saved to ${path}\nUse the \`read\`/\`grep\` tools on this path to inspect it.`,
      details: { method, spilled: path }
    }
  }
  return {
    text: `${method} →\n${json.slice(0, CDP_INLINE_LIMIT)}\n\n[Output truncated — ${json.length} chars total.]`,
    details: { method, truncated: true }
  }
}

/** 增量拉取事件缓冲 */
export async function eventsOp(
  session: TabCdpSession,
  opts: { event?: string; sinceSeq?: number; limit?: number }
): Promise<BrowserOpOutput> {
  const { entries, nextSeq } = session.getEvents(opts)
  if (entries.length === 0) {
    return {
      text: `No buffered events${opts.event ? ` for "${opts.event}"` : ''}. Enable the domain via cdp(Domain.enable), reproduce, then pull again.\n(nextSeq=${nextSeq})`,
      details: { nextSeq }
    }
  }
  const lines = entries.map((e) => {
    const p = e.truncatedFrom
      ? `${JSON.stringify(e.params).slice(0, 500)}… [truncated from ${e.truncatedFrom} chars]`
      : JSON.stringify(e.params)
    return `#${e.seq} ${e.method} ${p}`
  })
  return {
    text: `Events (${entries.length}, nextSeq=${nextSeq}) — pass sinceSeq=${nextSeq} next time for only-new:\n${lines.join('\n')}`,
    details: { nextSeq }
  }
}
