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
import { DEFAULT_PROFILE_NAME } from '@shuvix/agent-runtime'
import { chatGateway } from '../frontend/core'
import { sessionService } from './sessionService'
import { messageService } from './messageService'
import { appendModelChange } from './sessionStorage'
import { sessionDao } from '../dao/sessionDao'
import { createLogger } from '../logger'

const log = createLogger('SubSession')

/** 一个父会话最多同时在跑的子会话数。bg 任务是 8，这里取一半 —— 一条 LLM 会话远贵于一个进程 */
export const MAX_RUNNING_SUB_SESSIONS = 4
/** 一个父会话最多拥有的子会话数（只数未删除的） */
export const MAX_SUB_SESSIONS = 20
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
}

export interface PromptOutcome {
  /** 'answered' = 本轮跑完拿到答复；'timeout' = 降级成后台；'started' = 后台形态的启动回执 */
  kind: 'answered' | 'timeout' | 'started'
  /** kind==='answered' 时的最终答复（末条消息的正文；出错则是错误原文） */
  answer?: string
  /** 末条消息是错误事件 */
  isError?: boolean
}

/** 本进程正在驱动的一次子会话运行 */
interface DrivenRun {
  parentId: string
  /** 整轮结束的 promise（永不 reject —— 失败已在会话里表达） */
  done: Promise<void>
  /** 已降级为后台（前台超时）或本就是后台形态 */
  background: boolean
}

class SubSessionRunner {
  private runs = new Map<string, DrivenRun>()

  // ─── 准入 ──────────────────────────────────────

  /**
   * 调用方会话必须是**普通会话**：群聊会话没有根 agent，笔记本会话的人格钉死在
   * notebook 基座上、产物是那份笔记 —— 两者开子会话都不表达任何东西。
   * 返回错误文案（null = 通过）。
   */
  private rejectIfNotNormal(sessionId: string): string | null {
    const s = sessionDao.pick(sessionId, ['settings', 'parentId'])
    if (!s) return 'This task is not attached to a session — sub-sessions are unavailable here.'
    if (s.settings?.bots?.length) return 'Chat sessions cannot have sub-sessions.'
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
        updatedAt: s.updatedAt
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
        updatedAt: row?.updatedAt ?? 0
      },
      ...last
    }
  }

  // ─── 创建 ──────────────────────────────────────

  /**
   * 建一条子会话。projectId 恒随父会话（工作目录是会话的地基）；父会话**当前**的模型
   * 作为种子写进子会话树 —— 不种就会回落全局默认，「我用 opus 干活、我开的子会话掉回
   * 默认模型」是纯粹的意外。
   *
   * 标题由父级给 ⇒ 记 `titleOrigin: 'user'`：那是一次刻意命名，auto-title 的 refine
   * 阶段不该覆盖它。父级不给 ⇒ 留默认标题，auto-title 照常接管。
   */
  async create(
    parentId: string,
    params: { title?: string; agentProfile?: string }
  ): Promise<{ error: string } | { id: string; title: string }> {
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
    // 否则跟随父会话当前档案。default 不必显式切（它就是新会话的回落值）
    const profileName =
      params.agentProfile?.trim() || sessionService.resolveAgentProfileName(parentId)
    let profileSeededModel = false
    if (profileName && profileName !== DEFAULT_PROFILE_NAME) {
      const applied = await sessionService.updateAgentProfile(session.id, profileName)
      if (applied.success) profileSeededModel = !!applied.applied?.model
      // 档案不合法不该让整个创建失败：会话已经建好且可用（回落 default），记日志即可
      else log.warn(`子会话 ${session.id} 档案 "${profileName}" 未生效: ${applied.error}`)
    }

    // 模型种子：父会话**当前**的模型。不种就会回落全局默认 ——「我用 opus 干活、
    // 我开的子会话掉回默认模型」是纯粹的意外。档案自己声明了模型则以档案为准（更具体的意图）
    if (!profileSeededModel) {
      const parentModel = await sessionService.resolveRunModelConfig(parentId)
      if (parentModel) await appendModelChange(session.id, parentModel.provider, parentModel.model)
    }

    log.info(`create sub-session ${session.id} parent=${parentId} profile=${profileName ?? '-'}`)
    return { id: session.id, title: sessionDao.pick(session.id, ['title'])?.title ?? session.title }
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
    // 该知道并作决策的状态，替它排队等于把这个状态藏起来
    const status = this.statusOf(childId)
    if (status !== 'idle') {
      return {
        error:
          `Sub-session "${child.title}" is ${status}. ` +
          `Wait and then read it with action "read-sub-session", or stop it with "stop-sub-session".`
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
      // 永不 reject：发送失败已经在子会话里表达（错误气泡），父级读到的是同一份事实
      done: chatGateway.prompt(childId, message).catch((err) => {
        log.warn(`子会话 ${childId} 发送失败: ${err}`)
      })
    }
    this.runs.set(childId, run)
    void run.done.then(() => this.settle(childId, run))

    if (background) {
      log.info(`prompt sub-session ${childId} (background)`)
      return { kind: 'started' }
    }

    const raced = await this.waitForeground(run, timeoutSeconds, signal)
    if (raced === 'timeout') {
      // 降级：本次调用不再等，运行继续，跑完照后台形态回报
      run.background = true
      log.info(`子会话 ${childId} 前台等待超时 ${timeoutSeconds}s，降级为后台`)
      return { kind: 'timeout' }
    }
    if (raced === 'aborted') {
      await this.stopRun(childId)
      await run.done
    }
    return { kind: 'answered', ...(await this.lastAnswer(childId)) }
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
    const parent = sessionService.getAgentSession(run.parentId)
    if (!parent) return
    const title = sessionDao.pick(childId, ['title'])?.title ?? childId
    const notice = [
      `<sub-session id="${childId}" title="${title}" status="finished">`,
      'The turn you started in the background has finished.',
      'Read its answer with the session tool: action "read-sub-session".',
      '</sub-session>'
    ].join('\n')
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

  private unknownChildError(parentId: string, childId: string): string {
    const children = sessionDao.findChildren(parentId)
    const list = children.length
      ? children.map((s) => `  ${s.id}  ${s.title}`).join('\n')
      : '  (none — create one with action "create-sub-session")'
    return `"${childId}" is not a sub-session of this session. Valid sub-sessions:\n${list}`
  }
}

export const subSessionRunner = new SubSessionRunner()
