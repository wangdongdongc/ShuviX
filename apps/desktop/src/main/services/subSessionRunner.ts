/**
 * 子会话运行器 —— agent 经 `session` 工具自建会话、代替用户往里发消息（设计：docs/sub-session-design.md）。
 *
 * 子会话**就是一条普通会话**：产品行为一致，只多一个 `parentId`。因此本文件刻意薄 ——
 * 它只做四件既有机制表达不了的事：
 *
 *  1. **形态准入**：谁能当父（普通会话）、谁能被驱动（必须是调用方自己的子会话）。
 *     越权在这里落空，工具层只负责把拒绝理由翻译给模型。
 *  2. **等待与降级**：前台 await 整轮拿最终答复；超时**不杀**，降级成后台
 *     （bash 超时杀的是一个进程，这里杀的是一段用户看得见、可能已经改了半个仓库的对话）。
 *  3. **后台记账与回报**：跑完经 `AgentSession.notify` 告诉父会话 —— 与后台任务
 *     （bgTaskService → setBgTaskNotifier）同一条线，语义完全相同，不新发明通道。
 *  4. **上限**：并发 4 / 总数 20，防的是无人值守的循环，不是正常使用。
 *
 * **发送必须走 `chatGateway.prompt`**（IPC `agent:prompt` 的同一个函数）。懒创建运行时、
 * 用户消息落树、`user_message` 广播、埋点、auto-title、自动压缩，全部因此照常发生。
 * 任何绕过这道门的实现都会让「子会话表现与普通会话一致」从第一天起就带例外。
 */
import { chatGateway } from '../frontend/core'
import { sessionService } from './sessionService'
import { messageService } from './messageService'
import {
  appendModelChange,
  appendThinkingLevelChange,
  appendActiveToolsChange
} from './sessionStorage'
import { sessionDao } from '../dao/sessionDao'
import { isChatSessionSettings } from '@shuvix/chat-protocol/chatSession'
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'
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

export type SubSessionStatus = 'idle' | 'running' | 'waiting-input'

export interface SubSessionInfo {
  id: string
  title: string
  status: SubSessionStatus
  /** 本进程是否正在替父会话驱动它（用户自己在里面发消息时为 false，status 仍是 running） */
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

export interface WaitOutcome {
  /**
   * 'settled' = 全部跑完；'blocked' = 有人卡在**等用户批准**上（不是"完成"，
   * 报成 settled 会让父级以为成了 —— 实测里它就是这么被骗过去的）；
   * 'timeout' = 到点仍有在跑的；'aborted' = 父会话被停止。
   */
  kind: 'settled' | 'blocked' | 'timeout' | 'aborted'
  /** 等待期间关注的每条子会话（含最终状态与最新答复） */
  results: Array<SubSessionInfo & { answer?: string; isError?: boolean }>
}

export interface PromptOutcome {
  /** 'answered' = 本轮跑完拿到答复；'timeout' = 降级成后台；'started' = 后台形态的启动回执 */
  kind: 'answered' | 'timeout' | 'started'
  /** kind==='answered' 时的最终答复（末条消息的正文；出错则是错误原文） */
  answer?: string
  /** 末条消息是错误事件 */
  isError?: boolean
  /**
   * kind==='answered' 时子会话的快照。顺带带回来是为了省掉调用方「再 read 一次」——
   * 那会把整棵转写重新投影一遍，只为拿一个标题和状态。
   */
  info?: SubSessionInfo
}

/** 本进程正在驱动的一次子会话运行 */
interface DrivenRun {
  parentId: string
  /**
   * 整轮结束的 promise（永不 reject）。落定值带 `error` = **消息没发出去**
   * （最典型：子会话正忙，pi 拒 busy）—— 与「发出去了但没回话」必须分得开，
   * 后者才是「还在跑」。混为一谈会让调用方以为消息排上了队。
   */
  done: Promise<{ error?: string }>
  /** 已降级为后台（前台超时）或本就是后台形态 */
  background: boolean
  /** 被 stop-sub-session / 父级级联中止过 —— 完成通知据此不说「跑完了」 */
  stopped?: boolean
}

class SubSessionRunner {
  private runs = new Map<string, DrivenRun>()
  /** 正在被 `wait` 等着的子会话 —— 它们落定时不再另发完成通知（同一轮里就交回去了） */
  private waiters = new Set<string>()

  // ─── 准入 ──────────────────────────────────────

  /**
   * 调用方会话必须是**普通会话**：聊天会话没有根 agent，笔记本会话的人格钉死在
   * notebook 基座上、产物是那份笔记 —— 两者开子会话都不表达任何东西。
   * 返回错误文案（null = 通过）。
   */
  private rejectIfNotNormal(sessionId: string): string | null {
    const s = sessionDao.pick(sessionId, ['settings', 'parentId'])
    if (!s) return 'This task is not attached to a session — sub-sessions are unavailable here.'
    if (isChatSessionSettings(s.settings)) return 'Chat sessions cannot have sub-sessions.'
    if (s.settings?.notebookPath) return 'Notebook sessions cannot have sub-sessions.'
    if (s.parentId) {
      return 'This is already a sub-session — nesting is limited to one level. Ask the parent session instead.'
    }
    return null
  }

  /** 取调用方名下的子会话（不存在 / 不是它的孩子都返回 null —— 越权在这里落空） */
  private ownChild(parentId: string, childId: string): { id: string; title: string } | null {
    const child = sessionDao.pick(childId, ['title', 'parentId'])
    if (!child || child.parentId !== parentId) return null
    return { id: childId, title: child.title }
  }

  // ─── 查询 ──────────────────────────────────────

  /**
   * 状态取自运行时而不是本地记账：用户自己在子会话里发消息同样是 running，
   * 一个只认「我发起的」记账会把那种情况报成 idle。
   */
  /** 待答询问的摘要（只有 waiting-input 时有意义） */
  private blockedOn(sessionId: string): string[] | undefined {
    const asked = sessionService.getAgentSession(sessionId)?.pendingInputSummaries ?? []
    return asked.length > 0 ? asked : undefined
  }

  private statusOf(sessionId: string): SubSessionStatus {
    const agent = sessionService.getAgentSession(sessionId)
    if (!agent) return 'idle'
    if (agent.pendingInputCount > 0) return 'waiting-input'
    return agent.isStreaming ? 'running' : 'idle'
  }

  list(parentId: string): { error: string } | { subSessions: SubSessionInfo[] } {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    return {
      subSessions: sessionDao.findChildren(parentId).map((s) => ({
        id: s.id,
        title: s.title,
        status: this.statusOf(s.id),
        driven: this.runs.has(s.id),
        updatedAt: s.updatedAt,
        blockedOn: this.blockedOn(s.id)
      }))
    }
  }

  async read(
    parentId: string,
    childId: string
  ): Promise<{ error: string } | { info: SubSessionInfo; answer?: string; isError?: boolean }> {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const child = this.ownChild(parentId, childId)
    if (!child) return { error: this.unknownChildError(parentId, childId) }

    const last = await this.lastAnswer(childId)
    const row = sessionDao.pick(childId, ['title', 'updatedAt'])
    return {
      info: {
        id: childId,
        title: row?.title ?? child.title,
        status: this.statusOf(childId),
        driven: this.runs.has(childId),
        updatedAt: row?.updatedAt ?? 0,
        blockedOn: this.blockedOn(childId)
      },
      ...last
    }
  }

  // ─── 创建 ──────────────────────────────────────

  /**
   * 建一条子会话。
   *
   * **子会话继承父会话此刻的整套设置**：projectId（工作目录是会话的地基）、模型、
   * 思考档位、mcp:/skill: 勾选，以及免询问开关（后者在 `sessionService.create`，
   * 它是 settings 一列；其余三项是会话树上的 change entry，在这里种）。不继承就会
   * 回落全局默认 ——「我用 opus 开着这套 MCP 干活、我开的子会话掉回默认模型、
   * 一个 skill 都没有」是纯粹的意外，而它跟父级在同一个目录里干同一件事。
   *
   * 唯一压过继承的是**档案自己的声明**（更具体的意图）：`shuvix-model` 定了模型就用它，
   * `shuvix-tools` 里列了 mcp:/skill: 就用它那套。档案没声明 = 没有意见，继承父会话。
   *
   * 标题由父级给 ⇒ 记 `titleOrigin: 'user'`：那是一次刻意命名，auto-title 的 refine
   * 阶段不该覆盖它。父级不给 ⇒ 留默认标题，auto-title 照常接管。
   */
  async create(
    parentId: string,
    params: { title?: string; agentProfile?: string }
  ): Promise<{ error: string } | { id: string; title: string }> {
    // 建完是一条**空会话**：首条消息不在这里发，也不在工具层顺手代发 —— 派活恒经
    // `prompt`，形态（前台等 / run_in_background）由派活的那次调用自己选。
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }

    const existing = sessionDao.findChildren(parentId)
    if (existing.length >= MAX_SUB_SESSIONS) {
      return {
        error:
          `This session already has ${existing.length}/${MAX_SUB_SESSIONS} sub-sessions. ` +
          `Reuse one of them, or ask the user to delete some:\n` +
          existing.map((s) => `  ${s.id}  ${s.title}`).join('\n')
      }
    }

    const title = params.title?.trim()
    const session = sessionService.create({ parentId, ...(title ? { title } : {}) })
    if (title) sessionService.updateTitle(session.id, title, 'user')

    // 档案：父级点名则用它（准入与 /<agent> 切换同源 —— 未声明会话感知的档案照样被拒），
    // 否则跟随父会话当前档案。与 `create` 刚按会话形态落下的默认档案相同就不必再切一次
    // （空切一次只是白走一遍失效 + 广播）。切了的那次会把 mcp:/skill: 勾选替换成档案声明的
    // 那套，紧接着的 seedRunConfig 负责在档案没声明时把父会话那套补回去
    const stamped = sessionDao.pickSettings(session.id, ['agentProfile'])?.agentProfile
    const profileName =
      params.agentProfile?.trim() || sessionService.resolveAgentProfileName(parentId)
    let declared: { model?: SubAgentModelConfig; tools: string[] } | undefined
    if (profileName && profileName !== stamped) {
      const applied = await sessionService.updateAgentProfile(session.id, profileName)
      if (applied.success) declared = applied.applied
      // 档案不合法不该让整个创建失败：会话已经建好且可用（回落 default），记日志即可
      else log.warn(`子会话 ${session.id} 档案 "${profileName}" 未生效: ${applied.error}`)
    }
    await this.seedRunConfig(parentId, session.id, declared)

    log.info(`create sub-session ${session.id} parent=${parentId} profile=${profileName ?? '-'}`)
    return { id: session.id, title: sessionDao.pick(session.id, ['title'])?.title ?? session.title }
  }

  /**
   * 把父会话此刻的运行配置作为种子写进子会话树：模型 / 思考档位 / mcp:/skill: 勾选。
   *
   * 抄的是**解析后**的值（`resolveRunConfig`）而不是「树上显式改过的那些」：父会话大多数
   * 键根本没显式改过，只抄显式值等于什么也没继承 —— 而「回落默认」在子会话身上并不等价，
   * 档案切换那一步（`updateAgentProfile`）已经把工具勾选显式写成了档案声明的那套。
   *
   * `declared` 是档案声明的那部分（档案切换生效时才有），它压过继承 —— 更具体的意图。
   * 但**空的工具声明不算意见**：内置 coding / explore 之流的 `shuvix-tools` 只列内置工具，
   * 按「完整声明」解读就等于把项目的 MCP 与 skill 从每一条子会话上摘掉，而那从来不是
   * 档案作者在那一行里表达的东西（与 `/<agent>` 切换的口径刻意不同：那是用户在一条已经
   * 跑着的会话上换人格，这里是给一条空会话铺开父级的工作环境）。
   */
  private async seedRunConfig(
    parentId: string,
    childId: string,
    declared?: { model?: SubAgentModelConfig; tools: string[] }
  ): Promise<void> {
    const parent = await sessionService.resolveRunConfig(parentId)
    if (!parent) return
    if (!declared?.model && parent.model) {
      await appendModelChange(childId, parent.model.provider, parent.model.model)
    }
    // 思考档位没有档案声明这一路，恒随父会话
    await appendThinkingLevelChange(childId, parent.thinkingLevel)
    if (!declared?.tools.length && parent.enabledTools.length) {
      await appendActiveToolsChange(childId, parent.enabledTools)
    }
  }

  // ─── 驱动 ──────────────────────────────────────

  /**
   * 代替用户往子会话发一条用户消息。
   *
   * 前台：await 整轮并返回最终答复；`timeoutSeconds` 到点降级成后台（不中止）。
   * 后台：立刻回执，跑完经 notify 告诉父会话 —— 都**不带内容**，内容会永久留在
   * 父会话上下文里并被每一步重发（bash 后台形态同一条纪律）。
   *
   * `signal` 是本次工具调用的中止信号：前台形态下父会话被停止 ⇒ 级联中止子会话当前 run
   * （与派生 agent 一致）；后台形态**不**级联，那正是后台的意义。
   */
  async prompt(params: {
    parentId: string
    childId: string
    message: string
    background: boolean
    timeoutSeconds: number
    signal?: AbortSignal
  }): Promise<{ error: string } | PromptOutcome> {
    const { parentId, childId, message, background, timeoutSeconds, signal } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    const child = this.ownChild(parentId, childId)
    if (!child) return { error: this.unknownChildError(parentId, childId) }
    if (!message.trim())
      return { error: 'Pass the message text in `message` (a non-empty string).' }

    // 忙就拒绝，刻意不排队（harness 有 nextTurn 可以排）：一个忙着的子会话是父级
    // 该知道并作决策的状态，替它排队等于把这个状态藏起来。
    //
    // **同步占位先于异步判定**：两个 prompt 在同一轮里并发进来时，`statusOf` 查的是
    // 运行时，而运行时是懒创建的（第一条还没把它建出来），于是两边都判「空闲」双双放行
    // —— 第二条随后被 pi 拒 busy，而那个错误一路被吞掉，回到模型眼里成了「已提交、
    // 排队中」。这一行让第二条当场拿到拒绝理由。
    if (this.runs.has(childId)) {
      return {
        error:
          `Sub-session "${child.title}" is already running a turn you just started. ` +
          `One sub-session runs one turn at a time — wait for it with "wait-for-sub-sessions", ` +
          `or create another sub-session to work in parallel.`
      }
    }
    const status = this.statusOf(childId)
    if (status === 'waiting-input') {
      // 「等它」在这里是错的建议：它不会自己好起来
      return { error: this.blockedError(child.title, childId) }
    }
    if (status !== 'idle') {
      return {
        error:
          `Sub-session "${child.title}" is ${status}. ` +
          `Collect it with action "wait-for-sub-sessions", or stop it with "stop-sub-session".`
      }
    }

    const running = [...this.runs.entries()]
      .filter(([id, r]) => r.parentId === parentId && this.statusOf(id) !== 'idle')
      .map(([id]) => id)
    if (running.length >= MAX_RUNNING_SUB_SESSIONS) {
      return {
        error:
          `Too many sub-sessions running (${running.length}/${MAX_RUNNING_SUB_SESSIONS}). ` +
          `Wait for one to finish before starting another.`
      }
    }

    const run: DrivenRun = {
      parentId,
      background,
      // 永不 reject，但**保留 error**：发送失败与「跑完了没说话」是两件事
      done: chatGateway.prompt(childId, message).catch((err) => {
        log.warn(`子会话 ${childId} 发送失败: ${err}`)
        return { error: err instanceof Error ? err.message : String(err) }
      })
    }
    this.runs.set(childId, run)
    void run.done.then(() => this.settle(childId, run))

    if (background) {
      // 后台形态也要确认「发出去了」：竞态窗口收窄之后仍可能失败（压缩相位等），
      // 而一张假回执会让父级去等一个根本没开始的活
      const sendError = await Promise.race([
        run.done,
        new Promise<{ error?: string }>((r) => setTimeout(() => r({}), SEND_CONFIRM_MS))
      ])
      if (sendError.error) return { error: this.sendFailedError(child.title, sendError.error) }
      log.info(`prompt sub-session ${childId} (background)`)
      return { kind: 'started' }
    }

    const raced = await this.waitForeground(run, timeoutSeconds, signal)
    if (raced === 'timeout') {
      // 卡在询问上的不是「还在跑」——它不会自己好起来，说成还在跑等于让父级白等第二轮
      if (this.statusOf(childId) === 'waiting-input') {
        run.background = true
        return { error: this.blockedError(child.title, childId) }
      }
      // 降级：本次调用不再等，运行继续，跑完照后台形态回报
      run.background = true
      log.info(`子会话 ${childId} 前台等待超时 ${timeoutSeconds}s，降级为后台`)
      return { kind: 'timeout' }
    }
    if (raced === 'aborted') {
      await this.stopRun(childId)
      await run.done
    }
    const sent = await run.done
    if (sent.error) return { error: this.sendFailedError(child.title, sent.error) }
    const [answer, info] = await Promise.all([
      this.lastAnswer(childId),
      this.infoOf(parentId, childId)
    ])
    return { kind: 'answered', ...answer, ...(info ? { info } : {}) }
  }

  /** 单条子会话的快照（不含答复；lastAnswer 另取） */
  private infoOf(parentId: string, childId: string): SubSessionInfo | undefined {
    const row = sessionDao.findChildren(parentId).find((s) => s.id === childId)
    if (!row) return undefined
    return {
      id: row.id,
      title: row.title,
      status: this.statusOf(row.id),
      driven: this.runs.has(row.id),
      updatedAt: row.updatedAt,
      blockedOn: this.blockedOn(row.id)
    }
  }

  /**
   * 阻塞等到子会话跑完并**一次性交回结果** —— 「起了几条、现在要收」的正解。
   *
   * 存在的理由是它替掉的那个东西：没有它，模型只能 `sleep` + 反复 list/read，
   * 而每一轮轮询都是一次完整请求（系统提示词 + 整段历史 + 全部工具定义重发一遍），
   * 换回来的往往是一句「还没好」。这里一次调用挂住,结果一次交齐。
   *
   * `childId` 省略 = 等本会话**此刻还没空闲的全部**子会话。
   * `waiting-input`（卡在 ask 上等人回答）算落定 —— 它不会自己好起来，继续等只是白等，
   * 结果里如实标出状态让父级去决定（催用户、还是先干别的）。
   * 中止**不**级联杀子会话：等待是只读动作，父级被停不该连累后台在跑的活。
   */
  async wait(params: {
    parentId: string
    childId?: string
    timeoutSeconds: number
    signal?: AbortSignal
  }): Promise<{ error: string } | WaitOutcome> {
    const { parentId, childId, timeoutSeconds, signal } = params
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }

    let targets: string[]
    if (childId) {
      if (!this.ownChild(parentId, childId)) {
        return { error: this.unknownChildError(parentId, childId) }
      }
      targets = [childId]
    } else {
      targets = sessionDao
        .findChildren(parentId)
        .map((s) => s.id)
        .filter((id) => this.statusOf(id) === 'running')
    }
    if (targets.length === 0) {
      const results = await this.infoWithAnswers(parentId)
      const blocked = results.some((r) => r.status === 'waiting-input')
      return { kind: blocked ? 'blocked' : 'settled', results }
    }

    for (const id of targets) this.waiters.add(id)
    const settled = (): boolean => targets.every((id) => this.statusOf(id) !== 'running')
    const kind = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
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

    for (const id of targets) this.waiters.delete(id)
    const results = await this.infoWithAnswers(parentId, targets)
    // 落定了但有人卡在等批准 —— 那不是「完成」，外层状态必须说清楚
    const blocked = results.some((r) => r.status === 'waiting-input')
    return { kind: kind === 'settled' && blocked ? 'blocked' : kind, results }
  }

  /** 子会话快照 + 各自最新答复（wait 的返回形状；ids 省略 = 全部子会话） */
  private async infoWithAnswers(
    parentId: string,
    ids?: string[]
  ): Promise<Array<SubSessionInfo & { answer?: string; isError?: boolean }>> {
    const children = sessionDao.findChildren(parentId).filter((s) => !ids || ids.includes(s.id))
    return Promise.all(
      children.map(async (s) => ({
        id: s.id,
        title: s.title,
        status: this.statusOf(s.id),
        driven: this.runs.has(s.id),
        updatedAt: s.updatedAt,
        blockedOn: this.blockedOn(s.id),
        ...(await this.lastAnswer(s.id))
      }))
    )
  }

  /** 前台等待：整轮结束 / 超时 / 父会话被中止，三者先到者胜 */
  private waitForeground(
    run: DrivenRun,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<'done' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (r: 'done' | 'timeout' | 'aborted'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const onAbort = (): void => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), Math.max(1, timeoutSeconds) * 1000)
      if (signal?.aborted) return finish('aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
      void run.done.then(() => finish('done'))
    })
  }

  /**
   * 一次驱动结束：销账；后台形态（含降级来的）向父会话回报。
   *
   * 回执**不带内容**（照抄 bash 后台形态）：内容会永久留在父会话上下文里并被每一步重发，
   * 要结果就去 read。文案是模型面向的英文而非 i18n —— 与 bgTaskService.formatExitNotice
   * 同一条纪律：进模型上下文的字符串不随界面语言变。
   */
  private settle(childId: string, run: DrivenRun): void {
    if (this.runs.get(childId) === run) this.runs.delete(childId)
    if (!run.background) return
    // 已经有人在 wait 它 —— 结果会在**同一轮里**交回去，再补一条通知只会让父级
    // 把刚拿到的东西再读一遍（实测里就白烧了一轮）
    if (this.waiters.has(childId)) return
    // 被停掉的那次不用通知：停它的就是父级自己（stop-sub-session / 前台级联），
    // 它早就知道。实测里这条通知反而把父级叫醒去「收」一个它刚亲手停掉的东西
    if (run.stopped) return
    const parent = sessionService.getAgentSession(run.parentId)
    if (!parent) return
    const title = sessionDao.pick(childId, ['title'])?.title ?? childId
    // 状态词用与别处一致的那套；卡在等批准时明说，别让父级以为它跑完了
    const status = this.statusOf(childId)
    const asked = this.blockedOn(childId)
    const notice = [
      `<sub-session id="${childId}" title="${title}" status="${status}">`,
      status === 'waiting-input'
        ? 'It stopped to ask the user for approval and cannot continue until the user answers in that session.'
        : 'The turn you started in the background has finished.',
      asked?.length ? `It is asking: ${asked.join(' | ')}` : '',
      status === 'waiting-input'
        ? 'Tell the user what it is waiting for — you cannot answer it yourself.'
        : 'Collect it with the session tool: action "wait-for-sub-sessions".',
      '</sub-session>'
    ]
      .filter(Boolean)
      .join('\n')
    void parent
      .notify(notice)
      .catch((err) => log.warn(`子会话完成通知失败 parent=${run.parentId}: ${err}`))
  }

  /** 中止子会话当前的 run（等价用户点「停止生成」） */
  async stop(parentId: string, childId: string): Promise<{ error: string } | { stopped: boolean }> {
    const rejected = this.rejectIfNotNormal(parentId)
    if (rejected) return { error: rejected }
    if (!this.ownChild(parentId, childId)) {
      return { error: this.unknownChildError(parentId, childId) }
    }
    return { stopped: await this.stopRun(childId) }
  }

  private async stopRun(childId: string): Promise<boolean> {
    const run = this.runs.get(childId)
    if (run) run.stopped = true
    const agent = sessionService.getAgentSession(childId)
    if (!agent) return false
    await agent.abort()
    return true
  }

  // ─── 结果抽取 ──────────────────────────────────

  /** 末条消息的正文（错误事件也在同一条路径上 —— 父级要看到的是同一份事实） */
  private async lastAnswer(childId: string): Promise<{ answer?: string; isError?: boolean }> {
    const last = await messageService.findLastBySession(childId)
    if (!last) return {}
    if (last.role === 'system_notify') return { answer: last.content, isError: true }
    if (last.role !== 'assistant') return {}
    return { answer: last.content }
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
  private sendFailedError(title: string, reason: string): string {
    return (
      `The message was NOT delivered to sub-session "${title}": ${reason}. ` +
      `Nothing is queued — check its status with "list-sub-sessions" and send again when it is idle.`
    )
  }

  private unknownChildError(parentId: string, childId: string): string {
    const children = sessionDao.findChildren(parentId)
    const list = children.length
      ? children.map((s) => `  ${s.id}  ${s.title}`).join('\n')
      : '  (none — create one with action "create-sub-session")'
    return `"${childId}" is not a sub-session of this session. Valid sub-sessions:\n${list}`
  }
}

export const subSessionRunner = new SubSessionRunner()
