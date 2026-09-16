/**
 * LLM 请求的网络层适配（桌面端的 RuntimeNetwork 实现）。
 *
 * 解决两件事，共用同一个 AsyncLocalStorage 作用域 —— 只有在 `runInRequestScope`
 * 里跑的 fetch 会被影响，主进程其余的 fetch（litellm 目录、provider 探活、
 * telegram getMe、MCP 的 HTTP 传输…）行为一字不变。
 *
 * 一、**传输超时**。Node 内置 fetch 底下是 undici，默认 `headersTimeout` /
 *     `bodyTimeout` 都是 300s（实测 Node 22.23 / Electron 39 取到的就是 300000）。
 *     `headersTimeout` 管的是「请求发出 → 响应头到达」：唤醒一个长会话时提示词缓存
 *     是冷的，首字节要等 provider 把整段历史重新 prefill；若中转站不透传流式，
 *     首字节更是等于整次生成时间 —— 300s 在这种场合明显偏紧。`bodyTimeout` 则是
 *     SSE 块之间的**空闲**计时，长思考段中途静默过久同样会被掐断。
 *
 *     这里给 LLM 请求单独换一个放宽到 15 分钟的 dispatcher。取 15 分钟而不是
 *     "不限"，是因为 SDK 自己还有一道 10 分钟的请求超时（且只覆盖到响应头到达，
 *     见 @anthropic-ai/sdk 的 fetchWithTimeout：fetch 一 resolve 就 clearTimeout），
 *     15 分钟等于「让 SDK 那道先响」，同时给流式正文留一个仍然有限的兜底，
 *     不至于让一条半死的连接永远挂着。
 *
 * 二、**成因可见**。fetch 失败后 SDK 一律换成固定文案（连接类 "Connection error."、
 *     被判定为超时的则是 "Request timed out."），真正的 `cause` 链挂在 error 上；
 *     而 pi-ai 的 stream 在自己的 catch 里只留 `error.message`，到 modelsAdapter
 *     时已经没有 cause 可读了。所以在这里、也只能在这里把链子记下来，由
 *     modelsAdapter 贴回错误文案，同时写一条 warn 进主进程日志。
 *
 * 注意 `installLlmNetwork()` 换掉的是全局 fetch，但包装体在作用域外是直接透传的，
 * 代价只有一次 `getStore()`。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent } from 'undici'
import type { RuntimeNetwork } from '@shuvix/agent-runtime'
import { createLogger } from '../logger'

const log = createLogger('LlmNetwork')

/** 响应头等待上限 —— 覆盖冷缓存长上下文的首字节等待，见文件头 */
const HEADERS_TIMEOUT_MS = 15 * 60 * 1000
/** 流式正文的空闲上限（SSE 块之间），同上 */
const BODY_TIMEOUT_MS = 15 * 60 * 1000

interface RequestScope {
  /** 本次请求用的 dispatcher（整个进程共用一个 Agent 实例，连接池才有意义） */
  dispatcher: Agent
  /** 作用域内最近一次 fetch 失败的成因链；成功一次就清掉，"最近"才不会骗人 */
  failure?: string
}

const store = new AsyncLocalStorage<RequestScope>()

let agent: Agent | undefined
function llmDispatcher(): Agent {
  agent ??= new Agent({ headersTimeout: HEADERS_TIMEOUT_MS, bodyTimeout: BODY_TIMEOUT_MS })
  return agent
}

/**
 * 摊平 `cause` 链：`TypeError: fetch failed <- HeadersTimeoutError: Headers Timeout Error
 * (UND_ERR_HEADERS_TIMEOUT)`。带 code 的一并写出来 —— `ECONNRESET` 这类的 message
 * 本身太含糊，code 才是能搜的那个词。
 */
function describeCauseChain(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && !seen.has(cur) && parts.length < 5) {
    seen.add(cur)
    if (cur instanceof Error) {
      const code = (cur as NodeJS.ErrnoException).code
      parts.push(`${cur.name}: ${cur.message}${code ? ` (${code})` : ''}`)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' <- ')
}

let installed = false

/**
 * 换掉全局 fetch（幂等）。必须在任何 agent 跑起来之前调用一次。
 *
 * 作用域外原样转发；作用域内注入 dispatcher，并在失败时记下成因。
 * `dispatcher` 不是标准 RequestInit 字段，是 undici 认的扩展（已实测 Node 22 的
 * 内置 fetch 会读它）—— 故这里要绕过 TS 的 RequestInit 类型。
 */
export function installLlmNetwork(): void {
  if (installed) return
  installed = true
  const original = globalThis.fetch
  globalThis.fetch = async function patchedFetch(
    input: Parameters<typeof original>[0],
    init?: Parameters<typeof original>[1]
  ): ReturnType<typeof original> {
    const scope = store.getStore()
    if (!scope) return original(input, init)
    try {
      const response = await original(input, {
        ...init,
        dispatcher: scope.dispatcher
      } as RequestInit)
      scope.failure = undefined
      return response
    } catch (err) {
      // `|| undefined`：抛了个假值（`undefined` / `0`）时链子是空串 —— 那与「没失败过」
      // 不是一回事，但 seam 的契约只有 string | undefined 两种答案，硬凑一个 "undefined"
      // 字样贴进错误文案更糟。空串归一成 undefined，让契约说的就是它做的。
      scope.failure = describeCauseChain(err) || undefined
      if (scope.failure) log.warn(`LLM 请求的 fetch 失败：${scope.failure}`)
      throw err
    }
  }
}

export const llmNetwork: RuntimeNetwork = {
  runInRequestScope: (fn) => store.run({ dispatcher: llmDispatcher() }, fn),
  describeLastFailure: () => store.getStore()?.failure
}
