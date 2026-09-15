/**
 * 共享 CDP 操作实现 —— 纯"对 TabCdpSession 打 CDP 命令"的部分（两端逐字共享）。
 *
 * 从桌面 browserCdpActions / 扩展 browserTools 的交集与并集参数化搬入；
 * 宿主差异（tab 解析、截图、注入、pdf、面板联动）留在各端 BrowserBackend。
 *
 * ## 交互操作回报「页面上实际发生了什么」
 *
 * CDP 的输入命令几乎从不失败：点在空白处、字打进只读框、元素早被重渲染替换，命令都照样成功返回。
 * 旧实现据此回 "Clicked / Filled"，agent 只能靠下一轮快照自己发现没生效、再试一次 ——
 * 「参数没错却没填上，重试又好了」就是这么来的。所以 click / fill / type 先确认目标可操作
 * （还在页面上、露出来、没被盖住、可编辑），做完读回结果，做不到就明说原因；
 * 触发了导航的动作等新页面加载完再回。
 */
import type { TabCdpSession } from './attachManager'
import { staleUidError } from '../cdp/controller'
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

/** 业务失败：不抛错，让 agent 读到原因后改道 */
function errorOut(message: string, details: Record<string, unknown> = {}): BrowserOpOutput {
  return { text: `Error: ${message}`, details: { ...details, error: message } }
}

/** 回显里指代目标：`button "Submit" (uid=e7)` */
function describeUid(session: TabCdpSession, uid: string): string {
  const node = session.controller.getNode(uid)
  const role = node?.role?.value || 'element'
  const name = (node?.name?.value ?? '').replace(/\s+/g, ' ').trim()
  return name ? `${role} "${truncate(name, 60)}" (uid=${uid})` : `${role} uid=${uid}`
}

/** 轮询间隔（等可编辑 / 等加载） */
const POLL_MS = 100
/** 字段被脚本临时 disabled / readonly 时等它放开的上限（常见于「脚本加载完才解除」的表单） */
const EDITABLE_WAIT_MS = 1500
/** fill 读回不对、再试一次之前的间隔 */
const FILL_RETRY_DELAY_MS = 150
/** click 目标暂时没露出来 / 被盖住时的复查：刚弹出、正在动画、遮罩正在淡出 */
const CLICK_SETTLE_ATTEMPTS = 4
const CLICK_SETTLE_MS = 150
/** 导航（含点击 / 按键触发的）等加载的上限 */
export const NAV_TIMEOUT_MS = 10_000
/** DOM 已解析（interactive）但子资源迟迟不完的页面，等这么久就放行 */
const INTERACTIVE_GRACE_MS = 2_000

// ====== 注入页面的元素函数 ======

/**
 * 每个在元素上执行的函数都以这段开头（序列化后在页面里执行，必须自包含）。
 *
 * `this` 是 uid 指向的节点，未必就是要操作的那个元素：StaticText 的 uid 指向文本节点，
 * textbox 可能落在包着 <input> 的容器或 <label> 上。`node` 是它所在的元素（click 用），
 * `el` 是据此找到的真正控件、`kind` 是它的填写方式（fill / type 用）。
 * 用 String.raw：正则里的反斜杠要原样进页面。
 */
const PRELUDE = String.raw`
  const node = this.nodeType === 1 ? this : this.parentElement;
  if (!node || !node.isConnected) return { gone: true };
  const describe = (e) => {
    if (!e || !e.tagName) return 'nothing';
    const id = e.id ? '#' + e.id : '';
    const cls = typeof e.className === 'string' && e.className.trim()
      ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = String(e.getAttribute('aria-label') || e.textContent || e.value || '')
      .slice(0, 200).replace(/\s+/g, ' ').trim().slice(0, 60);
    return '<' + e.tagName.toLowerCase() + id + cls + '>' + (text ? ' "' + text + '"' : '');
  };
  const deepActive = (doc) => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  let el = node;
  if (el.tagName === 'LABEL' && el.control) {
    el = el.control;
  } else if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
    const inner = el.querySelectorAll('input:not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])');
    if (inner.length === 1) el = inner[0];
  }
  if (el.isContentEditable && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
  }
  const kind = el.tagName === 'TEXTAREA' ? 'text'
    : el.tagName === 'SELECT' ? 'select'
    : el.tagName === 'INPUT'
      ? (/^(text|email|number|password|search|tel|url)$/.test(el.type) ? 'text'
        : /^(date|time|datetime-local|month|week|color|range)$/.test(el.type) ? 'value'
        : /^(checkbox|radio)$/.test(el.type) ? 'checkable'
        : el.type === 'file' ? 'file' : 'other')
    : el.isContentEditable ? 'editor' : 'other';
  const valueOf = () => kind === 'editor' ? el.innerText
    : kind === 'select' ? (el.selectedOptions[0] ? el.selectedOptions[0].label : '')
    : String(el.value == null ? '' : el.value);
  const visible = () => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
`

function pageFn(params: string, body: string): string {
  return `function(${params}){${PRELUDE}${body}}`
}

/** fill 前的检查：控件类型、可编辑性、当前值 */
const INSPECT_FN = pageFn(
  '',
  String.raw`
  return {
    kind: kind,
    type: el.type || '',
    desc: describe(el),
    disabled: !!(el.matches && el.matches(':disabled')),
    readOnly: (kind === 'text' || kind === 'value') && !!el.readOnly,
    value: valueOf()
  };
`
)

/** 聚焦并全选现有内容 —— 随后的一次输入即替换 */
const SELECT_CONTENT_FN = pageFn(
  '',
  String.raw`
  el.focus();
  if (kind === 'editor') {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const sel = el.ownerDocument.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    el.select();
  }
  return {};
`
)

/** 输入后读回：值、是否可见、焦点是否被页面挪去了别的元素 */
const READ_BACK_FN = pageFn(
  '',
  String.raw`
  const doc = el.ownerDocument;
  const active = deepActive(doc);
  const elsewhere = active && active !== el && !el.contains(active) && active !== doc.body;
  return { value: valueOf(), visible: visible(), active: elsewhere ? describe(active) : null };
`
)

const CHANGE_FN = pageFn(
  '',
  String.raw`
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {};
`
)

/** 值类 input：走原型上的 value setter（绕过 React 挂在实例上的记账），再补 input/change */
const SET_VALUE_FN = pageFn(
  'text',
  String.raw`
  el.focus();
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (desc && desc.set) desc.set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: String(el.value) };
`
)

/** <select>：按 value、label、忽略大小写的 label 依次匹配 */
const SELECT_OPTION_FN = pageFn(
  'text',
  String.raw`
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const opts = Array.from(el.options);
  const want = norm(text);
  let i = opts.findIndex((o) => o.value === text);
  if (i < 0) i = opts.findIndex((o) => norm(o.label) === want);
  if (i < 0) i = opts.findIndex((o) => norm(o.label).toLowerCase() === want.toLowerCase());
  if (i < 0) {
    return {
      ok: false,
      options: opts.slice(0, 30).map((o) => norm(o.label) + (o.value !== norm(o.label) ? ' [' + o.value + ']' : '')),
      more: Math.max(0, opts.length - 30)
    };
  }
  if (opts[i].disabled) return { ok: false, disabledOption: norm(opts[i].label) };
  el.focus();
  if (el.multiple) opts.forEach((o, j) => { o.selected = j === i; });
  else el.selectedIndex = i;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, label: norm(opts[i].label) };
`
)

/** type 前聚焦：没聚焦过的话光标放到末尾（在已聚焦的元素上保留 agent 自己摆好的光标） */
const FOCUS_FOR_TYPING_FN = pageFn(
  '',
  String.raw`
  const doc = el.ownerDocument;
  const was = deepActive(doc) === el;
  el.focus();
  if (!was) {
    if (kind === 'editor') {
      const range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (kind === 'text') {
      try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {}
    }
  }
  const active = deepActive(doc);
  return { focused: !!active && (active === el || el.contains(active)), active: describe(active) };
`
)

/**
 * 点击前的命中检查：该点最上层的元素是不是目标自己（或其子孙 / 祖先 / 关联 label）。
 * 坐标是主框架视口坐标；目标在 iframe 里时改用它在自己文档里的中心点。
 */
const HIT_TEST_FN = pageFn(
  'x, y',
  String.raw`
  if (node.tagName === 'SELECT' && !node.multiple && !(node.size > 1)) return { select: true };
  const doc = node.ownerDocument;
  const view = doc.defaultView;
  let px = x, py = y;
  if (view && view !== view.top) {
    const r = node.getBoundingClientRect();
    px = r.left + r.width / 2;
    py = r.top + r.height / 2;
  }
  let hit = doc.elementFromPoint(px, py);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(px, py);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return { ok: false, hit: 'nothing (the point is outside the page)' };
  const within = (outer, inner) => {
    for (let n = inner; n; n = n.parentNode || n.host) { if (n === outer) return true; }
    return false;
  };
  if (within(node, hit) || within(hit, node)) return { ok: true };
  const label = hit.closest ? hit.closest('label') : null;
  if (label && label.control && within(node, label.control)) return { ok: true };
  if (node.labels) { for (const l of node.labels) { if (within(l, hit)) return { ok: true }; } }
  return { ok: false, hit: describe(hit) };
`
)

// ====== 导航感知 ======

/**
 * 动作前给当前文档挂一个随机记号。导航之后这个文档就不在了、新文档上没有它 —— 由此分辨
 * 「还是旧页面」与「新页面已提交」，不必去猜 Page.navigate 何时返回、事件有没有错过。
 * back/forward 从 bfcache 恢复的旧文档带的是更早的记号，同样判为新文档。
 */
const DOC_MARK = '__shuvixDocMark'

interface DocMark {
  token: string
  url: string | null
  /** 动作前的事件序号：之后只看此后的 Page.* 事件 */
  seq: number
  frameId: string | null
}

async function markDocument(session: TabCdpSession): Promise<DocMark> {
  const token = Math.random().toString(36).slice(2)
  const seq = session.eventCursor()
  const frameId = await session
    .send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
    .then(
      (r) => r.frameTree?.frame?.id ?? null,
      () => null
    )
  let url: string | null = null
  try {
    const { result } = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => { Object.defineProperty(window, ${JSON.stringify(DOC_MARK)}, { value: ${JSON.stringify(token)}, configurable: true }); return location.href })()`,
      returnByValue: true
    })
    url = typeof result?.value === 'string' ? result.value : null
  } catch {
    // 此刻没有可用的执行上下文（页面正在切换）—— 挂不上记号，之后按新文档处理
  }
  return { token, url, seq, frameId }
}

interface PageState {
  url: string
  readyState: string
  /** 仍是打了记号的那个文档 */
  marked: boolean
}

async function pageState(session: TabCdpSession, token?: string): Promise<PageState | null> {
  try {
    const { result } = await session.send<{ result?: { value?: PageState } }>('Runtime.evaluate', {
      expression: `({ url: location.href, readyState: document.readyState, marked: window[${JSON.stringify(DOC_MARK)}] === ${JSON.stringify(token ?? null)} })`,
      returnByValue: true
    })
    return result?.value && typeof result.value.url === 'string' ? result.value : null
  } catch {
    // 执行上下文正被销毁（导航中）
    return null
  }
}

/** 记号之后主框架上某个 Page 事件的序号（按发生顺序） */
function frameEventSeqs(
  session: TabCdpSession,
  method: string,
  mark: DocMark,
  match?: (params: Record<string, unknown>) => boolean
): number[] {
  if (!mark.frameId) return []
  return session
    .getEvents({ event: method, sinceSeq: mark.seq, limit: 1000 })
    .entries.filter((e) => {
      const p = e.params as { frameId?: string; frame?: { id?: string } }
      return (p.frameId ?? p.frame?.id) === mark.frameId && (!match || match(e.params))
    })
    .map((e) => e.seq)
}

/**
 * 等 DOM 安静一小会儿：没有变动持续 quietMs（上限 maxMs）。首屏渲染、水合、弹出菜单的动画
 * 都在这段时间里改 DOM —— 这时拍的快照 uid 很快就会指向被替换掉的节点。MutationObserver
 * 的回调是微任务，隐藏页面的计时器节流管不到它。
 */
async function waitForDomQuiet(session: TabCdpSession, quietMs = 150, maxMs = 1000): Promise<void> {
  const probe = `(() => {
    if (!window.__shuvixQuiet) {
      const state = { t: performance.now(), observer: null };
      state.observer = new MutationObserver(() => { state.t = performance.now(); });
      state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      Object.defineProperty(window, '__shuvixQuiet', { value: state, configurable: true });
    }
    return performance.now() - window.__shuvixQuiet.t;
  })()`
  const deadline = Date.now() + maxMs
  try {
    for (;;) {
      const { result } = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: probe,
        returnByValue: true
      })
      const idle = result?.value
      if (typeof idle !== 'number' || idle >= quietMs || Date.now() >= deadline) break
      await sleep(Math.max(20, quietMs - idle))
    }
  } catch {
    // 页面在切换 —— 不等了
  } finally {
    await session
      .send('Runtime.evaluate', {
        expression: `(() => { const s = window.__shuvixQuiet; if (s) { s.observer.disconnect(); delete window.__shuvixQuiet; } })()`,
        returnByValue: true
      })
      .catch(() => {})
  }
}

export type LoadState = 'complete' | 'interactive' | 'stopped' | 'failed' | 'timeout'

/**
 * 等页面加载到能交互：是新文档（给了 mark 时必须不是动作前那个）、不是 about:blank、
 * readyState 为 complete，再等 DOM 安静一会儿。
 *   - 永远加载不完的页面（挂着不返回的子资源 / iframe）：DOM 解析完两秒后放行（interactive）
 *   - 导航开始又结束了、文档却没换（下载、204、被取消）：stopped
 *   - 同文档导航（hash / pushState 的历史记录）：文档不换，直接算完成
 *   - Chromium 错误页（DNS 失败等）：failed
 */
export async function waitForLoad(
  session: TabCdpSession,
  opts: { mark?: DocMark; allowBlank?: boolean; timeoutMs?: number } = {}
): Promise<{ state: LoadState; url: string | null }> {
  const { mark } = opts
  const deadline = Date.now() + (opts.timeoutMs ?? NAV_TIMEOUT_MS)
  let interactiveSince = 0
  let url: string | null = null
  for (;;) {
    // 先看事件再读状态：事件已到、文档却还是旧的，才能断定导航结束了而没换页面
    const started = mark ? frameEventSeqs(session, 'Page.frameStartedLoading', mark) : []
    const stopped =
      !!mark &&
      started.length > 0 &&
      frameEventSeqs(session, 'Page.frameStoppedLoading', mark).some((s) => s > started[0])
    const sameDocument =
      !!mark && frameEventSeqs(session, 'Page.navigatedWithinDocument', mark).length > 0
    const s = await pageState(session, mark?.token)
    if (s) {
      url = s.url
      if (s.url.startsWith('chrome-error:')) {
        // 新开的 tab 落到错误页就是失败；动作前已在错误页上时要等这次导航真正结束再下结论 ——
        // 从错误页 back 离开的途中读到的仍是错误页（实测），过早判失败会把一次成功的后退报成失败
        if (!mark || stopped) return { state: 'failed', url }
      } else if (!s.marked && (opts.allowBlank || s.url !== 'about:blank')) {
        if (s.readyState === 'complete') {
          await waitForDomQuiet(session)
          return { state: 'complete', url }
        }
        if (s.readyState === 'interactive') {
          interactiveSince ||= Date.now()
          if (Date.now() - interactiveSince >= INTERACTIVE_GRACE_MS) {
            return { state: 'interactive', url }
          }
        }
      } else if (s.marked && sameDocument) {
        await waitForDomQuiet(session)
        return { state: 'complete', url }
      } else if (s.marked && stopped) {
        return { state: 'stopped', url }
      }
    }
    if (Date.now() >= deadline) return { state: 'timeout', url }
    await sleep(POLL_MS)
  }
}

/** 加载结果的回显后缀（complete 为空） */
export function loadNote(state: LoadState): string {
  switch (state) {
    case 'interactive':
      return ' (still loading some resources)'
    case 'timeout':
      return ` (still loading after ${NAV_TIMEOUT_MS / 1000}s — use wait_for before interacting)`
    case 'failed':
      return ' (the page failed to load)'
    case 'stopped':
      return ' (no new page was loaded — the request may have been a download or was cancelled)'
    default:
      return ''
  }
}

/**
 * 点击 / 按键之后的收尾：动作若触发了导航，等新页面加载完再回并说明页面换了；没导航时
 * （quiet 为真）等 DOM 安静一下，让紧接着的快照拍到弹出的菜单、展开的内容。
 *
 * 旧实现只在 100ms 后比一次 URL：服务端慢一点、新页面还没提交就错过了；比到了也不等加载，
 * agent 随后的 snapshot 拍到的是旧页面或半截新页面，拿到的 uid 转眼失效。
 */
async function settleAfterAction(
  session: TabCdpSession,
  before: DocMark,
  opts: { quiet: boolean }
): Promise<string | null> {
  await sleep(100)
  // target=_blank / window.open 发的是 Page.windowOpen（实测不带 frameId，也不走 frameRequestedNavigation）
  const newTabNote =
    session.getEvents({ event: 'Page.windowOpen', sinceSeq: before.seq }).entries.length > 0
      ? ' It opened a new tab — use list_tabs to find it.'
      : ''
  const sameDocument = frameEventSeqs(session, 'Page.navigatedWithinDocument', before).length > 0
  const started =
    frameEventSeqs(session, 'Page.frameRequestedNavigation', before).length > 0 ||
    frameEventSeqs(session, 'Page.frameStartedLoading', before).length > 0
  const now = await pageState(session, before.token)
  const replaced = now === null || !now.marked

  // 文档没换：什么都没跳，或同文档路由（pushState / hash）。Chromium 对 pushState 也会发
  // frameStartedLoading / frameStoppedLoading（实测），只看加载事件会把它误判成导航、把 uid 全清掉
  if (!replaced && (sameDocument || !started)) {
    if (opts.quiet) await waitForDomQuiet(session, 100, 500)
    if (before.url && now && now.url !== before.url) {
      // 同文档路由（SPA pushState）：没有新页面要等，但内容换了
      return `Page URL changed to ${now.url} — take a new snapshot before further interaction.${newTabNote}`
    }
    return newTabNote.trim() || null
  }

  const load = await waitForLoad(session, { mark: before })
  if (load.state === 'stopped') return `${loadNote('stopped').trim()}${newTabNote}`
  // 新文档：旧快照的 uid 全部作废（否则按内容键「找回」的会是新页面上碰巧同名的元素）
  session.controller.reset()
  const url = load.url ?? now?.url ?? null
  const what = url && url !== before.url ? `Page navigated to ${url}` : 'Page reloaded'
  return `${what}${loadNote(load.state)} — take a new snapshot before further interaction.${newTabNote}`
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

/**
 * 点击：滚进视口 → 取可见部分中心 → 确认该点最上层就是目标 → 可信鼠标事件。
 *
 * 旧实现直接按 getBoundingClientRect 的中心点下去，三种情况都静默「成功」（实测）：
 * 视口外的元素点在视口外（事件落在 <html> 上）；元素已被重渲染替换，脱离文档的旧节点坐标全 0，
 * 点中了页面左上角的别的东西；元素被弹窗 / cookie 横幅盖住，点中的是盖在上面的那个。
 */
export async function clickOp(session: TabCdpSession, uid: string): Promise<BrowserOpOutput> {
  const ctl = session.controller
  const el = await ctl.resolveElement(uid)
  const target = describeUid(session, uid)
  let point: { x: number; y: number } | null = null
  let blocker: string | null = null
  try {
    for (let attempt = 0; ; attempt++) {
      point = await ctl.pointOf(el)
      blocker = null
      if (point) {
        const hit = await ctl.callOn<{
          ok?: boolean
          hit?: string
          gone?: boolean
          select?: boolean
        }>(el, HIT_TEST_FN, [point.x, point.y])
        if (hit.gone) throw staleUidError(uid)
        if (hit.select) {
          return errorOut(
            `${target} is a <select> — choose an option with fill(uid, "<option label or value>") instead of clicking it.`
          )
        }
        if (hit.ok) break
        blocker = hit.hit ?? 'another element'
      }
      if (attempt >= CLICK_SETTLE_ATTEMPTS) break
      await sleep(CLICK_SETTLE_MS)
    }
  } finally {
    await ctl.release(el)
  }

  if (!point) {
    const role = ctl.getNode(uid)?.role?.value
    const hint =
      role === 'option' || role === 'MenuListOption'
        ? ' For an option of a <select>, use fill on the select with the option label.'
        : ''
    return errorOut(
      `${target} is not visible — it has no size on the page (hidden, collapsed, or not rendered yet).${hint}`
    )
  }
  if (blocker) {
    return errorOut(
      `${target} is covered by ${blocker}, so a click there would hit that instead. Dismiss or close it first (take a snapshot to find it), then retry.`
    )
  }

  const before = await markDocument(session)
  const { x, y } = point
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })

  let text = `Clicked ${target}.`
  if (el.relocated) {
    text += ' (It had been re-rendered since your snapshot and was found again by role and name.)'
  }
  const settled = await settleAfterAction(session, before, { quiet: true })
  return { text: settled ? `${text} ${settled}` : text }
}

// ====== Fill ======

type FieldKind = 'text' | 'editor' | 'select' | 'value' | 'checkable' | 'file' | 'other'

interface FieldInfo {
  gone?: boolean
  kind: FieldKind
  type: string
  desc: string
  disabled: boolean
  readOnly: boolean
  value: string
}

interface ReadBack {
  gone?: boolean
  value: string
  visible: boolean
  active: string | null
}

/** 值类 input 被浏览器拒收时回给 agent 的格式提示 */
const VALUE_FORMATS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:MM',
  'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM',
  week: 'YYYY-W05',
  color: '#rrggbb',
  range: 'a number'
}

/** 读回的值是否就是想填的：编辑器（contenteditable）的 innerText 会多出块级换行，只比非空白内容 */
function sameValue(actual: string, expected: string, kind: FieldKind): boolean {
  if (kind === 'editor') {
    return actual.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim()
  }
  return actual.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')
}

/**
 * fill：把字段的值**换成** text。
 *
 * 文本字段的配方是「聚焦 + 全选 + 一次 Input.insertText」（text 为空时按 Delete），不再是
 * 「JS 置空 + insertText」：
 *   - React 受控输入框靠实例上的 value setter 记账。JS 写 `value = ''` 让记账跟着变空，随后的
 *     input 事件被判为「没变化」，清空这一步 React 根本不知道 —— 实测 fill("") 后 DOM 为空、
 *     state 仍是旧值，提交出去的还是旧值。全选后由浏览器原生替换，框架看到的是一次真实编辑。
 *   - contenteditable 没有 value，置空是空操作，insertText 落在光标处 —— 第二次 fill 成了追加
 *     （实测 "hello 0hello 1"）。全选编辑区内容再输入才是替换。
 * <select> 按选项 value / label 选中；date、color 等值类 input 走原型上的 value setter 再补事件。
 *
 * 做完读回，值对上才算成功。实测「命令成功、值没变」的几种情形分别处理：字段暂时 readonly /
 * disabled（脚本稍后才放开）→ 先等；页面在聚焦时把焦点挪去另一个输入框 → 如实报告字落在了哪；
 * 字没留住（被重渲染冲掉等）→ 重新定位后再试一次，仍不行就报错而不是报成功。
 */
export async function fillOp(
  session: TabCdpSession,
  uid: string,
  text: string
): Promise<BrowserOpOutput> {
  const ctl = session.controller
  const target = describeUid(session, uid)

  let info = await ctl.callOnElement<FieldInfo>(uid, INSPECT_FN)
  const deadline = Date.now() + EDITABLE_WAIT_MS
  while (!info.gone && (info.disabled || info.readOnly) && Date.now() < deadline) {
    await sleep(POLL_MS)
    info = await ctl.callOnElement<FieldInfo>(uid, INSPECT_FN)
  }
  if (info.gone) throw staleUidError(uid)

  switch (info.kind) {
    case 'checkable':
      return errorOut(`${target} is a ${info.type} — use click to toggle it.`)
    case 'file':
      return errorOut(
        `${target} is a file input — set files with cdp(DOM.setFileInputFiles, {files:["/abs/path"], backendNodeId:{"$uid":"${uid}"}}).`
      )
    case 'other':
      return errorOut(
        `${target} is not a form field (${info.desc}). fill works on inputs, textareas, <select> and contenteditable editors; for custom widgets use click or type.`
      )
  }
  if (info.disabled) return errorOut(`${target} is disabled.`)
  if (info.readOnly) return errorOut(`${target} is read-only.`)

  if (info.kind === 'select') {
    const r = await ctl.callOnElement<{
      gone?: boolean
      ok?: boolean
      label?: string
      disabledOption?: string
      options?: string[]
      more?: number
    }>(uid, SELECT_OPTION_FN, [text])
    if (r.gone) throw staleUidError(uid)
    if (r.ok) return { text: `Selected "${r.label}" in ${target}.` }
    if (r.disabledOption) return errorOut(`option "${r.disabledOption}" of ${target} is disabled.`)
    const more = r.more ? ` … (+${r.more} more)` : ''
    return errorOut(
      `${target} has no option "${truncate(text, 50)}". Options: ${(r.options ?? []).join(' | ')}${more}`
    )
  }

  if (info.kind === 'value') {
    const r = await ctl.callOnElement<{ gone?: boolean; value: string }>(uid, SET_VALUE_FN, [text])
    if (r.gone) throw staleUidError(uid)
    if (r.value === text) return { text: `Set ${target} to "${truncate(text, 50)}".` }
    if (r.value === '' && text !== '') {
      return errorOut(
        `${target} (type=${info.type}) rejected "${truncate(text, 50)}" — expected a value like ${VALUE_FORMATS[info.type] ?? 'its input format'}.`
      )
    }
    return {
      text: `Set ${target}; the browser normalized "${truncate(text, 50)}" to "${truncate(r.value, 50)}".`
    }
  }

  if (info.type === 'number' && text.trim() !== '' && Number.isNaN(Number(text))) {
    return errorOut(`${target} is a number field and cannot take "${truncate(text, 50)}".`)
  }

  for (let attempt = 1; ; attempt++) {
    const prepared = await ctl.callOnElement<{ gone?: boolean }>(uid, SELECT_CONTENT_FN)
    if (prepared.gone) throw staleUidError(uid)
    if (text === '') await dispatchKey((m, p) => session.send(m, p), 'Delete')
    else await session.send('Input.insertText', { text })

    const after = await ctl.callOnElement<ReadBack>(uid, READ_BACK_FN)
    if (!after.gone) {
      if (sameValue(after.value, text, info.kind)) {
        if (info.kind === 'text') await ctl.callOnElement(uid, CHANGE_FN)
        return { text: `Filled ${target} with "${truncate(text, 50)}".` }
      }
      if (after.active) {
        return errorOut(
          `the text did not go into ${target}: the page moved focus to ${after.active}, so the typing landed there. Take a snapshot and continue with that element.`
        )
      }
      if (!after.visible) {
        return {
          text: `Typed "${truncate(text, 50)}" into ${target}, but could not verify it: the element is hidden (often a code editor's input proxy). Check the result with evaluate or snapshot.`
        }
      }
      if (after.value !== info.value && after.value !== '') {
        if (info.kind === 'text') await ctl.callOnElement(uid, CHANGE_FN)
        return {
          text: `Filled ${target}, but the page changed the value to "${truncate(after.value, 80)}" (formatting, a length limit or an input mask).`
        }
      }
    }
    if (attempt >= 2) {
      return errorOut(
        after.gone
          ? `${target} was replaced by the page while filling. Take a new snapshot, then retry.`
          : `the text did not stick in ${target} — after two attempts it still shows "${truncate(after.value, 50)}". The page may be re-rendering or blocking the field; take a snapshot, then retry.`
      )
    }
    await sleep(FILL_RETRY_DELAY_MS)
  }
}

// ====== Type ======

export async function typeOp(
  session: TabCdpSession,
  text: string,
  uid?: string,
  submitKey?: string
): Promise<BrowserOpOutput> {
  let into = ''
  if (uid) {
    const target = describeUid(session, uid)
    const focus = await session.controller.callOnElement<{
      gone?: boolean
      focused: boolean
      active: string
    }>(uid, FOCUS_FOR_TYPING_FN)
    if (focus.gone) throw staleUidError(uid)
    if (!focus.focused) {
      return errorOut(
        `could not focus ${target} — focus is on ${focus.active}. It may not accept keyboard input; take a snapshot and pick the editable element.`
      )
    }
    into = ` into ${target}`
  }
  if (text) await session.send('Input.insertText', { text })
  let settled: string | null = null
  if (submitKey) {
    const before = await markDocument(session)
    await dispatchKey((m, p) => session.send(m, p), submitKey)
    settled = await settleAfterAction(session, before, { quiet: false })
  }
  const desc = `Typed "${truncate(text, 50)}"${into}.` + (submitKey ? ` Pressed ${submitKey}.` : '')
  return { text: settled ? `${desc} ${settled}` : desc }
}

// ====== Press Key ======

export async function pressKeyOp(session: TabCdpSession, combo: string): Promise<BrowserOpOutput> {
  const before = await markDocument(session)
  await dispatchKey((m, p) => session.send(m, p), combo)
  const settled = await settleAfterAction(session, before, { quiet: false })
  return { text: settled ? `Pressed ${combo}. ${settled}` : `Pressed ${combo}.` }
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
    try {
      const { result } = await session.send<{ result: { value: boolean } }>('Runtime.evaluate', {
        expression: `document.body && document.body.innerText.includes(${literal})`,
        returnByValue: true
      })
      if (result?.value) {
        return { text: `Found text "${truncate(text, 50)}" on page.` }
      }
    } catch {
      // 等待期间页面导航（旧文档的执行上下文被销毁）是 wait_for 的常见场景，下一轮在新文档上接着查
    }
    await sleep(interval)
  }

  return {
    text: `Timeout: text "${truncate(text, 50)}" not found after ${clamped}ms.`,
    details: { error: 'timeout' }
  }
}

// ====== Navigate ======

/** 导航已发出之后：等加载，按结果回显（新文档的 uid 全部失效，调用方已 reset） */
async function navigated(
  session: TabCdpSession,
  before: DocMark,
  verb: string,
  fallbackUrl?: string
): Promise<BrowserOpOutput> {
  const load = await waitForLoad(session, { mark: before })
  if (load.state === 'failed' || load.state === 'stopped') {
    // 错误页自己的地址是 chrome-error://chromewebdata/，对 agent 没用 —— 报想去的那个页面
    const target = fallbackUrl ?? before.url
    return errorOut(
      `${verb} ${target ?? 'the page'}${loadNote(load.state)}.`,
      target ? { url: target } : {}
    )
  }
  const url = load.url ?? fallbackUrl ?? ''
  return {
    text: `${verb} ${url}${loadNote(load.state)}. Take a snapshot before interacting.`,
    details: { url }
  }
}

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
    const before = await markDocument(session)
    const res = await session.send<{ loaderId?: string; errorText?: string }>('Page.navigate', {
      url
    })
    invalidate()
    // DNS 失败、连接被拒、下载（ERR_ABORTED）等：Chromium 在这里就告诉你了，旧实现照样回「已导航」
    if (res?.errorText) return errorOut(`navigation to ${url} failed: ${res.errorText}`, { url })
    if (!res?.loaderId) {
      // 同文档导航（只改了 hash）：没有新文档要等
      await waitForDomQuiet(session)
      return { text: `Navigated to ${url}. Take a snapshot before interacting.`, details: { url } }
    }
    return navigated(session, before, 'Navigated to', url)
  }

  if (nav === 'back' || nav === 'forward') {
    const offset = nav === 'back' ? -1 : 1
    const { currentIndex, entries } = await session.send<{
      currentIndex: number
      entries: Array<{ id: number; url?: string }>
    }>('Page.getNavigationHistory')
    const target = entries[currentIndex + offset]
    if (!target) {
      return {
        text: `Error: no navigation history entry to go ${nav} to.`,
        details: { error: 'no history entry' }
      }
    }
    const before = await markDocument(session)
    await session.send('Page.navigateToHistoryEntry', { entryId: target.id })
    invalidate()
    return navigated(session, before, `Navigated ${nav} to`, target.url)
  }

  // reload
  const before = await markDocument(session)
  await session.send('Page.reload')
  invalidate()
  return navigated(session, before, 'Reloaded')
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
