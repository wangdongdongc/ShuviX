/**
 * 回复里 ```artifact 引用钉下的版本（`ArtifactPinsDoc`）—— 文档的读写，与「这次工具调用是哪条回复发起的」
 * 「这一轮的终答是哪条」这两个转写查找。
 *
 * 宿主无关：钉什么（产物在哪个目录、内容怎么存、存成哪个哈希）由宿主算好交进来，这里只认条目、读写文档。
 * 不依赖 Node / Electron。
 *
 * **按条目自己的对话记、按条目查**：一条回复的钉记在写下它的那个对话的文档里（`entry.conversationId`）。
 * 回退出来的新分支看得见旧分支前缀里的回复，查的时候先在当前对话里找到那条条目、再去它自己的对话里读 ——
 * 不依赖文档在 fork 时带不带过去。
 */
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
  JsonObject
} from '@earendil-works/pi-durable'
import { AssistantEntry } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from './context'
import { ArtifactPinsDoc } from './docs'

/**
 * 钉下的一件：哪个文件、哪一份内容（内容哈希），以及产物在不在一场子会话的目录里。
 *
 * `subSessionId` 缺省 = 写下这条回复的那场会话自己的目录 —— **不记自己的会话 id**：会话 fork 时存储与产物
 * 目录整拷，fork 里读到的钉要落到 fork 自己的那份上，记死源会话 id 就会去读源会话的。子会话不随 fork 拷，
 * 它们的产物只有一份，记子会话 id。
 */
export type ArtifactPin = {
  file: string
  oid: string
  subSessionId?: string
}

/** 一条回复：条目身份 + 正文（text 块，按序） + 它有没有发起工具调用 */
export type ArtifactReply = {
  entryId: EntryId
  conversationId: ConversationId
  texts: string[]
  hasToolCalls: boolean
}

/** 往回看几页找发起调用的那条回复（并行的工具结果可能插在它后面） */
const SCAN_PAGE = 32
const SCAN_PAGES = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blocksOf(entry: EntryRecord): unknown[] {
  const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? content : []
}

function callIdsOf(entry: EntryRecord): string[] {
  return blocksOf(entry)
    .filter((b) => isRecord(b) && b.type === 'toolCall' && typeof b.id === 'string')
    .map((b) => (b as { id: string }).id)
}

function replyOf(entry: EntryRecord): ArtifactReply {
  const blocks = blocksOf(entry).filter(isRecord)
  return {
    entryId: entry.id,
    conversationId: entry.conversationId,
    texts: blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string),
    hasToolCalls: blocks.some((b) => b.type === 'toolCall')
  }
}

/**
 * 发起这次工具调用的那条回复：对话历史（新的在前）里最新的一条助手条目，且它的 toolCall 里有 `callId`。
 * 最新的助手条目不是它 → undefined（调用总是由最新那条发起的，认不出就不猜）。
 */
export async function findCallingReply(
  harness: Harness,
  conversationId: ConversationId,
  callId: string
): Promise<ArtifactReply | undefined> {
  const conversation = await harness.conversation(conversationId, BG)
  if (conversation === undefined) return undefined
  let cursor: Cursor | undefined
  for (let i = 0; i < SCAN_PAGES; i++) {
    const page = await conversation.entries({}, SCAN_PAGE, cursor, BG)
    const latest = page.items.find((entry) => entry.kind === AssistantEntry.kind)
    if (latest !== undefined)
      return callIdsOf(latest).includes(callId) ? replyOf(latest) : undefined
    if (page.next === undefined) return undefined
    cursor = page.next
  }
  return undefined
}

/**
 * 一轮的终答：对话里最新的一条助手条目，且它不带工具调用。它后面可以已经排进了别的条目（追加的消息、通知）——
 * 文件只会被工具改，而工具只能由更新的助手条目发起，所以只要最新的助手条目没有发起调用，此刻的文件就还是
 * 它写下时的样子。最新的助手条目发起过调用 → undefined（那条已在工具执行前钉过）。
 */
export async function findFinalReply(
  harness: Harness,
  conversationId: ConversationId
): Promise<ArtifactReply | undefined> {
  const conversation = await harness.conversation(conversationId, BG)
  if (conversation === undefined) return undefined
  let cursor: Cursor | undefined
  for (let i = 0; i < SCAN_PAGES; i++) {
    const page = await conversation.entries({}, SCAN_PAGE, cursor, BG)
    const latest = page.items.find((entry) => entry.kind === AssistantEntry.kind)
    if (latest !== undefined) {
      const reply = replyOf(latest)
      return reply.hasToolCalls ? undefined : reply
    }
    if (page.next === undefined) return undefined
    cursor = page.next
  }
  return undefined
}

function pinOf(value: unknown): ArtifactPin | undefined {
  if (!isRecord(value)) return undefined
  const { file, oid, subSessionId } = value
  if (typeof file !== 'string' || typeof oid !== 'string') return undefined
  if (subSessionId === undefined) return { file, oid }
  return typeof subSessionId === 'string' ? { file, oid, subSessionId } : undefined
}

/** 一条回复钉过没有（不管钉了几件；钉一次就不再改） */
export async function hasArtifactPins(
  harness: Harness,
  conversationId: ConversationId,
  entryId: EntryId
): Promise<boolean> {
  const doc = await harness.snapshot(ArtifactPinsDoc, conversationId, BG)
  return doc?.items[String(entryId)] !== undefined
}

/**
 * 记下一条回复的钉（名字 → 钉）。已经钉过就原样不动 —— 同一条回复的并行工具调用各自来钉一次，先到的算；
 * 钉下的永远是它写完那一刻的样子。返回这次有没有写。
 */
export async function writeArtifactPins(
  harness: Harness,
  conversationId: ConversationId,
  entryId: EntryId,
  pins: Readonly<Record<string, ArtifactPin>>
): Promise<boolean> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(ArtifactPinsDoc, conversationId)
    const key = String(entryId)
    if (doc.items[key] !== undefined) return false
    const item: { [name: string]: JsonObject } = {}
    for (const [name, pin] of Object.entries(pins)) {
      item[name] =
        pin.subSessionId === undefined
          ? { file: pin.file, oid: pin.oid }
          : { file: pin.file, oid: pin.oid, subSessionId: pin.subSessionId }
    }
    doc.items[key] = item
    return true
  }, BG)
}

/**
 * 当前对话里看得见的一条回复钉下的名字 → 钉：先在当前对话（fork 感知）里找到这条条目，再读它自己的对话的
 * 文档。条目不在（被放弃的分支、别的对话、id 不对）或没钉过 → undefined；认不出形状的项略过。
 */
export async function readArtifactPins(
  harness: Harness,
  currentConversationId: ConversationId,
  entryId: number
): Promise<Record<string, ArtifactPin> | undefined> {
  if (!Number.isSafeInteger(entryId) || entryId <= 0) return undefined
  const conversation = await harness.conversation(currentConversationId, BG)
  if (conversation === undefined) return undefined
  const id = entryId as EntryId
  const entry = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BG))
    .items[0]
  if (entry === undefined || entry.id !== id || entry.kind !== AssistantEntry.kind) return undefined
  const doc = await harness.snapshot(ArtifactPinsDoc, entry.conversationId, BG)
  const item = doc?.items[String(id)]
  if (item === undefined) return undefined
  const pins: Record<string, ArtifactPin> = {}
  for (const [name, value] of Object.entries(item)) {
    const pin = pinOf(value)
    if (pin !== undefined) pins[name] = pin
  }
  return pins
}
