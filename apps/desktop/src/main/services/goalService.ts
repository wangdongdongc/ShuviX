/**
 * 目标（`/goal`，docs/goal-mode-design.md §16）的宿主侧 —— 只有一个动作：把设目标的那条会话 fork 成这个目标的**管理员**。
 *
 * 用户在一条会话的输入框写 `/goal <条件>` → `start`：
 *  1. fork 这条会话（整段当前对话；会话正在跑 → 拒，什么都不建）。fork 沿用原会话的 agent：同一份人设、同一组工具、
 *     提示词缓存不丢，工作目录也是同一个；
 *  2. 在 fork 的会话行上记 `settings.goalManagerOf = <原会话 id>`（侧栏的 ◎、输入框不再给 `/goal`、下面两条规矩都读它），
 *     标题是「目标 · <原会话标题>」；
 *  3. 给 fork 一行对原会话的「对话」权限（权限表 `kind:'session'`、write）—— 用户设目标就是同意它去派活，之后它给
 *     原会话发消息不再弹卡片；
 *  4. 以人的来源把目标原文发进 fork（原文 + 「目标」Token），消息末尾的说明把它的身份切成管理员（chat-protocol
 *     `goalManagerNote`）：它不碰具体工作，整理验收条件、问用户、把任务发给原会话、按原会话的汇报验收、向用户汇报。
 * 之后的一切都是两条普通会话之间的协作，走现成的机制：管理员用 `session` 工具的 `prompt-session` 派活，原会话那一轮
 * 结束时的完成通知把空闲的管理员叫回来（自动续跑），用户随时在管理员会话里说话。
 *
 * 宿主不再有目标记录、检查员、续跑轮次与上限（2026-11-12 用户裁决）。只留两条和「管理员」这个身份有关的规矩：
 *  - 叫醒管理员的通知不看设置 `session.autoResume`（用户设了目标就是要它自己接着推；用户喊停照样挡住）——
 *    `isGoalManager`，sessionHost 的 `autoResume` 读它；
 *  - 一轮正常收尾弹不弹「完成」（`quietRunEnd`）：管理员派了活在等、原会话这一轮是管理员派的 → 不弹；管理员停下来
 *    问人或汇报时照常弹。
 * 重启之后没有任何东西自己醒过来：完成通知不跨进程，用户在管理员会话里说一句就接上。
 */
import { goalSetMessage } from '@shuvix/chat-protocol/goalSet'
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'
import { GOAL_OBJECTIVE_MAX_CHARS, type GoalStartResult } from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import type { JsonObject } from '@earendil-works/pi-durable'
import { randomUUID } from 'crypto'
import type { Session } from '../dao/types/session'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { broadcastSessionListChanged } from '../utils/sessionConfigBroadcast'
import { sessionAcl } from './acl'
import { forkSession } from './sessionFork'
import { getSessionHost } from './sessionHost'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'
import { sessionSignalsReady } from './sessionSignalSeams'
import { sessionRunStatus } from './subSessionRunner'
import { taskRegistry } from './taskRegistry'

const log = createLogger('Goal')

/** 原会话还是缺省标题时，管理员标题里用目标原文的第一行，封顶 */
const OBJECTIVE_TITLE_MAX = 40

/**
 * 管理员会话的标题：「目标 · <原会话标题>」—— 侧栏里一眼对得上它管的是哪条会话（用户 2026-11-13）。原会话还是缺省
 * 标题（刚建就设目标）→ 用目标原文的第一行（截短）代替
 */
function managerTitle(worker: Session, objective: string): string {
  let name = worker.title.trim()
  if (name === '' || name === t('agent.defaultTitle')) {
    const line = (objective.split(/\r?\n/).find((l) => l.trim() !== '') ?? objective).trim()
    name = line.length > OBJECTIVE_TITLE_MAX ? `${line.slice(0, OBJECTIVE_TITLE_MAX)}…` : line
  }
  return t('goal.managerTitle', { title: name })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 这条会话是不是某个目标的管理员（设目标时 fork 出来的那条） */
export function isGoalManager(sessionId: string): boolean {
  return !!sessionRecords.pickSettings(sessionId, ['goalManagerOf'])?.goalManagerOf
}

export class GoalService {
  /** 这条会话能不能设目标：人发起的根会话（子会话、bot、笔记本、Chrome 标签页、内存会话都不行），也不是管理员自己 */
  eligible(row: Session | undefined): row is Session {
    if (row === undefined || row.parentId) return false
    const settings = row.settings ?? {}
    if (settings.bot || settings.notebookPath || chromeTabOf(settings)) return false
    if (settings.goalManagerOf) return false
    return !sessionRecords.isEphemeral(row.id)
  }

  /** 这条会话的管理员里此刻还在忙的那一条（在跑一轮、在等人回答、派出去的活还没回来）；没有 → undefined */
  private busyManagerOf(workerId: string): Session | undefined {
    return sessionRecords.findAll().find((row) => {
      if (row.settings?.goalManagerOf !== workerId) return false
      const status = sessionRunStatus(row.id)
      return (
        status === 'running' ||
        status === 'waiting-input' ||
        taskRegistry.runningCount(row.id, 'sub-session') > 0
      )
    })
  }

  /**
   * 设定目标：fork 出管理员、授权、把目标发给它（见文件头）。`origin` = 网关按这次操作的连接盖的章（那条消息的来源）。
   * 被拒给一句人话，什么都不留下：消息没发出去就把刚建的 fork 删掉。
   */
  async start(
    sessionId: string,
    rawObjective: unknown,
    origin?: InputOrigin
  ): Promise<GoalStartResult> {
    const objective = typeof rawObjective === 'string' ? rawObjective.trim() : ''
    if (objective.length === 0 || objective.length > GOAL_OBJECTIVE_MAX_CHARS) {
      return { ok: false, error: t('goal.errorObjectiveLength', { max: GOAL_OBJECTIVE_MAX_CHARS }) }
    }
    const worker = typeof sessionId === 'string' ? sessionRecords.findById(sessionId) : undefined
    if (worker?.settings?.goalManagerOf) {
      return { ok: false, error: t('goal.errorManagerSession') }
    }
    if (!this.eligible(worker)) return { ok: false, error: t('goal.errorNotEligible') }
    const busy = this.busyManagerOf(sessionId)
    if (busy) return { ok: false, error: t('goal.errorManagerBusy', { title: busy.title }) }

    const forked = await forkSession({ sessionId })
    if (!forked.success) {
      const key =
        forked.reason === 'busy'
          ? 'goal.errorBusy'
          : forked.reason === 'not_forkable' || forked.reason === 'no_session'
            ? 'goal.errorNotEligible'
            : 'goal.errorForkFailed'
      return { ok: false, error: t(key) }
    }
    const managerId = forked.sessionId
    try {
      sessionRecords.updateSettings(managerId, { goalManagerOf: sessionId })
      sessionService.updateTitle(managerId, managerTitle(worker, objective), 'user')
      sessionAcl.grantSession(managerId, sessionId, 'write')
      const agent = await sessionService.ensureAgentSession(managerId)
      if (agent === undefined) throw new Error(t('goal.errorForkFailed'))
      const masked = (await agent.maskTexts([objective]))[0] ?? objective
      const message = goalSetMessage({
        objective: masked,
        goalId: `g_${randomUUID().slice(0, 8)}`,
        worker: { id: sessionId, title: worker.title }
      })
      // 会话信号先就绪：投影句柄挂上之前开跑的一轮没有 agent_start / agent_end
      await sessionSignalsReady(managerId)
      const result = await agent.admitSteer(message.text, {
        display: message.display as unknown as JsonObject,
        ...(origin !== undefined ? { source: origin } : {})
      })
      if (result.error) throw new Error(result.error)
    } catch (error) {
      log.warn(`设定目标失败 session=${sessionId} manager=${managerId}: ${errorText(error)}`)
      await sessionService.delete(managerId).catch((e: unknown) => {
        log.warn(`删除没用上的管理员会话失败 ${managerId}: ${errorText(e)}`)
      })
      broadcastSessionListChanged()
      return { ok: false, error: errorText(error) }
    }
    // 标题与 goalManagerOf 是 fork 的列表广播之后才写的
    broadcastSessionListChanged()
    log.info(`目标已设定 session=${sessionId} manager=${managerId}`)
    return { ok: true, sessionId: managerId }
  }

  /**
   * 这条会话这一轮正常收尾不必弹「完成」（见文件头）：
   *  - 管理员：它派出去的活还没回来 —— 它只是在等，事情没到要人看的时候；
   *  - 干活的会话：这一轮是它的管理员派的 —— 结果由管理员接着处理。
   */
  quietRunEnd(sessionId: string): boolean {
    if (isGoalManager(sessionId)) return taskRegistry.runningCount(sessionId, 'sub-session') > 0
    const driver = getSessionHost().get(sessionId)?.drivenRun?.parentId
    if (driver === undefined) return false
    return sessionRecords.pickSettings(driver, ['goalManagerOf'])?.goalManagerOf === sessionId
  }
}

export const goalService = new GoalService()
