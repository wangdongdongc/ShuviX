/**
 * 一条会话的脱敏（docs/auto-redaction-design.md §2）：写入对话记录之前把认出的内容换成占位符、记进对照表；
 * 工具执行之前把参数里的占位符换回真值。宿主无关：占位符怎么签、真值怎么加密由宿主交进来（RedactionHost）。
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
import { detectSensitive } from '../redaction/detect'
import { findPlaceholders, makePlaceholder, type PlaceholderSigner } from '../redaction/placeholder'
import type { RuntimeLogger } from '../types'
import { backgroundContext as BG, errorText } from './context'
import {
  entriesReferencedBy,
  loadRedactionTable,
  recordRedactions,
  type RedactionEntry,
  type RedactionTable,
  type RedactionVault
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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

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
    const findings = detectSensitive(text, table.known)
    if (findings.length === 0) return text
    let out = ''
    let last = 0
    for (const f of findings) {
      // 同一个值沿用表里已有的占位符（哪怕这次是另一条规则认出的、归了别的类）
      const known = table.known.get(f.value)
      const placeholder =
        known?.placeholder ?? makePlaceholder(this.deps.host.signer, f.category, f.value)
      if (!known && !table.has(placeholder)) {
        entries.push({ placeholder, category: f.category, rule: f.rule, value: f.value })
      }
      out += text.slice(last, f.start) + placeholder
      last = f.end
    }
    return out + text.slice(last)
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

  /** 一个 JSON 值（工具参数）里的占位符换回真值；认得模型写坏的形式 */
  async restoreJson<T>(value: T): Promise<RestoreOutcome<T>> {
    const table = await this.table()
    const restored: string[] = []
    const unavailable: string[] = []
    const restoreOne = (s: string): string => {
      const hits = findPlaceholders(s, (p) => table.has(p))
      if (hits.length === 0) return s
      let out = ''
      let last = 0
      for (const hit of hits) {
        const item = table.get(hit.placeholder)!
        if (item.value === undefined) {
          if (!unavailable.includes(hit.placeholder)) unavailable.push(hit.placeholder)
          continue
        }
        if (!restored.includes(item.category)) restored.push(item.category)
        out += s.slice(last, hit.start) + item.value
        last = hit.end
      }
      return out + s.slice(last)
    }
    return { value: mapStrings(value, restoreOne) as T, restored, unavailable }
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
