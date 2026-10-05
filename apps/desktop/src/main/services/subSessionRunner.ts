/**
 * 子会话运行器 —— agent 经 `session` 工具自建会话、代替用户往里发消息（设计：docs/sub-session-design.md）。
 *
 * 子会话**就是一条普通会话**：产品行为一致，只多一个 `parentId`。因此本文件刻意薄 ——
 * 它只做几件既有机制表达不了的事：
 *
 *  1. **形态准入**：谁能当父（普通会话）、谁能被驱动（必须是调用方自己的子会话）。
 *     越权在这里落空，工具层只负责把拒绝理由翻译给模型。
 *  2. **等待与降级**：前台 await 整轮拿最终答复；超时**不杀**，降级成后台
 *     （bash 超时杀的是一个进程，这里杀的是一段用户看得见、可能已经改了半个仓库的对话）。
 *  3. **记账交给后台任务枢纽**：一次 `prompt` 就是一个任务（`services/taskRegistry`），任务 id 就是
 *     这次发送的幂等键 `subsession:<父会话>:<工具任务>`（P2-10）。「前台 / 后台」退化成同一个 `join`
 *     的两组参数（等整轮 / 只等确认发出去了）。
 *  4. **完成通知只有一条路**（P2-10 PIN-01）：子会话的 driven-run 标记落定 → 运行时的
 *     `onDrivenSettled` → 这里决定通不通知、经 `sessionService.deliverSubSessionNotice` 送达父会话
 *     （带 `subsession-done:<子会话>:<submission>`，跨进程按它去重）。枢纽自己的通知对子会话任务是关的。
 *     不通知的情形：本进程有人在前台等着它 / 已经把这次落定交回去了、`wait` 握着它 / 已经交回了它、
 *     是智能体自己停的（stop / 前台级联 / 中断父会话的级联 / 同一父会话的新消息顶掉了它），以及
 *     前台驱动它的那个父会话工具任务还活着（重跑时会就地收下答复，PIN-14 的裁定）。
 *  5. **崩溃之后的重跑**（P2-10，Q-P2-01/02）：`session` 工具是 replay `safe`，每个动作都幂等 ——
 *     `prompt` 先问子会话认不认得这个幂等键：已落定 → 直接读答复；没落定 → 重新挂上（被中断就续上），
 *     从不再发一条；`wait` 重跑时续上被中断的目标再等。父会话的「继续」因此在同一轮里把子会话带起来。
 *  6. **上限**：并发 4 / 总数 20，防的是无人值守的循环，不是正常使用。
 *
 * **发送必须走 `chatGateway.prompt`**（IPC `agent:prompt` 的同一个函数）。懒创建运行时、
 * 用户消息落树、`user_message` 广播、埋点、auto-title、自动压缩，全部因此照常发生。
 * 任何绕过这道门的实现都会让「子会话表现与普通会话一致」从第一天起就带例外。
 *
 * 中止的语义与改制前一致（Q-P2-03）：前台驱动的那一轮跟着父会话停；后台与 `wait` 的目标从不。
 * 父会话被中断（上个进程留下的）时没有活的工具信号，那条级联由会话的中止前 seam 补上
 * （`cascadeParentAbort`，PIN-08）。
 */
import { chatGateway } from '../frontend/core'
import { sessionService } from './sessionService'
import { taskRegistry } from './taskRegistry'
import { messageService } from './messageService'
import { appendModelChange, appendThinkingLevelChange, isDurableSession } from './sessionStorage'
import { sessionRecords } from './sessionRecords'
import type { AgentSession } from './agentSession'
import type { DrivenSettledEvent, SubAgentModelConfig, SubmitResult } from '@shuvix/agent-runtime'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { createLogger } from '../logger'

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

/** 前台等待的缺省上限（秒）。到点降级成后台，不中止 */
export const DEFAULT_PROMPT_TIMEOUT_SEC = 300

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
}

/** 子会话这一轮答复的那几个字段（read / wait / 前台 prompt 共用） */
export interface AnswerFields {
  answer?: string
  isError?: boolean
}

export interface WaitOutcome {
  /**
   * 'settled' = 全部跑完；'blocked' = 有人卡在**等用户批准**上（不是"完成"，
   * 报成 settled 会让父级以为成了 —— 实测里它就是这么被骗过去的）；
   * 'timeout' = 到点仍有在跑的；'aborted' = 父会话被停止。
   */
  kind: 'settled' | 'blocked' | 'timeout' | 'aborted'
  /** 等待期间关注的每条子会话（含最终状态与最新答复） */
  results: Array<SubSessionInfo & AnswerFields>
}

export interface PromptOutcome {
  /** 'answered' = 本轮跑完拿到答复；'timeout' = 降级成后台；'started' = 后台形态的启动回执 */
  kind: 'answered' | 'timeout' | 'started'
  /** 落定的子会话 id —— `sub_session_id` 省略时被自动补全成的那条，回执围栏要用真实 id */
  id: string
  /** kind==='answered' 时的最终答复（这一轮的回答；出错则是错误原文） */
  answer?: string
  /** 这一轮以错误收场 */
  isError?: boolean
  /**
   * kind==='answered' 时子会话的快照。顺带带回来是为了省掉调用方「再 read 一次」——
   * 那会把整棵转写重新投影一遍，只为拿一个标题和状态。
   */
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
 * 一次发送在完成通知眼里的样子（按幂等键记）：`held` = 有人在前台等着它（落定由那次调用交回）；
 * `released` = 没人等（后台形态、前台超时降级）—— 落定时该通知。
 */
interface DriveRecord {
  state: 'held' | 'released'
}

/** `subsession:<父会话>:<工具任务 id>` → 工具任务 id（不是这个父会话的 / 临时键 → undefined） */
function taskIdOf(requestId: string, parentId: string): number | undefined {
  const prefix = `subsession:${parentId}:`
  if (!requestId.startsWith(prefix)) return undefined
  const rest = requestId.slice(prefix.length)
  return /^\d+$/.test(rest) ? Number(rest) : undefined
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
    return {
      id: row.id,
      title: row.title,
      status: this.statusOf(row.id),
      driven: this.runs.has(row.id),
      updatedAt: row.updatedAt,
      blockedOn: this.blockedOn(row.id)
    }
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

    const last = await this.lastAnswer(childId)
    const row = sessionRecords.pick(childId, ['title', 'updatedAt'])
    return {
      info: this.info({
        id: childId,
        title: row?.title ?? resolved.title,
        updatedAt: row?.updatedAt ?? 0
      }),
      ...last
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
      await appendModelChange(childId, parent.model.provider, parent.model.model)
    }
    if (!declared?.thinkingLevel) {
      await appendThinkingLevelChange(childId, parent.thinkingLevel)
    }
  }

  // ─── 驱动 ──────────────────────────────────────

  /**
   * 代替用户往子会话发一条用户消息。
   *
   * 前台：await 整轮并返回最终答复；`timeoutSeconds` 到点降级成后台（不中止）。
   * 后台：立刻回执，跑完经完成通知告诉父会话 —— 都**不带内容**，内容会永久留在
   * 父会话上下文里并被每一步重发（bash 后台形态同一条纪律）。
   *
   * `signal` 是本次工具调用的中止信号：前台形态下父会话被停止 ⇒ 级联中止子会话当前 run
   * （与派生 agent 一致）；后台形态**不**级联，那正是后台的意义。
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
    background: boolean
    timeoutSeconds: number
    signal?: AbortSignal
    requestId?: string
  }): Promise<{ error: string } | PromptOutcome> {
    const { parentId, message, background, timeoutSeconds, signal } = params
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
      return {
        error:
          `Sub-session "${child.title}" is already running a turn you just started. ` +
          `One sub-session runs one turn at a time — wait for it with "wait-for-sub-sessions", ` +
          `or create another sub-session to work in parallel.`
      }
    }
    const requestId =
      params.requestId ?? `subsession:${parentId}:adhoc-${globalThis.crypto.randomUUID()}`
    this.claiming.add(childId)
    // 先记下这次发送，再做任何异步判定：子会话被打开的那一刻就可能报出一次落定（打开时的扫描）
    const record: DriveRecord = { state: background ? 'released' : 'held' }
    this.records.set(requestId, record)

    let run: DrivenRun
    try {
      const known =
        params.requestId === undefined ? 'none' : await this.requestStateOf(childId, requestId)

      if (known === 'settled') {
        // 崩溃之前就落定了：不再发送，答复就在子会话里（PIN-03）
        const consumed = this.dropRecord(requestId, record)
        if (background) return { kind: 'started', id: childId }
        if (!consumed) this.inBand.add(requestId)
        const [answer, info] = await Promise.all([
          this.lastAnswer(childId),
          this.infoOf(parentId, childId)
        ])
        return { kind: 'answered', id: childId, ...answer, ...(info ? { info } : {}) }
      }

      if (known === 'none') {
        const refusal = this.freshSendRefusal(parentId, child)
        if (refusal) {
          this.dropRecord(requestId, record)
          return { error: refusal }
        }
        await this.noteSupersede(parentId, childId, requestId)
      }

      taskRegistry.create({
        taskId: requestId,
        kind: 'sub-session',
        sessionId: parentId,
        title: child.title,
        subject: { kind: 'sub-session', childSessionId: childId },
        // 不给 formatNotice：子会话的完成通知只走 onDrivenSettled 这一条路（PIN-01）
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
            driven: { parentId, background }
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

    // 同步等待 —— 两种形态的差别全在这组参数里：
    //   后台只等「确认发出去了」（发送失败是同步落定的，正常那一路要跑到轮结束）；
    //   前台等整轮，到点**不杀**、转异步（杀掉的会是一段用户看得见、可能已改了半个仓库的对话）。
    // 前台才接中止信号：父会话被停 ⇒ 级联停子会话当前 run；后台形态不级联，那正是后台的意义。
    const outcome = await taskRegistry.join(requestId, {
      maxWait: background ? SEND_CONFIRM_MS : Math.max(1, timeoutSeconds) * 1000,
      onTimeout: 'detach',
      ...(background ? {} : { signal, onAbort: 'kill' as const })
    })

    if (outcome?.kind === 'detached') {
      // 没人等它了：它此后落定就该通知
      record.state = 'released'
      if (background) {
        log.info(`prompt sub-session ${childId} (background)`)
        return { kind: 'started', id: childId }
      }
      // 卡在询问上的不是「还在跑」——它不会自己好起来，说成还在跑等于让父级白等第二轮
      if (this.statusOf(childId) === 'waiting-input') {
        return { error: this.blockedError(child.title, childId) }
      }
      log.info(`子会话 ${childId} 前台等待超时 ${timeoutSeconds}s，降级为后台`)
      return { kind: 'timeout', id: childId }
    }

    // 落定（含被中止后收尾）：run.done 此刻必然已 resolve
    const sent = await run.done
    if (sent.error && (sent.code === undefined || NOT_DELIVERED.has(sent.code))) {
      this.dropRecord(requestId, record)
      return { error: this.sendFailedError(child.title, sent) }
    }
    if (background) {
      log.info(`prompt sub-session ${childId} (background)`)
      return { kind: 'started', id: childId }
    }
    // 前台答复由这次调用交回：完成通知不再发（不论它比这里早到还是晚到）
    if (!this.dropRecord(requestId, record)) this.inBand.add(requestId)
    const [answer, info] = await Promise.all([
      this.lastAnswer(childId),
      this.infoOf(parentId, childId)
    ])
    // 那一轮以错误收场（模型请求失败 / run 意外失败 / 接不上，PIN-02）：答复是错误原文
    const reply: AnswerFields = sent.error
      ? answer.isError
        ? answer
        : { answer: sent.error, isError: true }
      : answer
    return { kind: 'answered', id: childId, ...reply, ...(info ? { info } : {}) }
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
      const blocked = results.some((r) => r.status === 'waiting-input')
      return { kind: blocked ? 'blocked' : 'settled', results }
    }

    // 先登记成「被 wait 握着」、再续上：先续上的那一条可能在后一条还在打开时就落定了 —— 那次落定要在同一轮里
    // 交回（不通知父会话），所以握着它这件事必须早于它被续上（P2-12 K1-05）
    for (const id of targets) this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1)
    let kind: 'settled' | 'timeout' | 'aborted'
    try {
      for (const id of resume) await this.resumeChild(id)
      const settled = (): boolean => targets.every((id) => this.statusOf(id) !== 'running')
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
    } finally {
      for (const id of targets) {
        const n = (this.waiters.get(id) ?? 1) - 1
        if (n > 0) this.waiters.set(id, n)
        else this.waiters.delete(id)
      }
    }
    const results = await this.infoWithAnswers(parentId, targets)
    // 落定了但有人卡在等批准 —— 那不是「完成」，外层状态必须说清楚
    const blocked = results.some((r) => r.status === 'waiting-input')
    return { kind: kind === 'settled' && blocked ? 'blocked' : kind, results }
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
      children.map(async (s) => ({ ...this.info(s), ...(await this.lastAnswer(s.id)) }))
    )
  }

  /** 一次驱动结束：销账，把结果交回枢纽（解挂等待者；枢纽对子会话任务不发通知） */
  private settle(childId: string, run: DrivenRun, sent: SubmitResult): void {
    if (this.runs.get(childId) === run) this.runs.delete(childId)
    taskRegistry.settle(run.requestId, { status: sent?.error ? 'error' : 'done' })
  }

  // ─── 完成通知（P2-10 PIN-01） ──────────────────

  /**
   * 运行时报来子会话被驱动的那一轮落定了（`SessionHostDeps.onDrivenSettled`，每个进程至多一次）。
   * 该通知就送达父会话；送达失败**拒绝** —— 运行时留着标记，下次打开再报。被抑制 = 正常返回。
   * 与发送那一侧谁先谁后无关：抑制条件两边都记。
   */
  async onDrivenSettled(event: DrivenSettledEvent): Promise<void> {
    if (await this.suppressNotice(event)) {
      log.info(`子会话 ${event.sessionId} 的完成通知不发 request=${event.requestId}`)
      return
    }
    await sessionService.deliverSubSessionNotice(
      event.parentId,
      this.completionNotice(event),
      event.noticeRequestId
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
    // 本进程有人在前台等着它（结果由那次调用交回）/ 已经在同一轮里交回去了
    if (record?.state === 'held') return true
    if (this.inBand.delete(requestId)) return true
    // wait 正握着它：落定会在同一轮里交回去
    if (this.waiters.has(childId)) return true
    // 本进程不认得的前台驱动（上个进程发的、用户先在子会话里把它续完了）：驱动它的那个父会话工具任务
    // 还活着 → 父会话重跑时会就地收下答复，不通知（PIN-14 的裁定）；任务已终结才通知
    if (!record && !event.background) return this.parentTaskLive(event.parentId, requestId)
    return false
  }

  /** 发起这次前台驱动的父会话工具任务还活着吗（peek 父会话，从不创建；不认得的键 → false） */
  private async parentTaskLive(parentId: string, requestId: string): Promise<boolean> {
    const taskId = taskIdOf(requestId, parentId)
    if (taskId === undefined || !isDurableSession(parentId)) return false
    const parent = await this.peekFacade(parentId)
    if (!parent) return false
    return (await parent.taskLiveness(taskId))?.live === true
  }

  /**
   * 给父会话的完成回报（P2-10 PIN-16：沿用原来的模板，被用户停掉的那一轮多一句）。
   *
   * 回执**不带内容**（照抄 bash 后台形态）：内容会永久留在父会话上下文里并被每一步重发，
   * 要结果就去收。文案是模型面向的英文而非 i18n —— 与 bgTaskService.formatExitNotice
   * 同一条纪律：进模型上下文的字符串不随界面语言变。
   */
  private completionNotice(event: DrivenSettledEvent): string {
    const childId = event.sessionId
    const title = sessionRecords.pick(childId, ['title'])?.title ?? childId
    // 状态词用与别处一致的那套；卡在等批准时明说，别让父级以为它跑完了
    const status = this.statusOf(childId)
    const asked = this.blockedOn(childId)
    const stopped = event.record.reason === 'aborted'
    return [
      `<sub-session id="${childId}" title="${title}" status="${status}">`,
      status === 'waiting-input'
        ? 'It stopped to ask the user for approval and cannot continue until the user answers in that session.'
        : stopped
          ? 'The turn you started was stopped by the user before it finished.'
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

  /**
   * 父会话的中止级联到它前台驱动着、此刻被中断的子会话（P2-10 PIN-08，Q-P2-03）。
   *
   * 父会话在跑时，级联走的是工具调用的中止信号（`join` 的 onAbort:'kill'）；父会话被中断（上个进程留下的）
   * 时没有活的信号，由会话的中止前 seam 走到这里：只中止 driven-run 标记是**前台**、由这个父会话发起、
   * 发起它的工具任务此刻还活着（或正是被这次中止标记的）的那几条。后台、`wait` 的目标、早先已经超时降级
   * 的前台（工具任务已正常终结）一概不碰。不通知；peek，从不创建；幂等（已经不再被中断的跳过）。
   */
  async cascadeParentAbort(parentId: string): Promise<void> {
    const children = sessionRecords.findChildren(parentId)
    if (children.length === 0) return
    for (const child of children) {
      try {
        if (this.statusOf(child.id) !== 'interrupted') continue
        const agent = await this.peekFacade(child.id)
        if (!agent?.isInterrupted) continue
        const marker = agent.drivenRun
        if (!marker || marker.background || marker.parentId !== parentId) continue
        const taskId = taskIdOf(marker.requestId, parentId)
        if (taskId === undefined) continue
        const parent = await this.peekFacade(parentId)
        const liveness = await parent?.taskLiveness(taskId)
        if (!liveness || !(liveness.live || liveness.abortRequested)) continue
        this.agentStopped.add(marker.requestId)
        log.info(`父会话 ${parentId} 中止 → 级联中止被中断的子会话 ${child.id}`)
        await agent.abort()
      } catch (err) {
        log.warn(`级联中止子会话 ${child.id} 失败: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // ─── 结果抽取 ──────────────────────────────────

  /**
   * 子会话这一轮的答复（错误也在同一条路径上 —— 父级要看到的是同一份事实）。新格式会话问运行时的
   * `lastAnswer`（开着的直接问、没开就 peek，从不创建；这一轮还没回答 → 没有答复，PIN-07）；
   * 旧格式会话（父会话清空之后留下的老子会话，PIN-12）按原来的「末条消息」读。
   */
  private async lastAnswer(childId: string): Promise<AnswerFields> {
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

  /** 卡在询问上：**它不会自己好起来** —— 给的建议必须是「去让用户回答」或「停掉」 */
  private blockedError(title: string, childId: string): string {
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
  private sendFailedError(title: string, sent: SubmitResult): string {
    if (sent.code === 'queued') {
      // 重新挂上的那一条还排在子会话的收件箱里：它没丢，跟着下一条消息出去 —— 再发一遍就重复了
      return (
        `The message was NOT delivered to sub-session "${title}" yet: ${sent.error}. ` +
        `It stays queued there and goes out with the next message it receives — do not send it again.`
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
  }
}

export const subSessionRunner = new SubSessionRunner()
