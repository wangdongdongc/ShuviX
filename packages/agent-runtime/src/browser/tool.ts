/**
 * browser multiplex 工具 —— 单一工具承载全部浏览器操作（两端共享）。
 *
 * schema 是"最小契约"：action 枚举 + 扁平可选参数超集，每个 action 一行描述（常驻 ~450 tokens）；
 * 长尾细节走 action:"help"（help.ts）。参数错误只回该 action 的 usage，不整本回灌。
 * schema / description 按 backend.caps 动态裁剪：不支持的 action 与参数不出现。
 */
import { Type, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BrowserToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type {
  BrowserBackend,
  BrowserOpOutput,
  BrowserCaps,
  NavKind,
  ScrollDirection
} from './backend'
import { opsForCaps, type BrowserAction, type BrowserOpSpec, type BrowserParamKey } from './ops'
import { buildBrowserHelp, helpTopicsForCaps } from './help'
import { blockedCdpReason } from './cdpPolicy'

export const BROWSER_TOOL_NAME = 'browser'

/** execute 收到的参数形状（扁平超集；哪些键实际出现在 schema 由 caps 决定） */
interface BrowserParams {
  action: BrowserAction
  tabId?: string
  url?: string
  uid?: string
  text?: string
  key?: string
  nav?: NavKind
  direction?: ScrollDirection
  amount?: number
  expression?: string
  timeout?: number
  submitKey?: string
  full?: boolean
  fullPage?: boolean
  outputPath?: string
  pageSize?: string
  landscape?: boolean
  scale?: number
  topic?: string
  method?: string
  params?: Record<string, unknown>
  event?: string
  sinceSeq?: number
  limit?: number
}

/** 按 caps 组装参数 schema（typebox）：剔除不可用 action 的 literal 与专属参数键 */
export function buildBrowserParamsSchema(caps: BrowserCaps): TSchema {
  const actions = opsForCaps(caps).map((op) => Type.Literal(op.name))

  const props: Record<string, TSchema> = {
    action: Type.Union(actions, {
      description: 'The browser operation to perform. Use "help" for the full manual.'
    }),
    tabId: Type.Optional(
      Type.String({
        description:
          'Target tab id (from list_tabs / open_tab). Required by every action except help/list_tabs/open_tab.'
      })
    ),
    url: Type.Optional(Type.String({ description: 'URL — for open_tab and navigate (goto)' })),
    uid: Type.Optional(
      Type.String({ description: 'Element uid from the LATEST snapshot of this tab' })
    ),
    full: Type.Optional(
      Type.Boolean({
        description:
          'snapshot: force a complete snapshot instead of a diff — use when you no longer have the earlier snapshot of this tab'
      })
    ),
    text: Type.Optional(
      Type.String({ description: 'Text — fill/type input, or wait_for target text' })
    ),
    key: Type.Optional(
      Type.String({ description: 'Key or combo for press_key, e.g. "Enter", "Control+A"' })
    ),
    nav: Type.Optional(
      Type.Union(
        [
          Type.Literal('goto'),
          Type.Literal('back'),
          Type.Literal('forward'),
          Type.Literal('reload')
        ],
        { description: 'navigate kind (default goto)' }
      )
    ),
    direction: Type.Optional(
      Type.Union(
        [Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')],
        { description: 'scroll direction (default down)' }
      )
    ),
    amount: Type.Optional(Type.Number({ description: 'scroll distance in px (default 500)' })),
    timeout: Type.Optional(Type.Number({ description: 'wait_for timeout in ms (default 10000)' })),
    submitKey: Type.Optional(Type.String({ description: 'key to press after type, e.g. "Enter"' })),
    topic: Type.Optional(
      Type.Union(
        helpTopicsForCaps(caps).map((t) => Type.Literal(t)),
        { description: 'help topic (omit for the full manual)' }
      )
    )
  }
  if (caps.rawCdp || caps.network || caps.console) {
    props.limit = Type.Optional(
      Type.Number({
        description:
          'max entries to return, most recent first (events default 100; network/console default all)'
      })
    )
  }
  if (caps.evaluate) {
    props.expression = Type.Optional(
      Type.String({ description: 'JavaScript expression for evaluate' })
    )
  }
  if (caps.fullPageScreenshot) {
    props.fullPage = Type.Optional(
      Type.Boolean({ description: 'screenshot: capture the full page beyond the viewport' })
    )
  }
  if (caps.pdf) {
    props.outputPath = Type.Optional(
      Type.String({ description: 'pdf: output file path inside the session sandbox' })
    )
    props.pageSize = Type.Optional(
      Type.String({ description: 'pdf: page size, e.g. A4, Letter (default A4)' })
    )
    props.landscape = Type.Optional(Type.Boolean({ description: 'pdf: landscape orientation' }))
    props.scale = Type.Optional(Type.Number({ description: 'pdf: scale 0.1–2 (default 1)' }))
  }
  if (caps.rawCdp) {
    props.method = Type.Optional(
      Type.String({ description: 'cdp: CDP method, e.g. "Network.getResponseBody"' })
    )
    props.params = Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: 'cdp: method params (may use {"$uid":"e7"}/{"$uidX"}/{"$uidY"} macros)'
      })
    )
    props.event = Type.Optional(
      Type.String({ description: 'events: filter by event name, e.g. "Network.responseReceived"' })
    )
    props.sinceSeq = Type.Optional(
      Type.Number({ description: 'events: only events with seq greater than this' })
    )
  }
  return Type.Object(props)
}

/** 按 caps 生成工具 description：action 一行式清单 + 铁律 */
export function buildBrowserToolDescription(caps: BrowserCaps): string {
  const lines = opsForCaps(caps).map((op) => `${op.usage} — ${op.description}`)
  return `Browser automation — one tool, many actions. Set "action" plus the parameters that action needs.

Actions:
${lines.join('\n')}

Rules:
- ALWAYS take a snapshot before click/fill/type; uids are only valid for the latest snapshot of that tab.
- After navigate or a page-changing click, snapshot again before further interaction.
- Every action except help/list_tabs/open_tab requires tabId (from list_tabs or open_tab).${
    caps.evaluate
      ? '\n- Verify by asking, not looking: for a specific fact use evaluate (~20 tokens) rather than read_page (whole page) or screenshot (~900).'
      : ''
  }${
    caps.rawCdp
      ? '\n- Prefer the semantic actions above; for anything they do not cover (response bodies, viewport emulation, CSS inspection, performance, storage) use cdp/events — read help(topic:"devtools") first.'
      : ''
  }`
}

export interface CreateBrowserToolOptions {
  backend: BrowserBackend
  /** abort 时抛出的错误文案（桌面 'Aborted'，扩展 'TOOL_ABORTED'）；默认 'Aborted' */
  abortError?: string
  /** 工具显示名（宿主可传本地化值）；默认 'Browser' */
  label?: string
}

type Result = AgentToolResult<BrowserToolDetails>

function toResult(action: string, out: BrowserOpOutput): Result {
  const content: Result['content'] = []
  for (const img of out.images ?? []) {
    content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
  }
  if (out.text || content.length === 0) {
    content.push({ type: 'text', text: out.text ?? '' })
  }
  return {
    content,
    details: { type: 'browser', action, ...(out.details ?? {}) } as BrowserToolDetails
  }
}

function usageError(action: string, message: string, usage?: string): Result {
  const usageLine = usage ? `\n\nUsage: ${usage}` : ''
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}${usageLine}\n(Use action:"help" for the full manual.)`
      }
    ],
    details: { type: 'browser', action, error: message }
  }
}

/** 校验必选参数（空字符串视为缺失） */
function missingParams(spec: BrowserOpSpec, params: BrowserParams): BrowserParamKey[] {
  const record = params as unknown as Record<string, unknown>
  return spec.required.filter((k) => record[k] == null || record[k] === '')
}

/**
 * 距上次快照隔多少次操作之内还允许回差异。
 *
 * 这是工具**自己能做的确定性判断**：差异依赖模型上下文里还留着上一份快照，而自动
 * 压缩可能把它删掉、工具无从知道。隔得越久越危险，所以设一道上限。它只能数到本工具
 * 自己的调用（别的工具穿插其间是看不见的），所以是个近似 —— 真正的兜底是输出自证 +
 * full:true 这两条，见 cdp/snapshotDiff.ts 的说明。
 */
const MAX_OPS_FOR_DIFF = 8

/**
 * 让一次 backend 操作与中止信号赛跑 —— 信号一响就抛，不等底层 promise 兑现。
 *
 * 为什么必须赛跑而不是「跑完再查一次 signal.aborted」：pi 的 `harness.abort()` 在拉响
 * signal 之后要 `waitForIdle()`，即**等当前工具调用兑现**。所以只要某个 backend 操作
 * 卡住不返回，工具的 execute 就不兑现 → harness 永远不 idle → abort 自己也卡住，
 * 用户看到日志里「中止 session=…」却什么都停不下来（会话按一会话一 agent 的约定会一直
 * 等关停完成）。赛跑把「工具卡住」和「会话能不能停」解耦：底层 promise 继续悬着（浏览器
 * 里没有可靠的取消口），但 execute 立刻结束，harness 回到 idle，用户拿回控制权。
 *
 * 只有 wait_for 自己会看 signal（轮询间隙），其余操作一律靠这层。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, abortError: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(abortError))
    signal.addEventListener('abort', onAbort, { once: true })
    // work 若在 abort 之后才兑现/失败，这里的 resolve/reject 是空操作（promise 已 settle），
    // 不会产生未处理拒绝。
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function dispatch(
  backend: BrowserBackend,
  action: BrowserAction,
  p: BrowserParams,
  opsSinceSnapshot: Map<string, number>,
  signal?: AbortSignal
): Promise<BrowserOpOutput> {
  const tabId = p.tabId!
  switch (action) {
    case 'list_tabs':
      return backend.listTabs()
    case 'open_tab':
      return backend.openTab({ url: p.url! })
    case 'close_tab':
      return backend.closeTab({ tabId })
    case 'navigate':
      return backend.navigate({ tabId, nav: p.nav ?? 'goto', url: p.url })
    case 'snapshot': {
      // 只在「距上次快照没隔几次操作」时才试差异 —— 这是工具自己能做的确定性判断，
      // 不依赖模型对自身上下文的自省。隔得久了、或模型明确要全量，就回全量。
      const since = opsSinceSnapshot.get(tabId) ?? Infinity
      const full = p.full === true || since > MAX_OPS_FOR_DIFF
      opsSinceSnapshot.set(tabId, 0)
      return backend.snapshot({ tabId, full })
    }
    case 'read_page':
      return backend.readPage({ tabId })
    case 'screenshot':
      return backend.screenshot({ tabId, fullPage: p.fullPage, uid: p.uid })
    case 'click':
      return backend.click({ tabId, uid: p.uid! })
    case 'fill':
      return backend.fill({ tabId, uid: p.uid!, text: p.text! })
    case 'type':
      return backend.type({ tabId, text: p.text!, uid: p.uid, submitKey: p.submitKey })
    case 'press_key':
      return backend.pressKey({ tabId, key: p.key! })
    case 'scroll':
      return backend.scroll({ tabId, direction: p.direction, amount: p.amount, uid: p.uid })
    case 'wait_for':
      return backend.waitFor({ tabId, text: p.text!, timeout: p.timeout, signal })
    case 'evaluate':
      return backend.evaluate!({ tabId, expression: p.expression! })
    case 'network':
      return backend.network!({ tabId, limit: p.limit })
    case 'console':
      return backend.console!({ tabId, limit: p.limit })
    case 'pdf':
      return backend.pdf!({
        tabId,
        outputPath: p.outputPath!,
        pageSize: p.pageSize,
        landscape: p.landscape,
        scale: p.scale
      })
    case 'cdp':
      return backend.cdp!({ tabId, method: p.method!, params: p.params })
    case 'events':
      return backend.events!({ tabId, event: p.event, sinceSeq: p.sinceSeq, limit: p.limit })
    default:
      throw new Error(`Unhandled browser action "${action}"`)
  }
}

export function createBrowserTool(
  opts: CreateBrowserToolOptions
): AgentTool<TSchema, BrowserToolDetails> {
  /** 每个 tab 距上次 snapshot 的操作数；决定这次 snapshot 能否回差异 */
  const opsSinceSnapshot = new Map<string, number>()

  const { backend, abortError = 'Aborted', label = 'Browser' } = opts
  const specs = new Map(opsForCaps(backend.caps).map((s) => [s.name, s]))

  return {
    name: BROWSER_TOOL_NAME,
    label,
    description: buildBrowserToolDescription(backend.caps),
    parameters: buildBrowserParamsSchema(backend.caps),
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<Result> {
      if (signal?.aborted) throw new Error(abortError)
      const params = rawParams as BrowserParams
      const action = params.action

      const spec = specs.get(action)
      if (!spec) {
        return usageError(
          String(action),
          `Unknown action "${String(action)}". Available: ${[...specs.keys()].join(', ')}.`
        )
      }

      if (spec.name === 'help') {
        return toResult('help', { text: buildBrowserHelp(backend.caps, params.topic) })
      }

      const missing = missingParams(spec, params)
      if (missing.length > 0) {
        return usageError(
          spec.name,
          `Missing required parameter${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} for ${spec.name}.`,
          spec.usage
        )
      }
      // spec 上表达不了的交叉约束：navigate 缺省/goto 时 url 必选
      if (spec.name === 'navigate' && (params.nav ?? 'goto') === 'goto' && !params.url) {
        return usageError(spec.name, '"url" is required for navigate (goto).', spec.usage)
      }

      // cdp 边界拦截：越出 tab 边界 / 绕过用户级安全设置的方法直接拒绝
      if (spec.name === 'cdp') {
        const reason = blockedCdpReason(params.method!)
        if (reason) {
          return usageError(
            'cdp',
            `CDP method "${params.method}" is blocked: ${reason}.`,
            spec.usage
          )
        }
      }

      // 每次带 tabId 的操作都记一笔 —— snapshot 用它判断「距上次快照隔了多久」
      if (params.tabId && spec.name !== 'snapshot') {
        opsSinceSnapshot.set(params.tabId, (opsSinceSnapshot.get(params.tabId) ?? 0) + 1)
      }
      const work = dispatch(backend, spec.name, params, opsSinceSnapshot, signal)
      const out = signal ? await raceAbort(work, signal, abortError) : await work
      if (signal?.aborted) throw new Error(abortError)
      return toResult(spec.name, out)
    }
  }
}
