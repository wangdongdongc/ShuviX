/**
 * bot 的决策记录（设计 §9「可观测性与失败呈现」）。
 *
 * 回答的是**「这个 bot 为什么没说话」** —— 一条消息进来之后，每个成员各自经历了什么：
 * 被提及了没有、是不是 mention-only 被跳过、意图判成什么、仲裁赢了还是让了、
 * 在 mailbox 里排了多久、最后收尾是什么结局。
 *
 * 落点 `~/.shuvix/bots/.runs/<bot>/decisions.jsonl`，与该 bot 的 run journal 同目录
 * （`<runId>.jsonl` 由 workflowService 的重定向写进来）。**按 bot 分目录而不是按会话**：
 * 「这个 bot 为什么没说话」是 per-bot 的问题，一个会话级文件会让它变成跨文件对账。
 *
 * 追加写而不是原子写 —— 原子写是覆盖语义，用在这里等于每次只留最后一条。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDefaultBotsDir } from '../../utils/paths'
import { createLogger } from '../../logger'

const log = createLogger('BotJournal')

/** 每个 bot 保留的 run journal 文件数（decisions.jsonl 不在此列） */
const RUN_KEEP = 200
/** decisions.jsonl 的行数上限；超过则截成最后这么多行 */
const DECISIONS_KEEP_LINES = 5000
/** 每写多少条检查一次行数 —— 每条都数一遍整个文件不划算 */
const DECISIONS_CHECK_EVERY = 200

export type BotDecisionKind =
  // L0（这几种根本不产生 run）
  | 'l0_directed'
  | 'l0_clarify_relink'
  | 'l0_mention_only_skipped'
  | 'l0_member_missing'
  | 'cohort_formed'
  // 派发
  | 'pipeline_not_found'
  | 'pipeline_invalid_input'
  | 'pipeline_error'
  // 门控段
  | 'gate_broken'
  | 'gate_timeout'
  | 'gate_fallback'
  | 'degraded_reply'
  | 'recheck_skipped'
  | 'say_blocked'
  // 仲裁
  | 'claim_solo'
  | 'claim_won'
  | 'claim_lost'
  | 'claim_ignored'
  | 'claim_timeout'
  /** 会话被中止时还在等裁决 —— 与 claim_lost 分开，「有人按了停止」不是「输了」 */
  | 'claim_aborted'
  | 'arbitration_bypassed'
  | 'arbitration_lost'
  /** 这一轮 cohort 一个字都没换来 —— 每个成员的文件里各记一条（见 dispatchCohort） */
  | 'cohort_silent'
  // mailbox
  | 'mailbox_queued'
  | 'mailbox_granted'
  | 'mailbox_merged'
  | 'mailbox_timeout'
  | 'mailbox_aborted'
  // 收尾
  | 'run_end'

export interface BotDecisionRecord {
  ts: number
  kind: BotDecisionKind
  sessionId: string
  botName: string
  ticketId: string
  /** meta 回填之后才有 —— 纯粹是一个可交叉引用到 run journal 的别名 */
  runId?: string
  messageSeq?: number
  messageId?: string
  /** 每种 kind 自己的少量事实。**不放整段文本** —— 这里不是转写 */
  detail?: Record<string, unknown>
}

/** 与 agentService / workflowService 同一条文件名净化习语（`..` 这类名不得逃出 .runs） */
export function safeBotDirName(botName: string): string {
  return botName.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '') || '_unknown'
}

/** 某个 bot 的 journal 目录（run 记录与决策记录同放） */
export function botRunsDir(botName: string): string {
  return join(getDefaultBotsDir(), '.runs', safeBotDirName(botName))
}

let sinceCheck = 0

/** 落一条决策记录（绝不抛：可观测性不该拖垮业务路径） */
export function appendBotDecision(record: Omit<BotDecisionRecord, 'ts'>): void {
  try {
    const dir = botRunsDir(record.botName)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'decisions.jsonl')
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...record })}\n`)
    if (++sinceCheck >= DECISIONS_CHECK_EVERY) {
      sinceCheck = 0
      trimDecisions(file)
    }
  } catch (e) {
    log.warn(`决策记录写入失败 (${record.botName}/${record.kind}):`, e)
  }
}

/**
 * 读某会话的决策记录（A4「Bot 决策」子视图的数据源）。
 *
 * 决策记录按 bot 分目录（「这个 bot 为什么没说话」是 per-bot 的问题），会话视角只能
 * 跨全部目录过滤合并 —— 这正是设计 §9 说的「跨文件对账」，收在这一个读函数里，
 * UI 不用知道目录形状。按 ts 升序、尾部截断；坏行/坏目录逐个跳过（追加账本可能
 * 有半截行，可观测性数据坏一条不该丢整页）。
 */
export function readBotDecisions(sessionId: string, limit = 300): BotDecisionRecord[] {
  const root = join(getDefaultBotsDir(), '.runs')
  const out: BotDecisionRecord[] = []
  if (!existsSync(root)) return out
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return out
  }
  for (const dir of dirs) {
    const file = join(root, dir, 'decisions.jsonl')
    if (!existsSync(file)) continue
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue
        try {
          const rec = JSON.parse(line) as BotDecisionRecord
          if (rec && rec.sessionId === sessionId) out.push(rec)
        } catch {
          /* 半截行跳过 */
        }
      }
    } catch {
      /* 单目录读失败跳过 */
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out.slice(-limit)
}

/**
 * 剪掉某个 bot 目录里过旧的 run journal。
 *
 * **不复用 workflowService.pruneRunJournal**：它按 `*.jsonl` 通配，会把 decisions.jsonl
 * 一起算进去 —— 而且要攒够 200 个更新的 run 文件才现形，是那种上线半年后才炸的坑。
 */
export function pruneBotRuns(botName: string): void {
  try {
    const dir = botRunsDir(botName)
    if (!existsSync(dir)) return
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'decisions.jsonl')
    if (files.length <= RUN_KEEP) return
    const stamped = files.map((f) => {
      const path = join(dir, f)
      try {
        return { path, mtime: statSync(path).mtimeMs }
      } catch {
        return { path, mtime: 0 }
      }
    })
    stamped.sort((a, b) => b.mtime - a.mtime)
    for (const { path } of stamped.slice(RUN_KEEP)) {
      try {
        unlinkSync(path)
      } catch {
        /* 并发/权限问题跳过这一个，下次再剪 */
      }
    }
  } catch (e) {
    log.warn(`bot run journal 剪枝失败 (${botName}):`, e)
  }
}

/** decisions.jsonl 按尾部裁剪（它是一个不断追加的单文件，不能靠删文件收口） */
function trimDecisions(file: string): void {
  try {
    // 过滤空串：`split('\n')` 会为尾部换行多出一格，不去掉的话「保留 5000 条」
    // 实际只留 4999 条，断言精确值时会莫名其妙差一
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    if (lines.length <= DECISIONS_KEEP_LINES) return
    writeFileSync(file, `${lines.slice(-DECISIONS_KEEP_LINES).join('\n')}\n`)
  } catch (e) {
    log.warn(`决策记录裁剪失败 (${file}):`, e)
  }
}

/** 仅供单测：重置行数检查的计数器 */
export function resetDecisionCounterForTests(): void {
  sinceCheck = 0
}
