/**
 * 一条会话的脱敏（docs/auto-redaction-design.md §2）：写入对话记录之前把认出的内容换成占位符、记进对照表
 * （默认照发的几类照原样存，categories.ts isKeptAsWritten）；输入框发来的只换用户交来的那几项（§14）；
 * 工具执行之前把参数里的占位符换回真值（命令按引号环境转义）。宿主无关：占位符怎么签、真值怎么加密由宿主交进来（RedactionHost）。
 *
 * 出错的处置（§4.4）：替换的任何一步抛错 → 记 error、按原样写入（当作漏检）；还原时表项解不开 → 那个占位符
 * 记为「查不到」，由调用方拦下这次工具调用（不会把占位符写进文件）。
 */
import type { Context } from '@earendil-works/chord'
import {
  GenerationTask,
  hook,
  ProviderDoc,
  ToolTask,
  type ConversationId,
  type Harness,
  type HookRegistration,
  type ToolExecutionResult,
  type UserInput
} from '@earendil-works/pi-durable'
import { isKeptAsWritten } from '../redaction/categories'
import {
  commandQuoteContexts,
  quoteValue,
  type CommandDialect,
  type QuoteContext
} from '../redaction/commandQuote'
import { detectSensitive } from '../redaction/detect'
import {
  asWrittenKey,
  findPlaceholders,
  placeholderFor,
  type PlaceholderSigner
} from '../redaction/placeholder'
import type { RuntimeLogger } from '../types'
import { backgroundContext as BG, errorText } from './context'
import {
  entriesReferencedBy,
  loadRedactionTable,
  recordRedactions,
  type RedactionEntry,
  type RedactionTable,
  type RedactionVault,
  USER_RULE
} from './redactionTable'

/** 宿主交进来的两把钥匙 */
export interface RedactionHost {
  /** 占位符的 HMAC（全局一把：同一个值在任何会话里同一个占位符） */
  signer: PlaceholderSigner
  /** 对照表里真值的加密 */
  vault: RedactionVault
}

/** 还原的结果 */
export interface RestoreOutcome<T> {
  value: T
  /** 换回了真值的类别（去重，按出现顺序）—— 进安全策略的 `tool.restored` */
  restored: string[]
  /** 表里有、但真值解不开的占位符 —— 调用方据此拦下这次调用 */
  unavailable: string[]
}

/** 用户在输入框里交来的一项敏感信息：+ 添加的，或确认了提示的（§14） */
export interface UserSecret {
  value: string
  category: string
}

/** 还原工具参数时，哪一个字段是命令、按什么方言转义 */
export interface RestoreCommandOptions {
  /** 参数对象顶层的字段名（bash / powershell / ssh exec 的 `command`） */
  field: string
  dialect: CommandDialect
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 收集一个 JSON 值里的全部字符串（深度优先），再按同样的顺序换回去 */
function mapStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, map))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, map)
    return out
  }
  return value
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, into))
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, into)
  }
}

export class SessionRedaction {
  private loading: Promise<RedactionTable> | undefined

  constructor(
    private readonly deps: {
      sessionId: string
      /** 未包装的 Harness：对照表的读写不开启调度器 */
      harness: Harness
      host: RedactionHost
      logger: RuntimeLogger
    }
  ) {}

  /** 会话的对照表（第一次用时读出，之后随记随更） */
  table(): Promise<RedactionTable> {
    this.loading ??= loadRedactionTable(this.deps.harness, this.deps.host.vault).catch((error) => {
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  // ─────────────────────────── 写入：换成占位符 ───────────────────────────

  /** 一段文本：认出的内容换成占位符，新认出的记进对照表 */
  async maskText(text: string): Promise<string> {
    return (await this.maskTexts([text]))[0]
  }

  /**
   * 几段文本一起换（新认出的在一个提交里记）。**从不抛错**：读表、检测、签占位符、记表任何一步出错都记
   * error、按原样交回（当作漏检，§4.4）—— 换成了占位符却没记进表，比原样写下更糟：之后谁也还原不了。
   */
  async maskTexts(texts: readonly string[]): Promise<string[]> {
    if (!texts.some((t) => t.length >= 3)) return [...texts]
    try {
      const table = await this.table()
      const entries: RedactionEntry[] = []
      const out = texts.map((text) => this.maskOne(text, table, entries))
      if (entries.length > 0) {
        await recordRedactions(this.deps.harness, table, entries, this.deps.host.vault)
      }
      return out
    } catch (error) {
      this.deps.logger.error(
        `session ${this.deps.sessionId}: masking failed; the text is stored as written: ${errorText(error)}`
      )
      return [...texts]
    }
  }

  private maskOne(text: string, table: RedactionTable, entries: RedactionEntry[]): string {
    if (text.length < 3) return text
    // 默认照发的几类照原样存；策略要它们保持占位符时出口现换。用户照原样发过的值也不换
    const signer = this.deps.host.signer
    const findings = detectSensitive(text, table.known, {
      except: (category, value) =>
        isKeptAsWritten(category) ||
        (table.asWritten.size > 0 && table.asWritten.has(asWrittenKey(signer, value)))
    })
    if (findings.length === 0) return text
    let out = ''
    let last = 0
    for (const f of findings) {
      // 同一个值沿用表里已有的占位符（哪怕这次是另一条规则认出的、归了别的类）
      const known = table.known.get(f.value)
      const placeholder =
        known?.placeholder ??
        placeholderFor(this.deps.host.signer, f.category, f.value, (p) => table.has(p))
      if (!known && !table.has(placeholder)) {
        entries.push({ placeholder, category: f.category, rule: f.rule, value: f.value })
      }
      out += text.slice(last, f.start) + placeholder
      last = f.end
    }
    return out + text.slice(last)
  }

  // ─────────────────────────── 输入框：用户说了算（§14） ───────────────────────────

  /**
   * 输入框发来的几段文本：只把用户交来的 secrets 换成占位符 —— 在用户自己的这条消息里按值整串替换，不看词边界（胶囊
   * 可能紧贴别的字符，`-p` + 密码）；其余照原样，还认得出来的值记成「照原样发」：之后这个会话里写入与出口的检测都放过
   * 它们 —— 模型已经从用户这里看到了，别处再藏只会让它看到同一个值两种写法。
   * 与 maskTexts 不同，**出错就抛**：用户明说要藏的值没藏住，这条消息不能发。
   */
  async maskComposerTexts(
    texts: readonly string[],
    secrets: readonly UserSecret[]
  ): Promise<string[]> {
    const table = await this.table()
    const { entries, replace } = this.secretReplacer(table, secrets)
    const out = texts.map(replace)
    // 默认照发的几类不记：它们本来就照原样存，给不给模型由出口按策略判
    const asWritten: string[] = []
    for (const text of out) {
      for (const f of detectSensitive(text, table.known, { except: isKeptAsWritten })) {
        asWritten.push(asWrittenKey(this.deps.host.signer, f.value))
      }
    }
    await recordRedactions(this.deps.harness, table, entries, this.deps.host.vault, asWritten)
    return out
  }

  /** 输入框发来的用户输入（文本块换、图片不动）与它的显示侧车（内联 Token 的原文、粘贴芯片全文：只换 secrets） */
  async maskComposerInput<D>(
    content: UserInput,
    secrets: readonly UserSecret[],
    display?: D
  ): Promise<{ content: UserInput; display: D | undefined }> {
    const texts =
      typeof content === 'string'
        ? [content]
        : content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    const masked = await this.maskComposerTexts(texts, secrets)
    let i = 0
    const next: UserInput =
      typeof content === 'string'
        ? masked[0]
        : content.map((block) => (block.type === 'text' ? { ...block, text: masked[i++] } : block))
    if (display === undefined || secrets.length === 0) return { content: next, display }
    const { replace } = this.secretReplacer(await this.table(), secrets)
    return { content: next, display: mapStrings(display, replace) as D }
  }

  /** 用户交来的值 → 占位符（表里已有就沿用）与按值整串替换的函数；entries = 要新记的 */
  private secretReplacer(
    table: RedactionTable,
    secrets: readonly UserSecret[]
  ): { entries: RedactionEntry[]; replace: (text: string) => string } {
    const entries: RedactionEntry[] = []
    const placeholders = new Map<string, string>()
    for (const { value, category } of secrets) {
      if (value.length === 0 || placeholders.has(value)) continue
      const known = table.known.get(value)
      const placeholder =
        known?.placeholder ??
        placeholderFor(this.deps.host.signer, category, value, (p) => table.has(p))
      if (!known && !table.has(placeholder)) {
        entries.push({ placeholder, category, rule: USER_RULE, value })
      }
      placeholders.set(value, placeholder)
    }
    if (placeholders.size === 0) return { entries, replace: (text) => text }
    // 长的先试：一个值是另一个的一部分时整串换掉长的
    const pattern = new RegExp(
      [...placeholders.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|'),
      'g'
    )
    return { entries, replace: (text) => text.replace(pattern, (m) => placeholders.get(m)!) }
  }

  /** 这个值是不是用户在输入框里照原样发过的（提示不再提它） */
  async isAsWritten(value: string): Promise<boolean> {
    const table = await this.table()
    return (
      table.asWritten.size > 0 && table.asWritten.has(asWrittenKey(this.deps.host.signer, value))
    )
  }

  /** 用户输入（字符串，或文本块与图片块）：文本部分换掉，图片不动 */
  async maskInput(content: UserInput): Promise<UserInput> {
    if (typeof content === 'string') return this.maskText(content)
    const texts = content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    if (texts.length === 0) return content
    const masked = await this.maskTexts(texts)
    let i = 0
    return content.map((block) => (block.type === 'text' ? { ...block, text: masked[i++] } : block))
  }

  /** JSON 值里的每个字符串都换一遍 */
  async maskJson<T>(value: T): Promise<T> {
    const strings: string[] = []
    collectStrings(value, strings)
    if (strings.length === 0) return value
    const masked = await this.maskTexts(strings)
    let i = 0
    return mapStrings(value, () => masked[i++]) as T
  }

  /** 工具结果：给模型的文本块与给界面的 details 里的字符串 */
  async maskToolResult(result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const output = result.output
      ? await Promise.all(
          result.output.map(async (block) =>
            block.type === 'text' ? { ...block, text: await this.maskText(block.text) } : block
          )
        )
      : undefined
    const details =
      result.details === undefined ? undefined : await this.maskJson(result.details as Json)
    return {
      ...result,
      ...(output === undefined ? {} : { output }),
      ...(details === undefined ? {} : { details })
    }
  }

  // ─────────────────────────── 还原：换回真值 ───────────────────────────

  /**
   * 一个 JSON 值（工具参数）里的占位符换回真值；认得模型写坏的形式。command（可选）：那个字段是命令，真值按占位符所在
   * 的引号环境转义（§14.2）；判不出环境就原样换。转义后的写法不是原文：记进已知值（只在内存里），命令被回显时它也
   * 换得回占位符。
   */
  async restoreJson<T>(value: T, command?: RestoreCommandOptions): Promise<RestoreOutcome<T>> {
    const table = await this.table()
    const restored: string[] = []
    const unavailable: string[] = []
    const restoreOne = (s: string, dialect?: CommandDialect): string => {
      const hits = findPlaceholders(s, (p) => table.has(p))
      if (hits.length === 0) return s
      const contexts: QuoteContext[] | null =
        dialect === undefined ? null : commandQuoteContexts(s, hits, dialect)
      let out = ''
      let last = 0
      hits.forEach((hit, i) => {
        const item = table.get(hit.placeholder)!
        if (item.value === undefined) {
          if (!unavailable.includes(hit.placeholder)) unavailable.push(hit.placeholder)
          return
        }
        if (!restored.includes(item.category)) restored.push(item.category)
        let text = item.value
        if (contexts !== null && dialect !== undefined) {
          text = quoteValue(item.value, contexts[i], dialect)
          if (text !== item.value) {
            table.known.add({
              value: text,
              placeholder: hit.placeholder,
              category: item.category,
              wholeWord: item.rule === USER_RULE
            })
          }
        }
        out += s.slice(last, hit.start) + text
        last = hit.end
      })
      return out + s.slice(last)
    }
    const field = command?.field
    const commandText =
      field !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[field]
        : undefined
    if (typeof commandText !== 'string') {
      return { value: mapStrings(value, (s) => restoreOne(s)) as T, restored, unavailable }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        k === field
          ? restoreOne(commandText, command!.dialect)
          : mapStrings(v, (s) => restoreOne(s))
    }
    return { value: out as T, restored, unavailable }
  }

  // ─────────────────────────── 出口用 ───────────────────────────

  /** 占位符的签名（出口兜底检测新认出的要用） */
  get signer(): PlaceholderSigner {
    return this.deps.host.signer
  }

  /** 把出口兜底新认出的记进对照表 */
  async record(entries: readonly RedactionEntry[]): Promise<void> {
    if (entries.length === 0) return
    await recordRedactions(this.deps.harness, await this.table(), entries, this.deps.host.vault)
  }

  /** provider 会话 id（pi-durable 每个对话一份，随请求的 options 交给模型层）→ 对话 */
  private readonly providerSessions = new Map<string, number>()
  /** 发过请求、但当时 provider 会话 id 还没建的对话（它的第一次请求） */
  private readonly unmappedConversations = new Set<number>()

  /** 生成任务发请求之前记下：这个对话用的是哪个 provider 会话 id（第一次请求时它还没建，留到出口去查） */
  async noteRequest(conversationId: number, providerSessionId: string | undefined): Promise<void> {
    if (providerSessionId === undefined) this.unmappedConversations.add(conversationId)
    else this.providerSessions.set(providerSessionId, conversationId)
  }

  /** 出口问：这次请求来自哪个对话（认不出 → undefined，按根 agent 判） */
  async conversationOf(providerSessionId: string | undefined): Promise<number | undefined> {
    if (providerSessionId === undefined) return undefined
    const known = this.providerSessions.get(providerSessionId)
    if (known !== undefined) return known
    for (const conversationId of this.unmappedConversations) {
      const doc = await this.deps.harness.snapshot(
        ProviderDoc,
        conversationId as ConversationId,
        BG
      )
      if (doc === undefined) continue
      this.unmappedConversations.delete(conversationId)
      this.providerSessions.set(doc.sessionId, conversationId)
      if (doc.sessionId === providerSessionId) return conversationId
    }
    return undefined
  }

  // ─────────────────────────── 跨会话 ───────────────────────────

  /** 内容从 source 流进这条会话：把它引用到的表项一起复制过来（§5.3） */
  async importFrom(source: SessionRedaction, texts: readonly string[]): Promise<void> {
    const entries = entriesReferencedBy(await source.table(), texts)
    if (entries.length === 0) return
    await recordRedactions(this.deps.harness, await this.table(), entries, this.deps.host.vault)
  }
}

/**
 * 生成任务发请求之前记下对话与 provider 会话 id 的对应（出口据此认出这次请求是哪个 agent 发的，§2.5）。
 * 只读，从不改请求（改请求是出口装饰器的事）。
 */
export function redactionRequestHook(redaction: SessionRedaction): HookRegistration {
  return hook(GenerationTask, {
    beforeRequest: async (_request, api, context: Context) => {
      const doc = await api.snapshot(ProviderDoc, api.conversationId, context)
      await redaction.noteRequest(api.conversationId as number, doc?.sessionId)
      return undefined
    }
  })
}

/**
 * 工具结果提交进对话记录之前换成占位符（pi-durable 的 afterTool：看到的已是拼好的最终结果，含流式攒下的
 * 输出）。换的时候出错只记日志、按原样提交 —— 检测器的异常按漏检处理。
 */
export function redactionToolHook(
  redaction: SessionRedaction,
  logger: RuntimeLogger
): HookRegistration {
  return hook(ToolTask, {
    afterTool: async (_call, result, _api, _context: Context) => {
      try {
        return await redaction.maskToolResult(result)
      } catch (error) {
        logger.error(`masking a tool result failed; it is stored as written: ${errorText(error)}`)
        return result
      }
    }
  })
}
