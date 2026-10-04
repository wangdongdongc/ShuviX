/**
 * ShuviX 自己的 durable 文档与条目定义（与 pi 的 `pi.*` 文档并列存在会话存储里）。
 *
 * - `SessionStateDoc`（scope session）：整条会话的指针与暂存 —— 当前对话（`currentConversation`，
 *   回退 fork 之后由它指向新分支）、根 agent 的锁（P1-09 写入）、被推迟送达的系统通知。
 *   **它是锁与当前分支的权威来源**（裁决 Q7），DB 里的镜像只为了界面便宜地读。
 * - `AgentStateDoc`（每个对话，rewindable + asOf）：这个对话的 agent 是什么（种类、档案名、冻结的
 *   人设、指令文件、上次告知模型的日期）。P1-08 / P1-09 填写；fork 拿到 fork 点时的值。
 * - `DisplayDoc`（每个对话，rewindable + asOf）：内联 Token 等显示侧车，按 submission 的
 *   requestId 索引（第三阶段再解析到 entry）。回退 fork 保留前缀的显示侧车。
 * - `NoticeEntry`（`shuvix.notice`）：系统写给模型的通知（后台任务完成、日期变更……）。
 *   model 是一条 user 角色消息（模型必须看见它），条目种类让投影把它渲染成通知而不是用户发言 ——
 *   **转写不得把系统写的话记成用户说的**。
 *
 * 三份文档都在每个创建 / fork 对话的提交里补种（`seedConversationDocs`，挂在
 * `HarnessOptions.conversationCreated` 上）：已存在的文档原样保留，绝不重置会话状态。
 */
import { copyJson, type JsonValue } from '@earendil-works/chord'
import {
  defineDoc,
  defineEntry,
  type ConversationId,
  type ConversationRecord,
  type EntryDraft,
  type JsonObject,
  type Tx
} from '@earendil-works/pi-durable'

/** 一条被推迟送达的系统通知（会话被中断、或空闲但收件箱里还留着上次失败的输入） */
export type DeferredNotice = {
  /** 幂等键：同一 requestId 只会存一份、只会落一条条目 */
  requestId: string
  text: string
  /** 通知种类（`background` / `date` / …），原样进 `NoticeEntry.data.kind` */
  kind: string
  data?: JsonObject
}

export type SessionState = {
  /** 当前对话；缺省 = 根对话。指向不存在的对话时回退到根（并记警告） */
  currentConversation?: ConversationId
  /** 根 agent 的锁记录（P1-09 定型；这里只占位） */
  lock?: JsonObject
  /** 待送达的通知，按到达顺序；送达（进收件箱或落条目）的同一提交里移除 */
  deferredNotices: DeferredNotice[]
}

export const SessionStateDoc = defineDoc<SessionState>({
  kind: 'shuvix.session-state',
  version: 1,
  scope: 'session',
  initial: () => ({ deferredNotices: [] })
})

export type AgentStateRecord = {
  kind?: 'root' | 'spawned'
  profileName?: string
  /** 创建 agent 时冻结的人设正文（P1-08） */
  persona?: string
  instructionFiles?: string[]
  /** 上次以日期通知告知模型的日期（YYYY-MM-DD，裁决 Q14） */
  lastAnnouncedDate?: string
}

export const AgentStateDoc = defineDoc<AgentStateRecord>({
  kind: 'shuvix.agent-state',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({})
})

export type DisplayState = {
  /** requestId → 显示侧车（形状由宿主决定，JSON） */
  items: { [requestId: string]: JsonObject }
}

export const DisplayDoc = defineDoc<DisplayState>({
  kind: 'shuvix.display',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ items: {} })
})

export type NoticeData = { kind: string; [key: string]: JsonValue }

export const NoticeEntry = defineEntry<NoticeData>('shuvix.notice')

/** 通知条目的草稿：一条 user 消息 + `data.kind` */
export function noticeEntryDraft(
  notice: { readonly text: string; readonly kind: string; readonly data?: JsonObject },
  timestamp: number
): EntryDraft {
  const data = copyJson({ ...notice.data, kind: notice.kind }, { omitUndefinedProperties: true })
  return {
    kind: NoticeEntry.kind,
    model: [{ role: 'user', content: notice.text, timestamp }],
    data
  }
}

/**
 * 每个创建 / fork 对话的提交里补种 ShuviX 文档（`HarnessOptions.conversationCreated`）。
 * `tx.doc()` 对已存在的文档返回原值 —— fork 拿到的 asOf 副本、会话级状态都不会被重置。
 */
export async function seedConversationDocs(tx: Tx, record: ConversationRecord): Promise<void> {
  await tx.doc(SessionStateDoc)
  await tx.doc(AgentStateDoc, record.id)
  await tx.doc(DisplayDoc, record.id)
}
