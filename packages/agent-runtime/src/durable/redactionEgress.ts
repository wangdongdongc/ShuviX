/**
 * 自动脱敏的出口（docs/auto-redaction-design.md §2.4、§15）：发给模型之前，按策略决定请求里每一处是保持占位符、
 * 换回真值、还是拦下整个请求。
 *
 *  - 对话记录里的内容（用户消息、模型回复、工具结果）已经定稿：写入时就换成了占位符，这里只找占位符、不检测。一处
 *    占位符换回真值，要这条消息的**第一个读者**（它第一次发给的模型，firstReaders）与这次的目的地都判为照发 ——
 *    中途换成信任的模型，之前的内容照旧是占位符。
 *  - 请求时现拼的内容（系统提示词、system 消息里的指令文件与片段）每次重新渲染，在这里检测一遍兜底，按这次的目的地判。
 *
 * 模型看到过真值时，它的回复里也可能写出真值 —— 交回之前按这次发出去的真值精确替换回占位符
 * （Remasker；记录里本来就照原样存的几类不换，categories.ts isKeptAsWritten）：流式的每个事件里累积的那份回复（pi-durable 每 100 毫秒把它写进存储，中途停止时它就成了正式
 * 记录）与最终结果都要换；结尾正好是某个真值的开头时先压住不放出。
 *
 * **不碰 thinking 块**：带签名的 thinking 发回时必须一字不差，模型写下什么就原样发回、原样存下。
 *
 * 策略的判定由调用方交进来（EgressDecision）：宿主用安全模块按第一层（modelRequest / send / detect）与第二层
 * （sensitive / disclose / redact）判。判定结果按 (类别, 规则, 值) 在一次请求里缓存。
 */
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai'
import { isKeptAsWritten } from '../redaction/categories'
import { detectSensitive } from '../redaction/detect'
import { KnownValues } from '../redaction/known'
import {
  asWrittenKey,
  findPlaceholders,
  placeholderFor,
  type PlaceholderSigner
} from '../redaction/placeholder'
import type { RedactionEntry, RedactionTable } from './redactionTable'

/** 第二层的处置 */
export type DiscloseAction = 'redact' | 'send' | 'block'

/** 一次请求的策略判定 */
export interface EgressDecision {
  /** 第一层判为拒发（用户自己写的 deny，比如「这个 bot 只许用家里的服务器」）：整个请求不发 */
  blocked?: boolean
  /** 第一层：这次请求适用脱敏（处置 detect）；不适用 = 信任的目的地，占位符全部换回真值、不检测 */
  applies: boolean
  /** 第二层：一处敏感内容怎么处理 */
  disclose(item: { category: string; rule: string; value: string }): DiscloseAction
}

/** 第二层判为拒发：整个请求不发 */
export class EgressBlockedError extends Error {
  /** category 缺省 = 第一层拒发了整个请求 */
  constructor(readonly category?: string) {
    super(
      category === undefined
        ? 'A security policy does not allow sending requests to this model; the request was not sent.'
        : `A security policy does not allow sending ${category} to this model; the request was not sent.`
    )
    this.name = 'EgressBlockedError'
  }
}

/**
 * 记录里一条消息的第一个读者的判定：取自 readerOf；问不到 = null（按不照发）。这次的目的地就是 env.decision 本身。
 */
type Reader = EgressDecision | null

/** 记录里一条模型回复的产出者（provider / model）→ 它的判定；问不到 = undefined */
export type ReaderDecisions = (provider: string, model: string) => EgressDecision | undefined

interface EgressEnv {
  table: RedactionTable
  signer: PlaceholderSigner
  /** 这次的目的地 */
  decision: EgressDecision
  /** 判定 → (类别, 规则, 值) → 处置 */
  cache: Map<EgressDecision, Map<string, DiscloseAction>>
  /** 这次以真值发出去的：值 → 它的占位符（回复里的真值据此换回）；记录里照原样存的几类不在里面 */
  sent: Map<string, string>
  /** 兜底检测新认出的（记进对照表） */
  entries: RedactionEntry[]
}

function disclose(
  env: EgressEnv,
  category: string,
  rule: string,
  value: string,
  decision: EgressDecision = env.decision
): DiscloseAction {
  let cache = env.cache.get(decision)
  if (cache === undefined) env.cache.set(decision, (cache = new Map()))
  const key = `${category}\u0000${rule}\u0000${value}`
  let action = cache.get(key)
  if (action === undefined) {
    action = decision.disclose({ category, rule, value })
    cache.set(key, action)
  }
  return action
}

/** 用户在输入框里照原样发的值（§14.2）：兜底不再换；拒发（block）照旧 */
function sentAsWritten(env: EgressEnv, value: string): boolean {
  return env.table.asWritten.size > 0 && env.table.asWritten.has(asWrittenKey(env.signer, value))
}

/** 第一个读者照不照发这一处（这次的目的地已经判过）：问不到或第一层拒发 = 不照发，第一层不适用 = 照发 */
function readerSends(
  env: EgressEnv,
  reader: Reader,
  category: string,
  rule: string,
  value: string
): boolean {
  if (reader === null || reader.blocked) return false
  if (reader === env.decision || !reader.applies) return true
  return disclose(env, category, rule, value, reader) === 'send'
}

/**
 * 记录里的一段文本（§15.2）：只找占位符，不检测。这次的目的地判为拒发 → 拦下整个请求；这次的目的地与第一个读者
 * 都照发（第一层不适用 = 照发）才换回真值；第一个读者判为拒发只算不照发。
 */
function egressRecorded(s: string, env: EgressEnv, reader: Reader): string {
  if (s.length < 3) return s
  const hits = findPlaceholders(s, (p) => env.table.has(p))
  if (hits.length === 0) return s
  let out = ''
  let last = 0
  for (const hit of hits) {
    const item = env.table.get(hit.placeholder)
    if (item?.value === undefined) continue
    if (env.decision.applies) {
      const action = disclose(env, item.category, item.rule, item.value)
      if (action === 'block') throw new EgressBlockedError(item.category)
      if (action !== 'send') continue
    }
    if (!readerSends(env, reader, item.category, item.rule, item.value)) continue
    // 旧版本把照原样存的几类也换成了占位符：照发，回复里不再换回
    if (!isKeptAsWritten(item.category)) env.sent.set(item.value, hit.placeholder)
    out += s.slice(last, hit.start) + item.value
    last = hit.end
  }
  return last === 0 ? s : out + s.slice(last)
}

/** 请求时现拼的一段文本（系统提示词、system 消息）发出去的样子：兜底检测，按这次的目的地判 */
function egressText(s: string, env: EgressEnv): string {
  if (s.length < 3) return s
  const hits = findPlaceholders(s, (p) => env.table.has(p))
  // 不适用脱敏：占位符全部换回真值
  if (!env.decision.applies) {
    if (hits.length === 0) return s
    let out = ''
    let last = 0
    for (const hit of hits) {
      const item = env.table.get(hit.placeholder)
      if (item?.value === undefined) continue
      if (!isKeptAsWritten(item.category)) env.sent.set(item.value, hit.placeholder)
      out += s.slice(last, hit.start) + item.value
      last = hit.end
    }
    return out + s.slice(last)
  }
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (const hit of hits) {
    const item = env.table.get(hit.placeholder)
    if (item?.value === undefined) continue
    const action = disclose(env, item.category, item.rule, item.value)
    if (action === 'block') throw new EgressBlockedError(item.category)
    if (action === 'send') {
      // 旧版本把这几类也换成了占位符：照发，回复里不再换回
      if (!isKeptAsWritten(item.category)) env.sent.set(item.value, hit.placeholder)
      edits.push({ start: hit.start, end: hit.end, text: item.value })
    }
  }
  // 兜底：还没换成占位符的（请求时现拼的内容、旧会话里的真值、记录里照原样存的几类）
  for (const f of detectSensitive(s, env.table.known)) {
    if (hits.some((h) => f.start < h.end && f.end > h.start)) continue
    const action = disclose(env, f.category, f.rule, f.value)
    if (action === 'block') throw new EgressBlockedError(f.category)
    // 照发、记录里也照原样存的：不记表，回复里也不换
    if (action === 'send' && isKeptAsWritten(f.category)) continue
    // 用户在输入框里决定让模型看的：同上
    if (sentAsWritten(env, f.value)) continue
    const known = env.table.known.get(f.value)
    const placeholder =
      known?.placeholder ?? placeholderFor(env.signer, f.category, f.value, (p) => env.table.has(p))
    if (
      !known &&
      !env.table.has(placeholder) &&
      !env.entries.some((e) => e.placeholder === placeholder)
    ) {
      env.entries.push({ placeholder, category: f.category, rule: f.rule, value: f.value })
    }
    if (action === 'send') env.sent.set(f.value, placeholder)
    else edits.push({ start: f.start, end: f.end, text: placeholder })
  }
  if (edits.length === 0) return s
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let last = 0
  for (const edit of edits) {
    out += s.slice(last, edit.start) + edit.text
    last = edit.end
  }
  return out + s.slice(last)
}

function egressJson(value: unknown, env: EgressEnv, reader: Reader): unknown {
  if (typeof value === 'string') return egressRecorded(value, env, reader)
  if (Array.isArray(value)) return value.map((v) => egressJson(v, env, reader))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = egressJson(v, env, reader)
    return out
  }
  return value
}

/**
 * 每条消息的第一个读者（§15.2），从记录本身推出：模型回复 = 产出它的模型；工具结果 = 发起这次调用的那条回复的模型
 * （写入时这个对话在用的）；其余 = 它后面第一条回复的模型，后面还没有回复就是这次的目的地。readerOf 缺省 = 都按
 * 这次的目的地。
 */
function firstReaders(
  messages: readonly Message[],
  current: EgressDecision,
  readerOf: ReaderDecisions | undefined
): Reader[] {
  const out: Reader[] = new Array<Reader>(messages.length)
  let next: Reader = current
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') {
      next = readerOf === undefined ? current : (readerOf(message.provider, message.model) ?? null)
    }
    out[i] = next
  }
  let caller: Reader | undefined
  messages.forEach((message, i) => {
    if (message.role === 'assistant') caller = out[i]!
    else if (message.role === 'toolResult' && caller !== undefined) out[i] = caller
  })
  return out
}

function egressMessage(message: Message, env: EgressEnv, reader: Reader): Message {
  switch (message.role) {
    case 'system': {
      const content =
        typeof message.content === 'string'
          ? egressText(message.content, env)
          : message.content.map((block) => ({ ...block, text: egressText(block.text, env) }))
      const sections = message.sections
        ? Object.fromEntries(
            Object.entries(message.sections).map(([k, v]) => [
              k,
              v === null ? null : egressText(v, env)
            ])
          )
        : undefined
      return { ...message, content, ...(sections ? { sections } : {}) }
    }
    case 'user':
      return {
        ...message,
        content:
          typeof message.content === 'string'
            ? egressRecorded(message.content, env, reader)
            : message.content.map((block) =>
                block.type === 'text'
                  ? { ...block, text: egressRecorded(block.text, env, reader) }
                  : block
              )
      }
    case 'assistant':
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type === 'text') {
            return { ...block, text: egressRecorded(block.text, env, reader) }
          }
          if (block.type === 'toolCall') {
            return {
              ...block,
              arguments: egressJson(block.arguments, env, reader) as typeof block.arguments
            }
          }
          return block // thinking：一字不差
        })
      }
    case 'toolResult':
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === 'text'
            ? { ...block, text: egressRecorded(block.text, env, reader) }
            : block
        )
      }
    default:
      return message
  }
}

/** 一次请求发出去的样子，以及回复要不要换回 */
export interface PreparedEgress {
  context: Context
  /** 兜底检测新认出的（调用方记进对照表） */
  entries: RedactionEntry[]
  /** 这次以真值发出去的；没有就不必处理回复 */
  remasker: Remasker | undefined
}

/**
 * 按判定改写一次请求；这次的目的地第二层判为拒发时抛 EgressBlockedError。readerOf：记录里模型回复的产出者的判定
 * （§15.2，调用方事先问好）；缺省 = 都按这次的目的地。
 */
export function prepareEgress(
  context: Context,
  table: RedactionTable,
  signer: PlaceholderSigner,
  decision: EgressDecision,
  readerOf?: ReaderDecisions
): PreparedEgress {
  if (decision.blocked) throw new EgressBlockedError()
  const env: EgressEnv = { table, signer, decision, cache: new Map(), sent: new Map(), entries: [] }
  const readers = firstReaders(context.messages, decision, readerOf)
  const messages = context.messages.map((message, i) => egressMessage(message, env, readers[i]!))
  const systemPrompt =
    context.systemPrompt === undefined ? undefined : egressText(context.systemPrompt, env)
  return {
    context: { ...context, messages, ...(systemPrompt === undefined ? {} : { systemPrompt }) },
    entries: env.entries,
    remasker: env.sent.size === 0 ? undefined : new Remasker(env.sent)
  }
}

// ─────────────────────────── 回复：真值换回占位符 ───────────────────────────

/**
 * 把模型回复里这次发出去的真值精确换回占位符。流式时按内容块增量处理：已经放出的部分不再动，新到的部分里
 * 结尾若正好是某个真值的开头就先压住（KnownValues.pendingTail），等下一个事件再判断。
 */
export class Remasker {
  private readonly known = new KnownValues()
  /** 内容块下标 → 已处理到原文的哪里、放出了什么 */
  private readonly blocks = new Map<number, { consumed: number; out: string }>()

  /** 短于 8 的真值（三个字母的密码、短用户名）不进原文匹配，只换成整词出现的 */
  private readonly shortValues: Array<[RegExp, string]>

  constructor(sent: ReadonlyMap<string, string>) {
    for (const [value, placeholder] of sent) {
      this.known.add({ value, placeholder, category: '' })
    }
    this.shortValues = [...sent]
      .filter(([value]) => value.length < 8)
      .map(([value, placeholder]) => [
        new RegExp(
          `(?<![A-Za-z0-9_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
          'g'
        ),
        placeholder
      ])
  }

  /** 一段完整的文本 */
  text(s: string): string {
    let out = ''
    let last = 0
    for (const span of this.known.spans(s)) {
      out += s.slice(last, span.start) + span.placeholder
      last = span.end
    }
    out += s.slice(last)
    for (const [re, placeholder] of this.shortValues) out = out.replace(re, () => placeholder)
    return out
  }

  private json(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.map((v) => this.json(v))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = this.json(v)
      return out
    }
    return value
  }

  /** 最终的回复（或出错时的那份） */
  message(message: AssistantMessage): AssistantMessage {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'text') return { ...block, text: this.text(block.text) }
        if (block.type === 'toolCall') {
          return { ...block, arguments: this.json(block.arguments) as typeof block.arguments }
        }
        return block
      })
    }
  }

  /** 流式事件里累积的那份回复：文本块增量处理、压住结尾；工具参数整段换 */
  partial(message: AssistantMessage): AssistantMessage {
    return {
      ...message,
      content: message.content.map((block, index) => {
        if (block.type === 'text') return { ...block, text: this.streamText(index, block.text) }
        if (block.type === 'toolCall') {
          return { ...block, arguments: this.json(block.arguments) as typeof block.arguments }
        }
        return block
      })
    }
  }

  private streamText(index: number, full: string): string {
    let state = this.blocks.get(index)
    if (state === undefined || full.length < state.consumed) {
      state = { consumed: 0, out: '' }
      this.blocks.set(index, state)
    }
    let pending = this.known.pendingTail(full)
    // 短的真值按整词换：结尾那个还没写完的词也先压住（它可能正是某个短值，也可能比它长）
    if (this.shortValues.length > 0) pending = Math.max(pending, trailingToken(full))
    const upTo = Math.max(state.consumed, full.length - pending)
    if (upTo > state.consumed) {
      state.out += this.text(full.slice(state.consumed, upTo))
      state.consumed = upTo
    }
    return state.out
  }
}

/** 结尾那段不含空白的字符有多长（最多 64：一直不出现空白的长串照常放出） */
function trailingToken(s: string): number {
  let n = 0
  while (n < 64 && n < s.length && !/\s/.test(s[s.length - 1 - n]!)) n++
  return n === 64 ? 0 : n
}
