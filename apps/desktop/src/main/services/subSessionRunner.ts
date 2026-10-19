/**
 * 子会话运行器 —— agent 经 `session` 工具自建会话、代替用户往里发消息（设计：docs/sub-session-design.md）。
 *
 * 子会话**就是一条普通会话**：产品行为一致，只多一个 `parentId`。因此本文件刻意薄 ——
 * 它只做几件既有机制表达不了的事：
 *
 *  1. **形态准入**：谁能当父（普通会话）、谁能被驱动（必须是调用方自己的子会话）。
 *     越权在这里落空，工具层只负责把拒绝理由翻译给模型。
 *  2. **派活一律后台**（§20）：`prompt` / `answer` 只等「确认发出去了」的 50ms 就回执；要答复只有 `wait`
 *     （挂住、有一条停下来问就返回、超时什么都不停）。
 *  3. **记账交给后台任务枢纽**：一次 `prompt` 就是一个任务（`services/taskRegistry`），任务 id 就是
 *     这次发送的幂等键 `subsession:<父会话>:<工具任务>`（P2-10）。回执是同一个 `join` 只等确认窗。
 *  4. **完成通知只有一条路**（P2-10 PIN-01）：子会话的 driven-run 标记落定 → 运行时的
 *     `onDrivenSettled` → 这里决定通不通知、经 `sessionService.deliverSubSessionNotice` 送达父会话
 *     （带 `subsession-done:<子会话>:<submission>`，跨进程按它去重）。枢纽自己的通知对子会话任务是关的。
 *     不通知的情形：`wait` 握着它 / 已经在同一轮里交回了它、是智能体自己停的（stop / 同一父会话的新消息顶掉了它）。
 *     过了确认窗才发现没发出去的，由 `settle` 另发一条（`subsession-undelivered:…`）。
 *     **能叫醒父会话的只有本进程发起、还记着的驱动**（`records` 里的那些）：
 *     本进程不认得的（上个进程发起的、子会话打开时扫描重报的）只写一条通知进父会话的转写，不起一轮 ——
 *     父会话的下一轮看得见它（option A：重启之后被搁着的父会话不该被叫醒）。
 *  5. **崩溃之后的重跑**（P2-10，Q-P2-01/02）：`session` 工具是 replay `safe`，每个动作都幂等 ——
 *     `prompt` 先问子会话认不认得这个幂等键：已落定 → 回执「已经结束」；没落定 → 重新挂上（被中断就续上），
 *     从不再发一条；`wait` 重跑时续上被中断的目标再等。没在 `wait` 的父会话，「继续」不再把子会话带起来（§20）。
 *  6. **上限**：并发 4 / 总数 20，防的是无人值守的循环，不是正常使用。
 *  7. **父会话介入自己发起的那一轮**（docs/sub-session-design.md §19）：这一轮绑定的后台任务（`runs` 里的
 *     那条、任务还活着）就是判据 —— 子会话弹出询问时它进「等待输入」（`onAskRaised` / `onAskResolved`，
 *     main 入口经 `setSessionAskObserver` 接进来），确认窗里的 `prompt` / `answer` 当场把询问交回，没人等就经
 *     枢纽通知父会话（`inputNotice`）；`answer` 代答 ask 工具的选择题（权限卡除外），`steer` 往这一轮里插话。
 *     没有绑定任务（用户自己发起的一轮、这一轮已经结束、重启之后）→ 不通知、不能代答、不能插话。
 *
 * **发送必须走 `chatGateway.prompt`**（IPC `agent:prompt` 的同一个函数）。懒创建运行时、
 * 用户消息落树（各前端经会话视图看到）、埋点、auto-title、自动压缩，全部因此照常发生。
 * 任何绕过这道门的实现都会让「子会话表现与普通会话一致」从第一天起就带例外。
 *
 * **派活一律是后台语义**（§20，2026-10-17 用户裁决）：`prompt` / `answer` 只回执，跑完经完成通知、停下来问经这一轮的
 * 后台任务把父会话叫回来；要在这一轮里拿答复只有 `wait`。父会话被停止**不**级联到任何子会话（与 bash 后台任务一致；
 * 原来「前台那一轮跟着父会话停」的级联与中止前 seam 里的 `cascadeParentAbort` 一并删了）。
 */
import { chatGateway } from '../frontend/core'
import { sessionService } from './sessionService'
import { taskRegistry } from './taskRegistry'
import { messageService } from './messageService'
import { recordSessionModel, recordSessionThinkingLevel, isDurableSession } from './sessionStorage'
import { isLegacySession } from './legacySession'
import { sessionRecords } from './sessionRecords'
import type { AgentSession } from './agentSession'
import { authorsOf, buildSessionOutline } from '@shuvix/agent-runtime'
import type {
  DrivenSettledEvent,
  JoinOutcome,
  OutlineQuery,
  OutlineResult,
  SubAgentModelConfig,
  SubmitResult,
  TaskInfo
} from '@shuvix/agent-runtime'
import type {
  ChoiceInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { createLogger } from '../logger'
import {
  approvalSummary,
  attrValue,
  renderPendingAsks,
  type PendingAskInfo
} from './subSessionText'

export type { PendingAskInfo } from './subSessionText'

const log = createLogger('SubSession')

/** 一个父会话最多同时在跑的子会话数。bg 任务是 8，这里取一半 —— 一条 LLM 会话远贵于一个进程 */
export const MAX_RUNNING_SUB_SESSIONS = 4
/** 一个父会话最多拥有的子会话数（只数未删除的） */
export const MAX_SUB_SESSIONS = 20
/**
 * 后台形态回执前的「确认发出去了」窗口。只等这么久 —— 发送失败（拒 busy）是同步就
 * 落定的，而正常发出去的那一路会一直跑到轮结束，不能在这里等它。
 */
const SEND_CONFIRM_MS = 50

/** `wait-for-sub-sessions` 的缺省上限（秒）。到点交回，不中止任何子会话 */
export const DEFAULT_WAIT_TIMEOUT_SEC = 300

/**
 * 没发出去的那几类结果（PIN-02）：忙、模型被拒、会话已关、还排着队 —— 以及没有分类的错误（网关打不开
 * 会话、类型冲突），它们同样没碰到子会话。模型请求失败 / run 意外失败 / 接不上都是**发出去了**，
 * 那一轮以错误收场 —— 那是答复（带 isError），不是「没发出去」。
 */
const NOT_DELIVERED = new Set(['busy', 'no_model', 'closed', 'queued'])

export type SubSessionStatus = 'idle' | 'running' | 'waiting-input' | 'interrupted'

export interface SubSessionInfo {
  id: string
  title: string
  status: SubSessionStatus
  /** 本进程是否正在替父会话驱动它（用户自己在里面发消息时为 false，status 仍是 running；进程内记账，PIN-15） */
  driven: boolean
  updatedAt: number
  /**
   * `waiting-input` 时它到底卡在什么问题上（待答询问的人读摘要）。
   *
   * 没有这个，父级读到的只是「在等用户回答」——**它无从判断该做什么**：实测里模型
   * 因此把这个状态当成「子代理自己爱提问」，反复改提示词说「不要提问、直接执行」，
   * 换了四条子会话都一样，因为真正的原因是**应用在等人点一下批准**，而那件事只有
   * 用户能做、父级做不了。
   */
  blockedOn?: string[]
  /**
   * 挂着的询问，完整的（§19.4）：选择题带问题与选项、能不能由父会话代答；权限卡只有摘要（只能转告）。
   * 只看开着的会话；没有挂着的 → undefined。
   */
  pendingAsks?: PendingAskInfo[]
  /**
   * 父会话最近一次发进去的消息之后，用户自己在子会话里说过话（§19.7）—— 答复解释不了过程的最常见原因，
   * 也是 `inspect-sub-session` 值得一看的信号。只在 read / wait / 前台答复这几条路上算（要读一次视图）。
   */
  userIntervened?: boolean
}

/** 子会话这一轮答复的那几个字段（read / wait / 前台 prompt 共用） */
export interface AnswerFields {
  answer?: string
  isError?: boolean
}

export interface WaitOutcome {
  /**
   * 'settled' = 全部跑完；'asking' = 有人停下来问了一个**父会话能代答**的问题（§19.4）；
   * 'blocked' = 有人卡在**只有用户能答**的询问上（批准卡、用户自己发起那一轮里的提问）—— 都不是"完成"，
   * 报成 settled 会让父级以为成了（实测里它就是这么被骗过去的）；
   * 'timeout' = 到点仍有在跑的；'aborted' = 父会话被停止。
   */
  kind: 'settled' | 'asking' | 'blocked' | 'timeout' | 'aborted'
  /** 等待期间关注的每条子会话（含最终状态与最新答复） */
  results: Array<SubSessionInfo & AnswerFields>
}

/**
 * `prompt` / `answer` 的结果 —— **一律是回执**（§20：派活默认就是后台语义，要在这一轮里拿答复只有 `wait`）。
 * 'started' = 发出去了、在跑；'input' = 确认窗里子会话就停下来问了一句（`info.pendingAsks` 里是那几条询问；
 * 这一轮仍在 —— 答了之后接着跑，跑完照常通知）。
 */
export interface PromptOutcome {
  /** 'finished' = 崩溃之后重跑时那一轮早就落定了（没再发；答复在子会话里，用 read / wait 收） */
  kind: 'started' | 'input' | 'finished'
  /** 落定的子会话 id —— `sub_session_id` 省略时被自动补全成的那条，回执围栏要用真实 id */
  id: string
  /** kind==='input' 时子会话的快照（带着询问） */
  info?: SubSessionInfo
}

/** 本进程正在驱动的一次子会话发送 */
interface DrivenRun {
  parentId: string
  /** 幂等键 = 后台任务枢纽里的任务 id */
  requestId: string
  /**
   * 整轮结束的 promise（永不 reject）。结果原样是运行时的 `SubmitResult`：`code` 区分**没发出去**
   * （忙、模型被拒……）与「发出去了、那一轮以错误收场」—— 混为一谈会让调用方以为消息排上了队。
   */
  done: Promise<SubmitResult>
}

/**
 * 本进程发出的一次发送（按幂等键记，靠对象身份认）：它在，就说明这次驱动是本进程发起、还记着的 —— 落定时该通知、
 * 能叫醒父会话。派活一律是后台语义（§20），没有「有人在前台等着它」这一档。
 */
interface DriveRecord {
  readonly requestId: string
}

/**
 * 父会话最近一次发进去的消息之后，用户自己说过话吗：用与自动审查、大纲同一个判法（`authorsOf`：第一条有来源记录的
 * 消息之后、没有记录的才算人打的；系统通知不算）—— 升级之前没有记录的子会话不会每次都报「用户插过话」。
 */
function intervenedIn(
  messages: ReadonlyArray<{ id: string; role: string; metadata?: unknown }>,
  sources: ReadonlyMap<string, unknown>
): boolean {
  const users = messages.filter((m) => {
    if (m.role !== 'user') return false
    const meta = m.metadata as
      | { isSystemNotice?: boolean; isInstructionInjection?: boolean }
      | null
      | undefined
    return !(meta?.isSystemNotice || meta?.isInstructionInjection)
  })
  const authors = authorsOf(users, (m) => sources.has(m.id))
  // 最近的一条用户消息是人打的（父会话发的、或分不清 → 没有）
  const last = users[users.length - 1]
  return last !== undefined && authors.get(last) === 'human'
}

class SubSessionRunner {
  private runs = new Map<string, DrivenRun>()
  /** 正在准入的子会话（同步占位：异步判定之前就占住，见 prompt） */
  private claiming = new Set<string>()
  /** 本进程发出的、完成通知还没处理的那几次发送（按幂等键） */
  private records = new Map<string, DriveRecord>()
  /** 已经在同一轮里交回去的落定（前台答复 / wait 的结果）：它们的完成通知不再发 */
  private inBand = new Set<string>()
  /** 智能体自己停掉的那几轮（stop / 中断父会话的级联）：不通知 —— 停它的就是父级，它早就知道 */
  private agentStopped = new Set<string>()
  /** 被同一父会话的新消息顶掉的那一轮（abort-then-send，PIN-19）：不通知 */
  private superseded = new Set<string>()
  /** 正在被 `wait` 等着的子会话（计数：可能有几个 wait 同时握着它） */
  private waiters = new Map<string, number>()
  /**
   * 还在确认窗里的发送（按幂等键）：这时「没发出去」由那次调用自己报。过了确认窗才落定为「没发出去」的（打开会话慢、
   * 模型解析慢……）没人等着报 —— 由 `settle` 单独通知父会话，否则它会以为活在跑、永远等不到回音（§20）
   */
  private confirming = new Set<string>()
  /**
   * 最近一次驱动以错误收场、却没有留下助手条目的子会话（子会话 id → 错误原文）：`read` / `wait` 拿不到答复时
   * 用它，免得只说「还没有答复」（§20 之前前台等待会把错误原文直接交回）
   */
  private turnErrors = new Map<string, string>()
  /**
   * 已经交给父会话看过的询问（按这一轮的幂等键）：同一条询问只告诉它一次 —— 前台交回、`wait` 交回、
   * 通知，三条路里先到的那条算数（§19.3）
   */
  private shownAsks = new Map<string, Set<string>>()

  // ─── 准入 ──────────────────────────────────────

  /**
   * 调用方会话不能是**笔记本会话**：它的人格钉死在 notebook 基座上、产物是那份笔记，开子会话
   * 不表达任何东西。bot 会话可以 —— 把活交给子会话正是它的工作方式。
   * 返回错误文案（null = 通过）。
   */
  private rejectIfNotNormal(sessionId: string): string | null {
    const s = sessionRecords.pick(sessionId, ['settings', 'parentId'])
    if (!s) return 'This task is not attached to a session — sub-sessions are unavailable here.'
    if (s.settings?.notebookPath) return 'Notebook sessions cannot have sub-sessions.'
    if (s.parentId) {
      return 'This is already a sub-session — nesting is limited to one level. Ask the parent session instead.'
    }
    return null
  }

  /** 取调用方名下的子会话（不存在 / 不是它的孩子都返回 null —— 越权在这里落空） */
  private ownChild(parentId: string, childId: string): { id: string; title: string } | null {
    const child = sessionRecords.pick(childId, ['title', 'parentId'])
    if (!child || child.parentId !== parentId) return null
    return { id: childId, title: child.title }
  }

  /**
   * 把调用方给的 childId 落定到一条确定的子会话。**省略时的补全**：恰好一条子会话
   * 就自动补全 —— create 完紧接着 prompt 漏抄 id 是实测里的高频失败，而此刻意图
   * 没有歧义；多于一条不猜（猜错等于把话发进错误的会话），列出候选让它点名。
   * 给了 id 则照旧校验归属。`wait` 不走这里：它「省略 = 等全部」是刻意语义。
   */
  private resolveChild(
    parentId: string,
    childId: string
  ): { id: string; title: string } | { error: string } {
    if (childId) {
      const child = this.ownChild(parentId, childId)
      return child ?? { error: this.unknownChildError(parentId, childId) }
    }
    const children = sessionRecords.findChildren(parentId)
    if (children.length === 1) return { id: children[0].id, title: children[0].title }
    if (children.length === 0) {
      return {
        error:
          'No sub-sessions yet — there is nothing to address. ' +
          'Create one with action "create-sub-session".'
      }
    }
    return {
      error:
        'Which sub-session? Pass its id in `sub_session_id`:\n' +
        children.map((s) => `  ${s.id}  ${s.title}`).join('\n')
    }
  }

  // ─── 查询 ──────────────────────────────────────

  /** 待答询问的摘要（只有 waiting-input 时有意义；只看开着的会话） */
  private blockedOn(sessionId: string): string[] | undefined {
    const asked = sessionService.getAgentSession(sessionId)?.pendingInputSummaries ?? []
    return asked.length > 0 ? asked : undefined
  }

  /**
   * 状态取自运行时而不是本地记账：用户自己在子会话里发消息同样是 running，
   * 一个只认「我发起的」记账会把那种情况报成 idle。
   *
   * 开着的会话问门面（waiting-input > running > interrupted > idle）；没开着的读 DB 里的运行状态镜像，
   * **从不为一次查询打开会话**：镜像 `interrupted` —— 以及崩溃留下的 `busy`（没开着的会话不可能真在跑，
   * 下次打开就是 interrupted，PIN-09）—— 报 interrupted，其余 idle。
   */
  private statusOf(sessionId: string): SubSessionStatus {
    const agent = sessionService.getAgentSession(sessionId)
    if (agent) {
      if (agent.pendingInputCount > 0) return 'waiting-input'
      if (agent.isStreaming) return 'running'
      return agent.isInterrupted ? 'interrupted' : 'idle'
    }
    const mirrored = sessionRecords.pick(sessionId, ['settings'])?.settings?.runState
    return mirrored === 'interrupted' || mirrored === 'busy' ? 'interrupted' : 'idle'
  }

  /** 开着的门面；没开就 peek（存储在才打开，从不创建） */
  private async peekFacade(sessionId: string): Promise<AgentSession | undefined> {
    return (
      sessionService.getAgentSession(sessionId) ??
      (await sessionService.peekAgentSession(sessionId))
    )
  }

  private info(row: { id: string; title: string; updatedAt: number }): SubSessionInfo {
    const pendingAsks = this.pendingAsksOf(row.id)
    return {
      id: row.id,
      title: row.title,
      status: this.statusOf(row.id),
      driven: this.runs.has(row.id),
      updatedAt: row.updatedAt,
      blockedOn: this.blockedOn(row.id),
      ...(pendingAsks ? { pendingAsks } : {})
    }
  }

  /**
   * 子会话此刻在跑的这一轮是本进程替父会话驱动的、绑定的后台任务还活着 → 那次驱动（§19.2 的判据）。
   * 用户自己在子会话里发起的一轮、已经落定的、上个进程驱动的（重启之后）→ undefined。
   */
  private boundRun(childId: string): DrivenRun | undefined {
    const run = this.runs.get(childId)
    if (!run) return undefined
    const task = taskRegistry.get(run.requestId)
    return task && task.endedAt === null ? run : undefined
  }

  /** 挂着的询问（完整的；只看开着的会话）。选择题能不能代答取决于这一轮是不是父会话发起的 */
  private pendingAsksOf(childId: string): PendingAskInfo[] | undefined {
    const pending = sessionService.getAgentSession(childId)?.pendingInputs() ?? []
    if (pending.length === 0) return undefined
    const answerable = this.boundRun(childId) !== undefined
    return pending.map(
      (request): PendingAskInfo =>
        request.kind === 'choice'
          ? {
              id: request.id,
              kind: 'question',
              question: request.question,
              options: request.options.map((o) => ({ label: o.label, description: o.description })),
              answerable
            }
          : { id: request.id, kind: 'approval', summary: approvalSummary(request) }
    )
  }

  /** 这些询问已经交给父会话看过了（同一轮里不再通知第二遍） */
  private markShown(requestId: string, asks: readonly PendingAskInfo[] | undefined): void {
    if (!asks?.length) return
    let shown = this.shownAsks.get(requestId)
    if (!shown) {
      shown = new Set()
      this.shownAsks.set(requestId, shown)
    }
    for (const ask of asks) shown.add(ask.id)
  }

  list(parentId: string): { error: string } | { subSessions: SubSessionInfo[] } {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    return { subSessions: sessionRecords.findChildren(parentId).map((s) => this.info(s)) }
  }

  async read(
    parentId: string,
    rawChildId: string
  ): Promise<{ error: string } | ({ info: SubSessionInfo } & AnswerFields)> {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, rawChildId)
    if ('error' in resolved) return { error: resolved.error }
    const childId = resolved.id

    const [last, intervened] = await Promise.all([
      this.lastAnswer(childId),
      this.userIntervened(childId)
    ])
    const row = sessionRecords.pick(childId, ['title', 'updatedAt'])
    // 交出去的询问记成看过（同一条不再通知）
    const run = this.boundRun(childId)
    if (run) this.markShown(run.requestId, this.pendingAsksOf(childId))
    return {
      info: {
        ...this.info({
          id: childId,
          title: row?.title ?? resolved.title,
          updatedAt: row?.updatedAt ?? 0
        }),
        ...(intervened ? { userIntervened: true } : {})
      },
      ...last
    }
  }

  /**
   * 查看子会话的现场（`inspect-sub-session`，§19.7）：大纲 / 展开一条 / 搜索。只读：开着的会话直接读视图，
   * 没开的 peek 一次（存储在才打开，从不创建）。父会话可以看自己的任何一条子会话，不受「这一轮是谁发起的」限制。
   */
  async inspect(params: {
    parentId: string
    childId: string
    query: OutlineQuery
  }): Promise<{ error: string } | { info: SubSessionInfo; result: OutlineResult }> {
    const { parentId, query } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, params.childId)
    if ('error' in resolved) return { error: resolved.error }
    const childId = resolved.id
    if (!isDurableSession(childId)) {
      return {
        error:
          `Sub-session "${resolved.title}" was created by an earlier version of ShuviX; its transcript cannot be ` +
          `inspected from here. "read-sub-session" still gives its last answer.`
      }
    }
    const row = sessionRecords.pick(childId, ['title', 'updatedAt'])
    const info = this.info({
      id: childId,
      title: row?.title ?? resolved.title,
      updatedAt: row?.updatedAt ?? 0
    })
    const agent = await this.peekFacade(childId)
    if (!agent) {
      // 还没有存储：什么都没发生过 —— 展开一条就是「没有这一条」，搜索是零命中，大纲是空的
      if (query.item?.trim()) {
        return {
          error: `No item ${query.item.trim().startsWith('#') ? query.item.trim() : `#${query.item.trim()}`} — nothing has happened in that sub-session yet.`
        }
      }
      if (query.match?.trim()) {
        return {
          info,
          result: { kind: 'match', query: query.match.trim(), lines: [], hits: 0, shown: 0 }
        }
      }
      return {
        info,
        result: {
          kind: 'outline',
          lines: [],
          turnFrom: 0,
          turnTo: 0,
          turnCount: 0,
          shown: 0,
          total: 0,
          earlierTurns: false
        }
      }
    }
    let view: Awaited<ReturnType<AgentSession['sessionView']>>
    let sources: Awaited<ReturnType<AgentSession['inputSources']>>
    try {
      ;[view, sources] = await Promise.all([agent.sessionView(), agent.inputSources()])
    } catch (err) {
      log.warn(`读子会话 ${childId} 的视图失败: ${err instanceof Error ? err.message : err}`)
      return {
        error: `Could not read sub-session "${info.title}" right now (it was just closed or is being reopened). Try again.`
      }
    }
    const result = buildSessionOutline(view, { readerId: parentId, sources }, query)
    if (result.kind === 'error') return { error: result.error }
    return {
      info: intervenedIn(view.messages, sources) ? { ...info, userIntervened: true } : info,
      result
    }
  }

  /**
   * 父会话最近一次发进去的消息之后，用户自己在子会话里说过话吗：最近的一条用户消息被 `authorsOf` 判为人打的（见
   * `intervenedIn`；系统通知不算）。读不了（旧会话、没有存储、出错）→ false —— 这只是一个提示，不是判据。
   */
  private async userIntervened(childId: string): Promise<boolean> {
    if (!isDurableSession(childId)) return false
    try {
      const agent = await this.peekFacade(childId)
      if (!agent) return false
      const [view, sources] = await Promise.all([agent.sessionView(), agent.inputSources()])
      return intervenedIn(view.messages, sources)
    } catch (err) {
      log.warn(`读子会话 ${childId} 的来源失败: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  // ─── 创建 ──────────────────────────────────────

  /**
   * 建一条子会话。
   *
   * **子会话继承父会话此刻的整套设置**：projectId（工作目录是会话的地基）、模型、
   * 思考档位与 mcp:/skill: 勾选（勾选在 `sessionService.create`，它是 settings 的键；
   * 模型与思考档位是会话树上的 change entry，在这里种）。不继承就会
   * 回落默认 ——「我用 opus 开着这套 MCP 干活、我开的子会话掉回默认模型、
   * 一个 skill 都没有」是纯粹的意外，而它跟父级在同一个目录里干同一件事。
   *
   * 唯一压过继承的是**档案自己的声明**（更具体的意图）：`shuvix-model` 定了模型就用它，
   * `shuvix-tools` 里列了 mcp:/skill: 就用它那套。档案没声明 = 没有意见，继承父会话。
   *
   * 标题由父级给 ⇒ 记 `titleOrigin: 'user'`：那是一次刻意命名，auto-title 的 refine
   * 阶段不该覆盖它。父级不给 ⇒ 留默认标题，auto-title 照常接管。
   *
   * `id`（P2-10 PIN-05）：工具把它记在调用的 memo 里，崩溃后重跑拿到同一个 —— 这一行已经在（重跑）就
   * 不再查总数上限、不再插入；标题与种子照写一遍（结果相同）。
   */
  async create(
    parentId: string,
    params: { title?: string; agentProfile?: string; id?: string }
  ): Promise<{ error: string } | { id: string; title: string }> {
    // 建完是一条**空会话**：首条消息不在这里发，也不在工具层顺手代发 —— 派活恒经
    // `prompt`，形态（前台等 / run_in_background）由派活的那次调用自己选。
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }

    const rerun = params.id !== undefined && this.ownChild(parentId, params.id) !== null
    if (!rerun) {
      const existing = sessionRecords.findChildren(parentId)
      if (existing.length >= MAX_SUB_SESSIONS) {
        return {
          error:
            `This session already has ${existing.length}/${MAX_SUB_SESSIONS} sub-sessions. ` +
            `Reuse one of them, or ask the user to delete some:\n` +
            existing.map((s) => `  ${s.id}  ${s.title}`).join('\n')
        }
      }
    }

    const title = params.title?.trim()
    const createParams = { parentId, ...(title ? { title } : {}) }
    let session: { id: string; title: string }
    try {
      session =
        params.id === undefined
          ? sessionService.create(createParams)
          : sessionService.create(createParams, { id: params.id })
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (title) sessionService.updateTitle(session.id, title, 'user')

    // 档案：父级点名才钉（准入见 sessionService.pinAgentProfile —— 基座被拒），
    // 不点名就什么也不写：子会话与父会话同一形态（projectId 恒随父），
    // resolveAgentProfileName 推导出的基座天然一致。勾选始终是 create 从父会话抄来的那份：
    // 档案声明的 mcp:/skill: 由名单归一恒生效，叠在勾选之上，不替换它
    const requested = params.agentProfile?.trim()
    let declared:
      | { model?: SubAgentModelConfig; thinkingLevel?: ThinkingLevel; tools: string[] }
      | undefined
    if (requested) {
      const applied = await sessionService.pinAgentProfile(session.id, requested)
      if (applied.success) declared = applied.applied
      // 档案不合法不该让整个创建失败：会话已经建好且可用（落在自己形态的基座上），记日志即可
      else log.warn(`子会话 ${session.id} 档案 "${requested}" 未生效: ${applied.error}`)
    }
    await this.seedRunConfig(parentId, session.id, declared)

    log.info(
      `create sub-session ${session.id} parent=${parentId} profile=${requested ?? '-'}${rerun ? ' (rerun)' : ''}`
    )
    return {
      id: session.id,
      title: sessionRecords.pick(session.id, ['title'])?.title ?? session.title
    }
  }

  /**
   * 把父会话此刻的模型与思考档位作为种子写进子会话树（扩展能力勾选已在
   * `sessionService.create` 里随 settings 抄过去，档案的工具声明由 `pinAgentProfile` 处理）。
   *
   * 抄的是**解析后**的值（`resolveRunConfig`）而不是「树上显式改过的那些」：父会话大多数
   * 键根本没显式改过，只抄显式值等于什么也没继承。
   *
   * `declared` 是档案声明的那部分（档案切换生效时才有），它压过继承 —— 更具体的意图。
   * 声明了的那几项 `pinAgentProfile` 已经写过种子，这里只补没声明的；再写一条父会话的值
   * 会排在档案种子之后，把它盖掉。
   */
  private async seedRunConfig(
    parentId: string,
    childId: string,
    declared?: { model?: SubAgentModelConfig; thinkingLevel?: ThinkingLevel }
  ): Promise<void> {
    const parent = await sessionService.resolveRunConfig(parentId)
    if (!parent) return
    if (!declared?.model && parent.model) {
      await recordSessionModel(childId, parent.model.provider, parent.model.model)
    }
    if (!declared?.thinkingLevel) {
      await recordSessionThinkingLevel(childId, parent.thinkingLevel)
    }
  }

  // ─── 驱动 ──────────────────────────────────────

  /**
   * 代替用户往子会话发一条用户消息，**立刻回执**（§20：派活默认就是后台语义）。跑完经完成通知告诉父会话、停下来
   * 问了经这一轮的后台任务告诉它；要在这一轮里拿答复就 `wait`。回执**不带内容**：内容会永久留在父会话上下文里
   * 并被每一步重发（bash 后台形态同一条纪律）。父会话被停止**不**级联到子会话（用户裁决：与 bash 后台任务一致）。
   *
   * `requestId` 是这次发送的幂等键（工具给 `subsession:<父会话>:<工具任务 id>`）。子会话已经认得它 =
   * 这是崩溃之后的重跑（PIN-03）：已落定 → 不再发送，直接读答复；没落定 → 重新挂上那一条（跳过忙 /
   * 等批准 / 并发上限的判定 —— 那都是它自己），被中断就续上。没给（没有工具任务的调用方）→ 一个
   * 从不重新挂上的临时键（PIN-18）。
   */
  async prompt(params: {
    parentId: string
    childId: string
    message: string
    requestId?: string
  }): Promise<{ error: string } | PromptOutcome> {
    const { parentId, message } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, params.childId)
    if ('error' in resolved) return { error: resolved.error }
    const child = resolved
    const childId = child.id
    if (!message.trim())
      return { error: 'Pass the message text in `message` (a non-empty string).' }

    // **同步占位先于异步判定**：两个 prompt 在同一轮里并发进来时，`statusOf` 查的是
    // 运行时，而运行时是懒创建的（第一条还没把它建出来），于是两边都判「空闲」双双放行
    // —— 第二条随后被拒 busy，回到模型眼里成了「已提交、排队中」。这一行让第二条当场拿到拒绝理由。
    if (this.runs.has(childId) || this.claiming.has(childId)) {
      // 你发起的那一轮停下来问了：它在等回答，而不是还在跑 —— 给能解开它的那个动作（可代答 → answer）
      if (this.statusOf(childId) === 'waiting-input') {
        return { error: this.blockedError(child.title, childId) }
      }
      return {
        error:
          `Sub-session "${child.title}" is already running a turn you just started. ` +
          `One sub-session runs one turn at a time — wait for it with "wait-for-sub-sessions", ` +
          `or, if this work does not belong to it, create another sub-session for it.`
      }
    }
    const requestId =
      params.requestId ?? `subsession:${parentId}:adhoc-${globalThis.crypto.randomUUID()}`
    this.claiming.add(childId)
    // 先记下这次发送，再做任何异步判定：子会话被打开的那一刻就可能报出一次落定（打开时的扫描）
    const record: DriveRecord = { requestId }
    this.records.set(requestId, record)

    let run: DrivenRun
    try {
      const known =
        params.requestId === undefined ? 'none' : await this.requestStateOf(childId, requestId)

      if (known === 'settled') {
        // 崩溃之前就落定了：不再发送（PIN-03）—— 答复就在子会话里；回执如实说「已经结束」，别说成还在跑
        this.dropRecord(requestId, record)
        return { kind: 'finished', id: childId }
      }

      if (known === 'none') {
        const refusal = this.freshSendRefusal(parentId, child)
        if (refusal) {
          this.dropRecord(requestId, record)
          return { error: refusal }
        }
        await this.noteSupersede(parentId, childId, requestId)
        this.turnErrors.delete(childId)
      }

      taskRegistry.create({
        taskId: requestId,
        kind: 'sub-session',
        sessionId: parentId,
        title: child.title,
        subject: { kind: 'sub-session', childSessionId: childId },
        // 不给 formatNotice：子会话的完成通知只走 onDrivenSettled 这一条路（PIN-01）。
        // 跑到一半弹出询问、没人在等它时的通知走枢纽（§19.3）—— 它和这一轮的任务同生共死
        formatInputNotice: (task) => this.inputNotice(task),
        stop: () => {
          void this.abortChild(childId)
        }
      })
      run = {
        parentId,
        requestId,
        // 永不 reject，但**保留 error 与 code**：发送失败与「那一轮以错误收场」是两件事
        done: chatGateway
          .prompt(childId, message, undefined, undefined, {
            requestId,
            driven: { parentId, background: true }
          })
          .catch((err: unknown): SubmitResult => {
            log.warn(`子会话 ${childId} 发送失败: ${err}`)
            return { error: err instanceof Error ? err.message : String(err) }
          })
      }
      this.runs.set(childId, run)
    } finally {
      this.claiming.delete(childId)
    }
    void run.done.then((sent) => this.settle(childId, run, sent))
    // 重新挂上的那一轮可能已经停在询问上（打开时被重新问了一遍）：任务立刻进「等待输入」
    if (this.statusOf(childId) === 'waiting-input') {
      taskRegistry.update(requestId, { status: 'waiting-input' })
    }
    return this.confirmSent({ parentId, child, run, record })
  }

  /**
   * 发出去（`prompt`）/ 答完（`answer`）之后的回执：只等「确认发出去了」的那一小会儿（`SEND_CONFIRM_MS`）——
   * 发送失败（拒 busy）是同步就落定的，正常那一路要跑到轮结束，不在这里等它。确认窗里子会话就停下来问了 → 由这次
   * 交回（否则枢纽见它有人等就不排通知，之后再没人补，§19.3）。不接中止信号：父会话被停不级联（§20）。
   */
  private async confirmSent(p: {
    parentId: string
    child: { id: string; title: string }
    run: DrivenRun
    record: DriveRecord
    /** 'answer'：这一轮早就发出去了 —— 确认窗里它以什么结果收场都不是「没发出去」，只回执 */
    after?: 'prompt' | 'answer'
  }): Promise<{ error: string } | PromptOutcome> {
    const { parentId, child, run, record, after = 'prompt' } = p
    const childId = child.id
    const requestId = run.requestId
    this.confirming.add(requestId)
    let outcome: JoinOutcome | undefined
    try {
      outcome = await taskRegistry.join(requestId, {
        maxWait: SEND_CONFIRM_MS,
        onTimeout: 'detach',
        onInput: 'return'
      })
    } finally {
      this.confirming.delete(requestId)
    }

    if (outcome?.kind === 'detached') {
      if (outcome.reason === 'input') {
        // 停下来问了：询问由这次调用交回（同一条不再通知），这一轮仍在
        this.markShown(requestId, this.pendingAsksOf(childId))
        const info = this.infoOf(parentId, childId)
        log.info(`子会话 ${childId} 停下来询问，确认窗里交回`)
        return { kind: 'input', id: childId, ...(info ? { info } : {}) }
      }
      log.info(`prompt sub-session ${childId} (background)`)
      return { kind: 'started', id: childId }
    }

    // 确认窗里就落定了：没发出去（忙、模型被拒……）如实报；发出去了、跑完了也只是回执 —— 完成通知会把答复的去处说清
    const sent = await run.done
    if (
      after === 'prompt' &&
      sent.error &&
      (sent.code === undefined || NOT_DELIVERED.has(sent.code))
    ) {
      this.dropRecord(requestId, record)
      return { error: this.sendFailedError(childId, child.title, sent) }
    }
    log.info(`prompt sub-session ${childId} (background, settled at once)`)
    return { kind: 'started', id: childId }
  }

  /** 子会话认不认得这个幂等键（没有存储 / 旧格式 → 'none'；peek 从不创建） */
  private async requestStateOf(
    childId: string,
    requestId: string
  ): Promise<'none' | 'pending' | 'settled'> {
    if (!isDurableSession(childId)) return 'none'
    const agent = await this.peekFacade(childId)
    return agent ? agent.requestState(requestId) : 'none'
  }

  /**
   * 一次新发送（不是重新挂上）的准入：忙就拒绝，刻意不排队 —— 一个忙着的子会话是父级该知道并作决策的
   * 状态，替它排队等于把这个状态藏起来。卡在询问上的给「去让用户回答」的建议。被中断的**不拒**：
   * 新消息按 abort-then-send 先中止被中断的那件事（R5）。返回拒绝文案，null = 放行。
   */
  private freshSendRefusal(parentId: string, child: { id: string; title: string }): string | null {
    const status = this.statusOf(child.id)
    if (status === 'waiting-input') return this.blockedError(child.title, child.id)
    if (status === 'running') {
      return (
        `Sub-session "${child.title}" is ${status}. ` +
        `Collect it with action "wait-for-sub-sessions", or stop it with "stop-sub-session".`
      )
    }
    const running = [...this.runs.entries()]
      .filter(([id, r]) => r.parentId === parentId && this.statusOf(id) !== 'idle')
      .map(([id]) => id)
    if (running.length >= MAX_RUNNING_SUB_SESSIONS) {
      return (
        `Too many sub-sessions running (${running.length}/${MAX_RUNNING_SUB_SESSIONS}). ` +
        `Wait for one to finish before starting another.`
      )
    }
    return null
  }

  /**
   * 新消息发进一条被中断的子会话：abort-then-send 会先中止被中断的那一轮。那一轮若正是本父会话驱动的
   * （它的 driven-run 标记），它以 aborted 落定时不通知 —— 顶掉它的就是父级自己（PIN-19）。
   */
  private async noteSupersede(parentId: string, childId: string, requestId: string): Promise<void> {
    if (this.statusOf(childId) !== 'interrupted') return
    const marker = (await this.peekFacade(childId))?.drivenRun
    if (marker && marker.parentId === parentId && marker.requestId !== requestId) {
      this.superseded.add(marker.requestId)
    }
  }

  /** 撤掉一次发送的记录；返回它是否**已经**被完成通知处理掉了（不在了 / 换成了别的） */
  private dropRecord(requestId: string, record: DriveRecord): boolean {
    if (this.records.get(requestId) !== record) return true
    this.records.delete(requestId)
    return false
  }

  /** 单条子会话的快照（不含答复；lastAnswer 另取） */
  private infoOf(parentId: string, childId: string): SubSessionInfo | undefined {
    const row = sessionRecords.findChildren(parentId).find((s) => s.id === childId)
    return row ? this.info(row) : undefined
  }

  /**
   * 阻塞等到子会话跑完并**一次性交回结果** —— 「起了几条、现在要收」的正解。
   *
   * 存在的理由是它替掉的那个东西：没有它，模型只能 `sleep` + 反复 list/read，
   * 而每一轮轮询都是一次完整请求（系统提示词 + 整段历史 + 全部工具定义重发一遍），
   * 换回来的往往是一句「还没好」。这里一次调用挂住,结果一次交齐。
   *
   * `childId` 省略 = 等本会话**此刻在跑的全部**子会话（被中断的不在其中 —— 它们不会自己好起来）。
   * `waiting-input`（卡在 ask 上等人回答）与 `interrupted` 都算落定，结果里如实标出状态让父级去决定。
   * 中止**不**级联杀子会话：等待是只读动作，父级被停不该连累后台在跑的活。
   *
   * 重跑（P2-10 PIN-04 / Q-P2-02）：第一次运行在挂住之前经 `onTargets` 把「此刻在跑、要等的那几条」交给
   * 工具记进 memo；崩溃之后重跑带着它（`rerunTargets`）回来 —— 这几条里被中断的先续上
   * （`resumeInterrupted`，没开着的先打开）再等；之后才开始跑的不加进来。超时重新计满（PIN-07）。
   */
  async wait(params: {
    parentId: string
    childId?: string
    timeoutSeconds: number
    signal?: AbortSignal
    /** 重跑：第一次运行记下的那几条 */
    rerunTargets?: readonly string[]
    /** 第一次运行：挂住之前交出要等的那几条（工具据此写 memo） */
    onTargets?: (targets: string[]) => Promise<void>
  }): Promise<{ error: string } | WaitOutcome> {
    const { parentId, childId, timeoutSeconds, signal } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    if (childId && !this.ownChild(parentId, childId)) {
      return { error: this.unknownChildError(parentId, childId) }
    }

    let blockOn: string[]
    /** 重跑时要先续上的那几条（被中断的） */
    let resume: string[] = []
    if (params.rerunTargets) {
      blockOn = params.rerunTargets.filter((id) => this.ownChild(parentId, id) !== null)
      resume = blockOn.filter((id) => this.statusOf(id) === 'interrupted')
    } else {
      const candidates = childId
        ? [childId]
        : sessionRecords.findChildren(parentId).map((s) => s.id)
      blockOn = candidates.filter((id) => this.statusOf(id) === 'running')
      await params.onTargets?.(blockOn)
    }
    const targets = childId ? [childId] : blockOn
    if (targets.length === 0) {
      const results = await this.infoWithAnswers(parentId)
      return { kind: this.stoppedKind(results), results }
    }

    // 先登记成「被 wait 握着」、再续上：先续上的那一条可能在后一条还在打开时就落定了 —— 那次落定要在同一轮里
    // 交回（不通知父会话），所以握着它这件事必须早于它被续上（P2-12 K1-05）
    for (const id of targets) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1)
    let kind: 'settled' | 'timeout' | 'aborted'
    try {
      for (const id of resume) await this.resumeChild(id)
      // 都不在跑了；或者有一条停下来问了 —— 它不会自己好起来，而父会话可能答得了，不能让它陪着别的子会话等
      const settled = (): boolean =>
        targets.every((id) => this.statusOf(id) !== 'running') ||
        targets.some((id) => this.statusOf(id) === 'waiting-input')
      kind = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
        let done = false
        const finish = (r: 'settled' | 'timeout' | 'aborted'): void => {
          if (done) return
          done = true
          clearInterval(tick)
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        }
        const onAbort = (): void => finish('aborted')
        // 进程内轮询状态（200ms，不花任何模型成本）：本进程驱动的那些有 run.done 可等，
        // 但用户自己在子会话里发起的那一轮没有，只能问运行时
        const tick = setInterval(() => {
          if (settled()) finish('settled')
        }, 200)
        const timer = setTimeout(() => finish('timeout'), Math.max(1, timeoutSeconds) * 1000)
        if (signal?.aborted) return finish('aborted')
        signal?.addEventListener('abort', onAbort, { once: true })
        if (settled()) finish('settled')
      })
      // 交回去的落定：它们的完成通知不再发（握着它们的时候先记，免得通知恰好插在中间）
      await this.collectInBand(targets)
      // 要交回去的询问同样趁还握着先记成看过：放手之后合并窗口才到点的那条通知就不会再说一遍
      for (const id of targets) {
        const run = this.boundRun(id)
        if (run) this.markShown(run.requestId, this.pendingAsksOf(id))
      }
    } finally {
      for (const id of targets) {
        const n = (this.waiters.get(id) ?? 1) - 1
        if (n > 0) this.waiters.set(id, n)
        else this.waiters.delete(id)
      }
    }
    const results = await this.infoWithAnswers(parentId, targets)
    // 落定了但有人停在询问上 —— 那不是「完成」，外层状态必须说清楚
    return { kind: kind === 'settled' ? this.stoppedKind(results) : kind, results }
  }

  /**
   * 都不在跑了：真跑完了（settled）、有人停下来问了父会话能代答的问题（asking）、还是有人卡在只有用户能答的
   * 询问上（blocked）。交回的询问记成「已经给父会话看过」—— 同一条不再通知（§19.3）。
   */
  private stoppedKind(results: ReadonlyArray<SubSessionInfo>): 'settled' | 'asking' | 'blocked' {
    const waiting = results.filter((r) => r.status === 'waiting-input')
    for (const r of waiting) {
      const run = this.boundRun(r.id)
      if (run) this.markShown(run.requestId, r.pendingAsks)
    }
    if (waiting.length === 0) return 'settled'
    const answerable = waiting.some((r) =>
      r.pendingAsks?.some((a) => a.kind === 'question' && a.answerable)
    )
    return answerable ? 'asking' : 'blocked'
  }

  /** 续上一条被中断的子会话（没开着就打开；不等它跑完） */
  private async resumeChild(childId: string): Promise<void> {
    const agent =
      sessionService.getAgentSession(childId) ?? (await sessionService.ensureAgentSession(childId))
    if (!agent) return
    const result = await agent.resumeInterrupted()
    if (result.error) log.warn(`续上子会话 ${childId} 失败: ${result.error}`)
  }

  /**
   * wait 交回的那几条里已经落定、完成通知还没处理的那一轮（它的 driven-run 标记还在）：记成已交回。
   * 卡在询问上 / 还在跑 / 被中断的不记 —— 它们之后落定时父级还要被叫醒。
   */
  private async collectInBand(targets: readonly string[]): Promise<void> {
    for (const id of targets) {
      if (this.statusOf(id) !== 'idle') continue
      const agent = sessionService.getAgentSession(id)
      const marker = agent?.drivenRun
      if (!agent || !marker) continue
      try {
        if ((await agent.requestState(marker.requestId)) === 'settled') {
          this.inBand.add(marker.requestId)
        }
      } catch {
        /* 会话恰好关了：它的通知照常走 */
      }
    }
  }

  /** 子会话快照 + 各自这一轮的答复（wait 的返回形状；ids 省略 = 全部子会话） */
  private async infoWithAnswers(
    parentId: string,
    ids?: string[]
  ): Promise<Array<SubSessionInfo & AnswerFields>> {
    const children = sessionRecords.findChildren(parentId).filter((s) => !ids || ids.includes(s.id))
    return Promise.all(
      children.map(async (s) => {
        const [answer, intervened] = await Promise.all([
          this.lastAnswer(s.id),
          this.userIntervened(s.id)
        ])
        return { ...this.info(s), ...(intervened ? { userIntervened: true } : {}), ...answer }
      })
    )
  }

  /** 一次驱动结束：销账，把结果交回枢纽（解挂等待者；枢纽对子会话任务不发通知） */
  private settle(childId: string, run: DrivenRun, sent: SubmitResult): void {
    if (this.runs.get(childId) === run) this.runs.delete(childId)
    this.shownAsks.delete(run.requestId)
    const notDelivered = !!sent?.error && (sent.code === undefined || NOT_DELIVERED.has(sent.code))
    if (sent?.error && !notDelivered) this.turnErrors.set(childId, sent.error)
    // 过了确认窗才发现没发出去：那次调用早已回执「在跑」，单独告诉父会话（还在确认窗里的由那次调用自己报）
    if (notDelivered && !this.confirming.has(run.requestId)) {
      const record = this.records.get(run.requestId)
      if (record) {
        this.records.delete(run.requestId)
        void this.reportUndelivered(run, childId, sent)
      }
    }
    taskRegistry.settle(run.requestId, { status: sent?.error ? 'error' : 'done' })
  }

  /** 过了确认窗才落定的「没发出去」→ 一条通知（叫醒父会话；按幂等键去重） */
  private async reportUndelivered(
    run: DrivenRun,
    childId: string,
    sent: SubmitResult
  ): Promise<void> {
    const title = sessionRecords.pick(childId, ['title'])?.title ?? childId
    const text = [
      `<sub-session id="${attrValue(childId)}" title="${attrValue(title)}" status="${this.statusOf(childId)}">`,
      this.sendFailedError(childId, title, sent),
      '</sub-session>'
    ].join('\n')
    try {
      await sessionService.deliverSubSessionNotice(
        run.parentId,
        text,
        `subsession-undelivered:${run.requestId}`,
        { wake: true }
      )
    } catch (err) {
      log.warn(
        `子会话 ${childId} 没发出去的通知送达失败: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  // ─── 父会话介入（§19） ─────────────────────────

  /**
   * 子会话弹出一条询问（main 入口经 `setSessionAskObserver` 接进来，同步调用 —— 询问此刻已在挂着的表里）。
   * 这一轮绑定着任务 → 任务进「等待输入」：前台在等的那次调用当场交回，没人等就经枢纽通知父会话（§19.3）。
   * 没有绑定任务（用户自己发起的一轮、已落定、重启之后）→ 什么都不做，也就没有通知。
   */
  onAskRaised(sessionId: string, _request: InputRequest): void {
    const run = this.boundRun(sessionId)
    if (!run) return
    taskRegistry.update(run.requestId, { status: 'waiting-input' })
  }

  /** 子会话的一条询问落定（应答 / 取消 / 被顶替）：挂着的都没了 → 任务回到「在跑」 */
  onAskResolved(sessionId: string, _requestId: string): void {
    const run = this.boundRun(sessionId)
    if (!run) return
    if ((sessionService.getAgentSession(sessionId)?.pendingInputCount ?? 0) > 0) return
    taskRegistry.update(run.requestId, { status: 'running' })
  }

  /**
   * 子会话停下来询问、没人在等它时的通知（枢纽在合并窗口结束时调用）。只说还没给父会话看过的那几条；
   * `wait` 正握着它（它自己会交回）、这一轮已经结束或换了一轮、询问已经被答掉 → 不发。
   * 文案是模型面向的英文（进上下文的字符串不随界面语言变），整段在一个 `<sub-session>` 块里 —— 渲染侧
   * 按形状把它认成系统通知，不是用户发言。
   */
  private inputNotice(task: TaskInfo): string | null {
    if (task.subject.kind !== 'sub-session') return null
    const childId = task.subject.childSessionId
    if (this.waiters.has(childId)) return null
    if (this.boundRun(childId)?.requestId !== task.taskId) return null
    const shown = this.shownAsks.get(task.taskId)
    const fresh = (this.pendingAsksOf(childId) ?? []).filter((a) => !shown?.has(a.id))
    if (fresh.length === 0) return null
    this.markShown(task.taskId, fresh)
    const title = sessionRecords.pick(childId, ['title'])?.title ?? childId
    const asksQuestion = fresh.some((a) => a.kind === 'question')
    return [
      `<sub-session id="${attrValue(childId)}" title="${attrValue(title)}" status="waiting-input">`,
      asksQuestion
        ? 'It stopped to ask a question in the turn you started.'
        : 'It stopped to ask the user for approval in the turn you started and cannot continue until the user answers in that session.',
      ...renderPendingAsks(fresh),
      '</sub-session>'
    ].join('\n')
  }

  /**
   * 代用户回答子会话的选择题（`answer-sub-session`，§19.4）。只答**这个父会话发起、绑定任务还活着的那一轮**
   * 里 ask 工具的提问；权限卡一律拒绝（只有用户能批）。应答直接送进这条子会话自己 —— 不经全局的
   * `respondToUserInput`：询问 id 就是 provider 的 toolCallId，会话之间会重复（`call_0`）。
   *
   * 答完默认在前台等这一轮（与 `prompt` 同一个 `awaitTurn`：答复 / 下一条询问 / 超时降级），后台形态立刻回执。
   * 用户先答了 → `respond` 认领不到，如实说什么都没发。重启之后重跑：任务只在内存里，这一轮已不归它，被拒、
   * 不会答第二次。
   */
  async answer(params: {
    parentId: string
    childId: string
    askId?: string
    selections?: readonly string[]
    message?: string
  }): Promise<{ error: string } | PromptOutcome> {
    const { parentId } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, params.childId)
    if ('error' in resolved) return { error: resolved.error }
    const child = resolved
    const childId = child.id
    const agent = sessionService.getAgentSession(childId)
    const pending = agent?.pendingInputs() ?? []
    const askId = params.askId?.trim()
    // 点名的那道题已经不在挂着了：多半是用户先答了 —— 把它得到的回答带出来（从转写里读）。放在「这一轮归不归
    // 你」之前：这一轮跑完之后再点名，同样该知道它早就有了回答
    if (agent && askId && !pending.some((r) => r.id === askId)) {
      const earlier = await this.answeredAsk(agent, askId)
      if (earlier !== undefined) {
        return {
          error:
            `Question "${askId}" in sub-session "${child.title}" was already answered (most likely by the user ` +
            `in that session): ${earlier}. Nothing was sent.`
        }
      }
    }
    const run = this.boundRun(childId)
    if (!agent || !run || run.parentId !== parentId) {
      return { error: this.notYoursToAnswer(child, pending.length > 0) }
    }

    const target = this.pickQuestion(child, pending, askId)
    if ('error' in target) return target
    const response = this.answerResponse(target.question, params.selections, params.message)
    if ('error' in response) return response

    const parentTitle = sessionRecords.pick(parentId, ['title'])?.title
    const answered = agent.respondToInput(target.question.id, response.response, {
      clientId: `parent:${parentId}`,
      answeredBy: {
        kind: 'parent-session',
        sessionId: parentId,
        ...(parentTitle ? { title: parentTitle } : {})
      }
    })
    if (!answered) {
      return {
        error:
          `The question in sub-session "${child.title}" was already answered (most likely by the user in that session) — ` +
          `nothing was sent. Check where it stands with "read-sub-session".`
      }
    }
    log.info(`父会话 ${parentId} 代答子会话 ${childId} 的询问 ${target.question.id}`)

    let record = this.records.get(run.requestId)
    if (!record) {
      record = { requestId: run.requestId }
      this.records.set(run.requestId, record)
    }
    return this.confirmSent({ parentId, child, run, record, after: 'answer' })
  }

  /** 子会话转写里这次 ask 调用得到的回答（结果文本的首行，截短）；没有 / 读不了 → undefined */
  private async answeredAsk(agent: AgentSession, askId: string): Promise<string | undefined> {
    try {
      const view = await agent.sessionView()
      for (let i = view.messages.length - 1; i >= 0; i--) {
        const message = view.messages[i]
        if (message.role !== 'assistant') continue
        for (const block of message.blocks) {
          if (block.type !== 'tool' || block.toolName !== 'ask' || block.toolCallId !== askId)
            continue
          if (block.result === undefined || block.isError) return undefined
          const line = block.result.replace(/\s+/g, ' ').trim()
          return line.length > 200 ? `${line.slice(0, 197)}...` : line
        }
      }
    } catch {
      /* 读不了：退回一般的「不在挂着」 */
    }
    return undefined
  }

  /** 这条子会话里不是父会话能代答的（这一轮不是它发起的 / 已经结束 / 根本没在问） */
  private notYoursToAnswer(child: { id: string; title: string }, asking: boolean): string {
    if (!asking) {
      return (
        `Sub-session "${child.title}" is not waiting for an answer (status: ${this.statusOf(child.id)}). ` +
        `Nothing was sent.`
      )
    }
    return (
      `The question in sub-session "${child.title}" is not in a turn you are driving now (the user started that ` +
      `turn, your turn there has already ended, or the app restarted since) — it is the user's to answer. ` +
      `Nothing was sent. Tell the user, or leave it.`
    )
  }

  /** 要答的那一条：给了 id 就按 id 找（权限卡拒绝）；没给就要求恰好一条选择题 */
  private pickQuestion(
    child: { id: string; title: string },
    pending: readonly InputRequest[],
    askId: string | undefined
  ): { question: ChoiceInputRequest } | { error: string } {
    const questions = pending.filter((r): r is ChoiceInputRequest => r.kind === 'choice')
    const listing = (): string =>
      questions.map((q) => `  ${q.id}  ${q.question.replace(/[\r\n]+/g, ' ')}`).join('\n')
    if (askId) {
      const found = pending.find((r) => r.id === askId)
      if (!found) {
        return {
          error: questions.length
            ? `No question "${askId}" is waiting in sub-session "${child.title}" — nothing was sent. Waiting questions:\n${listing()}`
            : `No question "${askId}" is waiting in sub-session "${child.title}" — nothing was sent.`
        }
      }
      if (found.kind !== 'choice') {
        return {
          error:
            `"${askId}" is an approval prompt — only the user can answer it; tell them, or stop the sub-session ` +
            `with "stop-sub-session". Nothing was sent.` +
            (questions.length ? ` Questions you may answer:\n${listing()}` : '')
        }
      }
      return { question: found }
    }
    if (questions.length === 1) return { question: questions[0] }
    if (questions.length === 0) {
      return {
        error:
          pending.length > 0
            ? this.blockedError(child.title, child.id)
            : `Sub-session "${child.title}" is not waiting for an answer. Nothing was sent.`
      }
    }
    return { error: `Which question? Pass its id in \`ask_id\`:\n${listing()}` }
  }

  /** 父会话的答案 → 应答：选项（逐字等于 label，可多选、去重）或自己的话，二选一 */
  private answerResponse(
    question: ChoiceInputRequest,
    rawSelections: readonly string[] | undefined,
    rawMessage: string | undefined
  ): { response: InputResponse } | { error: string } {
    const selections = [...new Set((rawSelections ?? []).map((s) => s.trim()).filter(Boolean))]
    const message = rawMessage?.trim() ?? ''
    const labels = question.options.map((o) => o.label)
    const optionList = labels.map((l) => `  - ${l}`).join('\n')
    if (selections.length > 0 && message) {
      return { error: 'Pass either `selections` or `message`, not both. Nothing was sent.' }
    }
    if (selections.length === 0 && !message) {
      return {
        error:
          'Pass the answer: `selections` with the exact option labels, or `message` in your own words. ' +
          `Options:\n${optionList}`
      }
    }
    if (selections.length > 0) {
      const known = new Set(labels.map((l) => l.trim()))
      const unknown = selections.filter((s) => !known.has(s))
      if (unknown.length > 0) {
        return {
          error:
            `Not an option: ${unknown.map((u) => `"${u}"`).join(', ')}. Use the exact labels — or answer in ` +
            `your own words with \`message\`. Nothing was sent. Options:\n${optionList}`
        }
      }
      const byTrimmed = new Map(labels.map((l) => [l.trim(), l]))
      return {
        response: { kind: 'choice', selections: selections.map((s) => byTrimmed.get(s) ?? s) }
      }
    }
    return { response: { kind: 'other', text: message } }
  }

  /**
   * 往子会话这一轮里插话（`steer-sub-session`，§19.6）。只插**这个父会话发起、绑定任务还活着、正在跑**的那一轮；
   * 其余一律拒绝而不是排队，并给出去处（空闲 → prompt；卡在可代答的提问上 → answer；批准卡 → 转告用户）。
   * 走网关的 steer（界面用的同一道门），带幂等键（重跑时子会话认得它就不再发）与来源（这条消息是父会话写的）。
   *
   * 已知的窄窗口：检查之后、送达之前这一轮刚好结束，引导会像界面上的 steer 一样自己起一轮（没有绑定任务）。
   */
  async steer(params: {
    parentId: string
    childId: string
    message: string
    requestId: string
  }): Promise<{ error: string } | { id: string; title: string; earlier?: boolean }> {
    const { parentId, requestId } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, params.childId)
    if ('error' in resolved) return { error: resolved.error }
    const child = resolved
    const childId = child.id
    const message = params.message.trim()
    if (!message) return { error: 'Pass the message text in `message` (a non-empty string).' }

    // 重跑：这条引导上次已经送到了
    if ((await this.requestStateOf(childId, requestId)) !== 'none') {
      return { id: childId, title: child.title, earlier: true }
    }

    const status = this.statusOf(childId)
    const run = this.boundRun(childId)
    if (!run || run.parentId !== parentId) {
      if (status === 'idle') {
        return {
          error:
            `Sub-session "${child.title}" is idle — there is no turn to steer. ` +
            `Send it a message with "prompt-sub-session".`
        }
      }
      if (status === 'interrupted') {
        return {
          error:
            `Sub-session "${child.title}" was interrupted when the app stopped; there is no running turn to steer. ` +
            `A new "prompt-sub-session" starts over.`
        }
      }
      return {
        error:
          `The turn running in sub-session "${child.title}" was not started by you (the user is working in it), ` +
          `so you cannot steer it. Wait for it with "wait-for-sub-sessions", or tell the user.`
      }
    }
    if (status === 'waiting-input') {
      const asks = this.pendingAsksOf(childId)
      if (asks?.some((a) => a.kind === 'question')) {
        return {
          error:
            `Sub-session "${child.title}" is waiting for an answer to its question, and a steer would only land ` +
            `after that. Answer it with "answer-sub-session" and put what you want to tell it in \`message\`.`
        }
      }
      return { error: this.blockedError(child.title, childId) }
    }

    const sent = await chatGateway.steerDriven(childId, message, { requestId, parentId })
    if (sent.error) {
      return {
        error: `The steer was NOT delivered to sub-session "${child.title}": ${sent.error}. Nothing was queued.`
      }
    }
    log.info(`父会话 ${parentId} 向子会话 ${childId} 插话 request=${requestId}`)
    return { id: childId, title: child.title }
  }

  // ─── 完成通知（P2-10 PIN-01） ──────────────────

  /**
   * 运行时报来子会话被驱动的那一轮落定了（`SessionHostDeps.onDrivenSettled`，每个进程至多一次）。
   * 该通知就送达父会话；送达失败**拒绝** —— 运行时留着标记，下次打开再报。被抑制 = 正常返回。
   * 与发送那一侧谁先谁后无关：抑制条件两边都记。
   */
  async onDrivenSettled(event: DrivenSettledEvent): Promise<void> {
    // 能叫醒父会话（自动续跑一轮）的只有本进程发起、还记着的驱动（含前台超时降级成的 released）——
    // 在 suppressNotice 销账之前看
    const tracked = this.records.has(event.requestId)
    if (await this.suppressNotice(event)) {
      log.info(`子会话 ${event.sessionId} 的完成通知不发 request=${event.requestId}`)
      return
    }
    if (!tracked) {
      log.info(
        `子会话 ${event.sessionId} 的完成通知只写入、不叫醒父会话（不是本进程发起的驱动）request=${event.requestId}`
      )
    }
    if (event.result.error && !NOT_DELIVERED.has(event.result.code ?? '')) {
      this.turnErrors.set(event.sessionId, event.result.error)
    }
    const intervened = await this.userIntervened(event.sessionId)
    await sessionService.deliverSubSessionNotice(
      event.parentId,
      this.completionNotice(event, intervened),
      event.noticeRequestId,
      { wake: tracked }
    )
  }

  private async suppressNotice(event: DrivenSettledEvent): Promise<boolean> {
    const { requestId, sessionId: childId } = event
    const record = this.records.get(requestId)
    if (record) this.records.delete(requestId)
    // 智能体自己停的 / 被同一父会话的新消息顶掉的：它早就知道
    const stopped = this.agentStopped.delete(requestId)
    const superseded = this.superseded.delete(requestId)
    if (stopped || superseded) return true
    // 已经在同一轮里交回去了（wait 交回的落定）
    if (this.inBand.delete(requestId)) return true
    // wait 正握着它：落定会在同一轮里交回去
    if (this.waiters.has(childId)) return true
    // 原来还有一条（PIN-14）：上个进程发的前台驱动、发起它的父会话工具任务还活着 → 不通知，等重跑就地收下答复。
    // 派活一律后台之后（§20）重跑只回执、不再收答复，压掉这条通知答复就没了去处 —— 删了，照常通知
    return false
  }

  /**
   * 给父会话的完成回报（P2-10 PIN-16：沿用原来的模板，被用户停掉的那一轮多一句）。
   *
   * 回执**不带内容**（照抄 bash 后台形态）：内容会永久留在父会话上下文里并被每一步重发，
   * 要结果就去收。文案是模型面向的英文而非 i18n —— 与 bgTaskService.formatExitNotice
   * 同一条纪律：进模型上下文的字符串不随界面语言变。
   */
  private completionNotice(event: DrivenSettledEvent, intervened = false): string {
    const childId = event.sessionId
    const title = sessionRecords.pick(childId, ['title'])?.title ?? childId
    // 状态词用与别处一致的那套；卡在等批准时明说，别让父级以为它跑完了
    const status = this.statusOf(childId)
    const asked = this.blockedOn(childId)
    const stopped = event.record.reason === 'aborted'
    return [
      `<sub-session id="${childId}" title="${title}" status="${status}"${intervened ? ' user-intervened="true"' : ''}>`,
      status === 'waiting-input'
        ? 'It stopped to ask the user for approval and cannot continue until the user answers in that session.'
        : stopped
          ? 'The turn you started was stopped by the user before it finished.'
          : event.result.error
            ? `The turn you started ended with an error: ${event.result.error}`
            : 'The turn you started in the background has finished.',
      asked?.length ? `It is asking: ${asked.join(' | ')}` : '',
      status === 'waiting-input'
        ? 'Tell the user what it is waiting for — you cannot answer it yourself.'
        : 'Collect it with the session tool: action "wait-for-sub-sessions".',
      '</sub-session>'
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ─── 停止与中止 ────────────────────────────────

  /** 中止子会话当前的 run（等价用户点「停止生成」）；被中断的那一轮同样算 */
  async stop(
    parentId: string,
    rawChildId: string
  ): Promise<{ error: string } | { stopped: boolean; id: string }> {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const resolved = this.resolveChild(parentId, rawChildId)
    if ('error' in resolved) return { error: resolved.error }
    return { stopped: await this.stopRun(resolved.id), id: resolved.id }
  }

  private async stopRun(childId: string): Promise<boolean> {
    // 经枢纽停 —— 它据此把这次落定记成「智能体自己停的」；完成通知同样不发
    const run = this.runs.get(childId)
    if (run) {
      this.agentStopped.add(run.requestId)
      if (taskRegistry.stop(run.requestId, { by: 'agent' })) return true
    }
    // 用户自己在子会话里发起的那一轮、上个进程驱动后被中断的那一轮：没有任务条目，直接停运行时。
    // 没开着又没被中断 = 没什么可停的，不为它打开会话（PIN-10）
    let agent = sessionService.getAgentSession(childId)
    if (!agent) {
      if (this.statusOf(childId) !== 'interrupted') return false
      agent = await sessionService.peekAgentSession(childId)
      if (!agent) return false
    }
    if (agent.isStreaming || agent.isInterrupted) {
      const marker = agent.drivenRun
      if (marker) this.agentStopped.add(marker.requestId)
    }
    await agent.abort()
    return true
  }

  /** 停掉子会话当前的生成（枢纽的停止实现：前台级联、面板上的停止键） */
  private async abortChild(childId: string): Promise<boolean> {
    const agent = sessionService.getAgentSession(childId)
    if (!agent) return false
    await agent.abort()
    return true
  }

  // ─── 结果抽取 ──────────────────────────────────

  /**
   * 子会话这一轮的答复（错误也在同一条路径上 —— 父级要看到的是同一份事实）。新格式会话问运行时的
   * `lastAnswer`（开着的直接问、没开就 peek，从不创建；这一轮还没回答 → 没有答复，PIN-07）；
   * 旧格式会话（父会话清空之后留下的老子会话，PIN-12）按原来的「末条消息」读。
   */
  private async lastAnswer(childId: string): Promise<AnswerFields> {
    const answer = await this.recordedAnswer(childId)
    if (answer.answer !== undefined) return answer
    // 这一轮以错误收场、却没有留下助手条目（请求失败 / run 意外失败）：交回错误原文，别只说「还没有答复」
    const error = this.turnErrors.get(childId)
    return error !== undefined && this.statusOf(childId) !== 'running'
      ? { answer: error, isError: true }
      : answer
  }

  private async recordedAnswer(childId: string): Promise<AnswerFields> {
    if (!isDurableSession(childId)) {
      const last = await messageService.findLastBySession(childId)
      if (!last) return {}
      if (last.role === 'system_notify') return { answer: last.content, isError: true }
      if (last.role !== 'assistant') return {}
      return { answer: last.content }
    }
    try {
      const agent = await this.peekFacade(childId)
      const last = await agent?.lastAnswer()
      if (!last) return {}
      return last.isError ? { answer: last.text, isError: true } : { answer: last.text }
    } catch (err) {
      log.warn(`读子会话 ${childId} 的答复失败: ${err instanceof Error ? err.message : err}`)
      return {}
    }
  }

  /**
   * 卡在询问上：**它不会自己好起来** —— 给的建议必须是能解开它的那个动作：问的是父会话能代答的问题 →
   * `answer-sub-session`（§19.4）；否则「去让用户回答」或「停掉」。
   */
  private blockedError(title: string, childId: string): string {
    const answerable = (this.pendingAsksOf(childId) ?? []).filter(
      (a): a is Extract<PendingAskInfo, { kind: 'question' }> =>
        a.kind === 'question' && a.answerable
    )
    if (answerable.length > 0) {
      return [
        `Sub-session "${title}" stopped to ask a question in the turn you started and will NOT proceed until it is answered.`,
        `It is asking: ${answerable.map((a) => `${a.question} (ask_id ${a.id})`).join(' | ')}`,
        `Answer it with "answer-sub-session", relay it to the user, or stop it with "stop-sub-session".`
      ].join(' ')
    }
    const agent = sessionService.getAgentSession(childId)
    const asked = agent?.pendingInputSummaries ?? []
    return [
      `Sub-session "${title}" is blocked on a question for the user and will NOT proceed on its own.`,
      asked.length ? `It is asking: ${asked.join(' | ')}` : '',
      `Tell the user to answer it in that session, or stop it with "stop-sub-session".`
    ]
      .filter(Boolean)
      .join(' ')
  }

  /** 没发出去（≠ 发出去了没回话）——说清是哪一种，别让调用方以为排上了队 */
  private sendFailedError(childId: string, title: string, sent: SubmitResult): string {
    if (sent.code === 'queued') {
      // 重新挂上的那一条还排在子会话的收件箱里：它没丢，跟着下一条消息出去 —— 再发一遍就重复了
      return (
        `The message was NOT delivered to sub-session "${title}" yet: ${sent.error}. ` +
        `It stays queued there and goes out with the next message it receives — do not send it again.`
      )
    }
    if (!isDurableSession(childId) && isLegacySession(childId, { rowRequired: true })) {
      // 旧格式会话只读：再发多少遍都一样，别让模型去等它空闲
      return (
        `The message was NOT delivered to sub-session "${title}": ${sent.error}. ` +
        `It was created by an earlier version of ShuviX and is read-only — it can still be read with ` +
        `"read-sub-session", but it cannot take new messages. Create a new sub-session to continue.`
      )
    }
    return (
      `The message was NOT delivered to sub-session "${title}": ${sent.error}. ` +
      `Nothing is queued — check its status with "list-sub-sessions" and send again when it is idle.`
    )
  }

  private unknownChildError(parentId: string, childId: string): string {
    const children = sessionRecords.findChildren(parentId)
    const list = children.length
      ? children.map((s) => `  ${s.id}  ${s.title}`).join('\n')
      : '  (none — create one with action "create-sub-session")'
    return `"${childId}" is not a sub-session of this session. Valid sub-sessions:\n${list}`
  }

  /** 等本进程还在途的发送全部落定 —— 仅供单测（换「进程」之前，免得上一个进程的收尾落进下一个） */
  async drainForTests(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.done))
  }

  /** 清掉进程内的记账 —— 仅供单测（真实的重跑总在新进程里，这些表本来就是空的） */
  resetForTests(): void {
    this.runs.clear()
    this.claiming.clear()
    this.records.clear()
    this.inBand.clear()
    this.agentStopped.clear()
    this.superseded.clear()
    this.waiters.clear()
    this.shownAsks.clear()
    this.confirming.clear()
    this.turnErrors.clear()
  }
}

export const subSessionRunner = new SubSessionRunner()
