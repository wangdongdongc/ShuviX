/**
 * 日期通知 —— 「两通道规则」里时间线那一条通道（裁决 Q14；Mapping #5 prompt）。
 *
 * 文档变化走系统提示词的段落增量；时间线上的事件（跨天、隔了很久才回来）走**追加的通知条目**：
 * 在新的一天里第一次用户输入之前，先往对话里写一条 `shuvix.notice`（kind `date`）——
 *
 *   `<date-change>Today is 2026-10-05 (Monday). The previous message in this conversation was about 30 hours ago.</date-change>`
 *
 * 系统提示词里的日期属于冻结的人设（创建 agent 那天），不随跨天重发：改系统提示词会打穿提供商的
 * 提示词缓存，而一条追加的用户角色消息在任何模型上都便宜。「上次告知模型的日期」记在对话文档
 * `AgentStateDoc.lastAnnouncedDate`（rewindable + asOf：回退 fork 回到 fork 点时的值，于是 fork
 * 上会重新告知）。
 *
 * 写入走 `DurableSession.writeNotice`：空闲当场落条目、忙时排进收件箱（边界上写入先于用户消息）、
 * 被中断 / 空闲但留着失败输入时推迟（下一次发送之前送达）—— 三种情况下都排在这次用户输入之前。
 * requestId `shuvix:date:<conversationId>:<date>` 让「写了通知、还没记下日期就崩了」的重试不重复。
 */
import type { Conversation, EntryRecord } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, NoticeEntry } from '../docs'
import type { DurableSession, NoticeResult } from '../durableSession'

/** 通知条目的 `data.kind` */
export const DATE_NOTICE_KIND = 'date'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const HOUR_MS = 3_600_000
/** 从这个间隔起按天说 */
const DAYS_FROM_HOURS = 48
/** 找「上一条消息」时最多回看的条目数（尾部几乎总是 user / assistant / 工具结果） */
const ACTIVITY_SCAN_LIMIT = 32

/** 一个 `YYYY-MM-DD` 日历日期的星期（英文；按日历算，与时区无关）。不是真实日期就抛错 */
export function weekdayOf(date: string): string {
  const match = ISO_DATE.exec(date)
  if (match !== null) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const at = new Date(Date.UTC(year, month - 1, day))
    if (at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day) {
      return WEEKDAYS[at.getUTCDay()]!
    }
  }
  throw new Error(`Not a calendar date (YYYY-MM-DD): ${JSON.stringify(date)}`)
}

/** 本地时区的日历日期 `YYYY-MM-DD`（桌面给 `SessionHostDeps.today` 用） */
export function localDate(ms: number = Date.now()): string {
  const day = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** 「about N hours / days ago」；没有上一条消息的时间（或时间不可信：未来、非有限数）→ undefined */
function elapsedPhrase(previousAt: number | undefined, now: number): string | undefined {
  if (previousAt === undefined || !Number.isFinite(previousAt) || !Number.isFinite(now)) {
    return undefined
  }
  const elapsed = now - previousAt
  if (elapsed < 0) return undefined
  const hours = elapsed / HOUR_MS
  if (hours >= DAYS_FROM_HOURS) return `about ${Math.round(hours / 24)} days ago`
  const rounded = Math.max(1, Math.round(hours))
  return `about ${rounded} ${rounded === 1 ? 'hour' : 'hours'} ago`
}

/**
 * 日期通知的文本（裁决 Q14，模型可见的英文）：
 * `<date-change>Today is YYYY-MM-DD (Weekday). The previous message in this conversation was about N hours ago.</date-change>`
 * 间隔 ≥ 48 小时按天说；不足一小时按 1 小时；没有上一条消息的时间则省掉第二句。
 */
export function renderDateNotice(
  date: string,
  previousAt: number | undefined,
  now: number
): string {
  const today = `Today is ${date} (${weekdayOf(date)}).`
  const elapsed = elapsedPhrase(previousAt, now)
  const previous =
    elapsed === undefined ? '' : ` The previous message in this conversation was ${elapsed}.`
  return `<date-change>${today}${previous}</date-change>`
}

/** 同一对话同一天的通知只落一条（durable 按 requestId 去重；推迟队列同样按它去重） */
export function dateNoticeRequestId(conversationId: number, date: string): string {
  return `shuvix:date:${conversationId}:${date}`
}

/** 一条条目里「消息」的时间：user / assistant / 工具结果的最大 timestamp（system 不算） */
function messageTime(entry: EntryRecord): number | undefined {
  let latest: number | undefined
  for (const message of entry.model ?? []) {
    if (message.role === 'system') continue
    const at = message.timestamp
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) {
      latest = latest === undefined ? at : Math.max(latest, at)
    }
  }
  return latest
}

/** 一条条目若是日期通知，取它告知的日期 */
function announcedDateOf(entry: EntryRecord): string | undefined {
  if (!NoticeEntry.is(entry) || entry.data.kind !== DATE_NOTICE_KIND) return undefined
  const date = entry.data.date
  return typeof date === 'string' ? date : undefined
}

export interface ConversationActivity {
  /** 对话里有没有条目（fork 感知） */
  hasEntries: boolean
  /** 最近一条消息（user / assistant / 工具结果 / 通知）的时间 */
  lastActivityAt?: number
  /** 最近若干条目里出现过的日期通知的日期 */
  announcedDates: string[]
}

/** 对话里有没有条目、最近一条消息是什么时候、最近告知过哪些日期（最新在前地回看一页） */
export async function conversationActivity(
  conversation: Conversation
): Promise<ConversationActivity> {
  const page = await conversation.entries({}, ACTIVITY_SCAN_LIMIT, undefined, BG)
  const activity: ConversationActivity = {
    hasEntries: page.items.length > 0,
    announcedDates: []
  }
  for (const entry of page.items) {
    activity.lastActivityAt ??= messageTime(entry)
    const date = announcedDateOf(entry)
    if (date !== undefined) activity.announcedDates.push(date)
  }
  return activity
}

export interface DateAnnounceOptions {
  /** 今天的本地日期 `YYYY-MM-DD` */
  today: string
  /** 此刻（毫秒） */
  now: number
  /** 上一条消息的时间；缺省从对话条目里找 */
  lastActivityAt?: number
}

export type DateAnnouncement =
  /** 今天已经告知过（或已记下） */
  | { status: 'current' }
  /** 只记下日期、不写通知：对话还没有条目（人设里冻结的就是今天），或尾部已有今天的通知 */
  | { status: 'recorded' }
  /** 写了通知（当场落条目 / 排进收件箱），或存进推迟队列，并记下了日期 */
  | { status: 'announced' | 'deferred'; requestId: string; text: string }
  /** 写通知失败（会话关了 / 提交失败）：日期没记下，下一次输入再试 */
  | { status: 'closed' | 'failed'; requestId: string; error?: string }

/**
 * 一次用户输入之前调用：对话已有条目且今天还没告知过 → 写日期通知，再记下 `lastAnnouncedDate`。
 * 对话还没有条目 → 只记下日期（人设里冻结的就是今天）。`conversation` 必须是会话的当前对话
 * （通知经 `writeNotice` 写进当前对话；不是就抛错，而不是把通知写到别处）。
 *
 * 「告知过」看两处：文档里的日期，以及对话尾部是否已有今天的日期通知。后者不可少 —— durable 的
 * asOf fork 拿的是 fork 点那个条目**提交时**的文档值，而日期是在通知落下之后的另一个提交里记的：
 * 回退到「编辑那条用户消息」时 fork 点恰好是通知条目本身，fork 上的文档还是旧日期，但通知已经在
 * 它的历史里了（写了通知、还没记下日期就崩了也是同一个形状）。这时只补记日期，不重复告知。
 * fork 在通知之前的点则两处都没有今天 → 在 fork 上重新告知（requestId 带对话 id，各算各的）。
 */
export async function maybeAnnounceDate(
  session: Pick<DurableSession, 'writeNotice' | 'harness' | 'currentConversation'>,
  conversation: Conversation,
  options: DateAnnounceOptions
): Promise<DateAnnouncement> {
  const { today, now } = options
  weekdayOf(today)
  // 通知经 writeNotice 写进（或推迟后送进）会话的**当前**对话 —— 对着别的对话判定只会把通知写错地方
  const current = await session.currentConversation()
  if (current.id !== conversation.id) {
    throw new Error(
      `maybeAnnounceDate: conversation ${conversation.id} is not the current conversation (${current.id})`
    )
  }
  const state = await session.harness.snapshot(AgentStateDoc, conversation.id, BG)
  if (state?.lastAnnouncedDate === today) return { status: 'current' }
  const activity = await conversationActivity(conversation)
  if (!activity.hasEntries || activity.announcedDates.includes(today)) {
    await recordAnnounced(conversation, today)
    return { status: 'recorded' }
  }
  const requestId = dateNoticeRequestId(conversation.id, today)
  const text = renderDateNotice(today, options.lastActivityAt ?? activity.lastActivityAt, now)
  const result: NoticeResult = await session.writeNotice({
    text,
    kind: DATE_NOTICE_KIND,
    requestId,
    data: { date: today }
  })
  if (result.status === 'closed' || result.status === 'failed') {
    return {
      status: result.status,
      requestId,
      ...(result.error === undefined ? {} : { error: result.error })
    }
  }
  await recordAnnounced(conversation, today)
  return { status: result.status === 'deferred' ? 'deferred' : 'announced', requestId, text }
}

async function recordAnnounced(conversation: Conversation, today: string): Promise<void> {
  await conversation.commit(async (tx) => {
    const state = await tx.doc(AgentStateDoc, conversation.id)
    if (state.lastAnnouncedDate !== today) state.lastAnnouncedDate = today
  }, BG)
}
