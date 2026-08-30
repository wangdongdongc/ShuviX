/**
 * 假 OpenAI 兼容提供商 —— 对话区 e2e 的「模型侧」。
 *
 * 隔离实例没有 API Key，真实模型既跑不通也不可复现；这里在 vitest 进程里起一个
 * 本地 HTTP 服务，按 `openai-completions` 协议回放**脚本化**的一轮回复，
 * 让整条链路（pi-ai → harness → ChatEvent → chatStore → DOM）真实跑起来。
 *
 * 三条硬约束（踩过的坑，别改）：
 *
 *  1. **队列耗尽绝不 hang** —— `nextTurn()` 取不到脚本就回默认 `"OK"`。
 *     队列空时挂死比断言失败难查十倍。
 *  2. **标题请求不消费队列** —— `agentSession.prompt` 每轮都会触发自动标题
 *     （`completeSimple`，system 含 `Generate a concise title`），不单独拦就会
 *     打乱脚本顺序、让用例随机红。标题请求一律直接回 `{"title": ...}`。
 *  3. **usage 远小于 contextWindow** —— 否则 `maybeAutoCompact` 会在轮末触发，
 *     用例被压缩污染。脚本里写几百的数字即可（模型 contextWindow 由
 *     `seedFakeProvider` 设成 200k）。
 *
 * SSE 形状对齐 pi-ai 的 openai-completions 适配器（`dist/api/openai-completions.js`）：
 *   - 文本   `delta.content`
 *   - 思考   `delta.reasoning_content`（适配器取 reasoning_content / reasoning /
 *            reasoning_text 里第一个非空字段，无「模型需声明支持推理」的门槛）
 *   - 工具   `delta.tool_calls[{ index, id, function: { name, arguments } }]`
 *   - 收尾   带 `finish_reason` 的 chunk（**必须有**，否则适配器抛
 *            "Stream ended without finish_reason"）+ usage-only chunk + `[DONE]`
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一次 LLM 调用的脚本（= 一个 turn） */
export interface FakeTurn {
  /** 正文；数组 = 逐片下发（流式渲染断言用） */
  text?: string | string[]
  /** 思考正文（走 delta.reasoning_content）；数组 = 逐片下发 */
  thinking?: string | string[]
  /** 工具调用；有值时 finishReason 缺省为 'tool_calls' */
  toolCalls?: Array<{ id: string; name: string; args: string }>
  /**
   * 按请求内容认领这个 turn；缺省 = 纯 FIFO（既有用例零改动）。
   *
   * **并发场景必须用它**：队列的消费序是「请求体读完的顺序」而不是发出顺序，所以多个
   * 并行派发（双 bot 的两个意图段）拿到哪个脚本完全不确定。服务跑在 vitest 进程里，
   * 判定就是一个普通闭包 —— 可用的判据都在已记录的 `raw`/`body` 里：提示词带的
   * bot displayName、契约里有没有 `"ignore"`（天然区分 intent / intentSolo）、
   * `body.tools?.length === 1`（只有 next 的意图段）。
   */
  when?: (req: FakeRequest) => boolean
  /** 本次调用的用量（prompt/completion，务必是小数值） */
  usage?: { prompt: number; completion: number }
  finishReason?: 'stop' | 'tool_calls' | 'length'
  /** 每片之间的间隔，制造可观察的流式过程 */
  chunkDelayMs?: number
  /**
   * 内容片发完后、finish_reason 之前挂住的上限毫秒数 —— 中止 / steer 用例的唯一抓手。
   * 期间 `release()` 可提前放行；客户端断开（abort）也会立刻结束。
   */
  holdMs?: number
  /** 非 2xx 直接返回该状态（provider 报错用例）；不发 SSE */
  httpStatus?: number
}

interface OpenAIMessage {
  role?: string
  content?: unknown
}

/** 请求体里我们会读到的字段（其余原样保留在 body 里） */
export interface FakeRequestBody {
  model?: string
  messages?: OpenAIMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tools?: unknown[]
}

/** 一次记录下来的请求 */
export interface FakeRequest {
  /** 自动标题请求（不消费脚本队列） */
  isTitle: boolean
  body: FakeRequestBody
  /** `JSON.stringify(body)` —— 「发给模型的 payload 里有没有某段文本」的便捷断言入口 */
  raw: string
  /** 最后一条 user 消息的纯文本 */
  lastUserText: string
}

export interface FakeProvider {
  /** 提供商 baseUrl（pi-ai 自己拼 `/chat/completions`） */
  baseUrl: string
  /** 排队一个或多个 turn 脚本 */
  script(...turns: FakeTurn[]): void
  /** 清空脚本队列与请求记录（每个 it 开头调一次） */
  reset(): void
  /** 全部请求（含标题请求） */
  requests(): FakeRequest[]
  /** 仅对话请求（剔除自动标题） */
  chatRequests(): FakeRequest[]
  /** 已处理的对话请求数 */
  chatRequestCount(): number
  /** 提前放行当前 hold（未在 hold 中则无副作用） */
  release(): void
  close(): Promise<void>
}

const TITLE_MARKER = 'Generate a concise title'

const asChunks = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** OpenAI 消息 content（字符串或内容块数组）→ 纯文本 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const block = c as { type?: string; text?: string }
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .join('')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function startFakeProvider(): Promise<FakeProvider> {
  const queue: FakeTurn[] = []
  const recorded: FakeRequest[] = []
  let releaseHold: (() => void) | null = null

  const writeChunk = (res: ServerResponse, payload: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  const chunkOf = (model: string, delta: Record<string, unknown>): Record<string, unknown> => ({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  })

  /** 挂住直到 release() / 超时 / 客户端断开，三者取先 */
  const hold = (res: ServerResponse, ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        res.off('close', finish)
        releaseHold = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      res.on('close', finish)
      releaseHold = finish
    })

  const streamTurn = async (res: ServerResponse, model: string, turn: FakeTurn): Promise<void> => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.flushHeaders()

    const delay = turn.chunkDelayMs ?? 0
    for (const piece of asChunks(turn.thinking)) {
      writeChunk(res, chunkOf(model, { reasoning_content: piece }))
      if (delay) await sleep(delay)
    }
    for (const piece of asChunks(turn.text)) {
      writeChunk(res, chunkOf(model, { content: piece }))
      if (delay) await sleep(delay)
    }
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      writeChunk(
        res,
        chunkOf(model, {
          tool_calls: [
            { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }
          ]
        })
      )
      writeChunk(
        res,
        chunkOf(model, {
          tool_calls: [{ index, function: { arguments: call.args } }]
        })
      )
      if (delay) await sleep(delay)
    }

    if (turn.holdMs) await hold(res, turn.holdMs)
    // 客户端已断开（abort）：不再写收尾帧，让适配器按 aborted 收场
    if (res.writableEnded || res.destroyed) return

    const finishReason = turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop')
    writeChunk(res, {
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    })
    // usage-only chunk（choices 为空数组，适配器先读 chunk.usage 再取 choices[0]）；
    // 不补则 metadata.usage 恒为空
    const usage = turn.usage
    if (usage) {
      writeChunk(res, {
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: {
          prompt_tokens: usage.prompt,
          completion_tokens: usage.completion,
          total_tokens: usage.prompt + usage.completion
        }
      })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c.toString()))
      req.on('end', () => resolve(raw))
    })

  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawBody = await readBody(req)
      let body: FakeRequestBody = {}
      try {
        body = JSON.parse(rawBody) as FakeRequestBody
      } catch {
        /* 非 JSON 请求（不该发生）按空体处理 */
      }
      const isTitle = rawBody.includes(TITLE_MARKER)
      const messages = body.messages ?? []
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const record: FakeRequest = {
        isTitle,
        body,
        raw: rawBody,
        lastUserText: textOfContent(lastUser?.content)
      }
      recorded.push(record)

      const model = body.model ?? 'e2e-model'
      // 标题请求：直接回 JSON 标题，绝不动脚本队列
      if (isTitle) {
        await streamTurn(res, model, { text: '{"title":"E2E 标题"}', finishReason: 'stop' })
        return
      }

      // 取队列里第一个「没写 when 或 when 命中」的 turn：无 when 的仍是纯 FIFO
      const at = queue.findIndex((t) => !t.when || t.when(record))
      const turn =
        at >= 0 ? queue.splice(at, 1)[0] : ({ text: 'OK', finishReason: 'stop' } as FakeTurn)
      if (turn.httpStatus) {
        res.writeHead(turn.httpStatus, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: { message: 'e2e injected failure', type: 'server_error' } })
        )
        return
      }
      await streamTurn(res, model, turn)
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    script: (...turns) => queue.push(...turns),
    reset: () => {
      queue.length = 0
      recorded.length = 0
    },
    requests: () => [...recorded],
    chatRequests: () => recorded.filter((r) => !r.isTitle),
    chatRequestCount: () => recorded.filter((r) => !r.isTitle).length,
    release: () => releaseHold?.(),
    close: () =>
      new Promise<void>((resolve) => {
        releaseHold?.()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
