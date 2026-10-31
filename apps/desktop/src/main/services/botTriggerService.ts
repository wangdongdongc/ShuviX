/**
 * bot 触发分发 —— 全局埋点（触发源的事件，今天只有内置 timer 的 `timer.fired`）→ 命中的 bot 绑定
 * （bot md 的 `shuvix-bot-on`）→ 新建一条绑定该 bot 的普通临时会话，把绑定里的 `message` 加上事件围栏
 * （`<trigger_event>`）作为来源 `trigger` 的用户消息发进去。
 *
 * 与 hook 共用埋点表与 CEL `when`（agent-runtime triggerPoints / when）；不同的只有命中之后做什么：hook 在所属会话下
 * 派一个 agent，bot 新开一条会话 —— 一次运行在侧栏、日历里都是一条看得见的会话，用户可以在里面接着说。
 *
 *  - **上一次还没跑完就跳过这次**（同一个 bot 的同一条绑定）：一次运行 = 那条会话的第一轮，`prompt` 在这一轮结束时才
 *    交回，所以「在跑」就是那次 `prompt` 还没交回 —— 停在一张询问卡上的运行同样算在跑，后面的触发不会越堆越多；
 *  - **这条绑定上一次跑成的时刻**随事件一起交给 bot（`lastFiredAt`，带本机时区偏移的 ISO —— bot 直接读它的日期当本地日；
 *    记在设置里，重启之后还在）：bot 据此处理「自上次以来」的东西。只有那一轮正常结束才记 —— 会话打不开、模型被拒、
 *    运行出错时不往前推，下一次接着从更早的时刻处理，错过与失败都不丢数据；
 *  - `when` 求值出错按「不命中」处置，同一条绑定同一个错误只记一次日志 —— 每分钟都会求值一次。
 *
 * 触发源不知道谁会响应（与 bot 解绑，用户 2026-10-24）：每次命中、跳过、条件出错与每次运行的结局都记进触发日志
 * （triggerLogService），设置 → 触发源 一页列出 —— 用户靠它看见「哪个事件叫起了哪个 bot」。
 *
 * 会话标题取「bot 显示名 · 触发的本地时间」：触发型会话往往只有一轮，等不到自动起标题。
 * 一次运行开始前宿主建好日报目录与跟踪项目录（dailyNotes 的 ensureDailyDir、trackingNotes 的 ensureTrackingDir），
 * 结束后提交一次跟踪项目录的 git（commitTrackingChanges）。
 */
import {
  evaluateWhen,
  renderEventPrompt,
  type BotBinding,
  type GlobalTriggerId,
  type TriggerPayloadMap
} from '@shuvix/agent-runtime'
import type { TriggerOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { basename } from 'path'
import { botService, type BotEntry } from './botService'
import { ensureDailyDir } from './dailyNotes'
import { projectService } from './projectService'
import { sessionService } from './sessionService'
import { settingsService } from './settingsService'
import { commitTrackingChanges, ensureTrackingDir } from './trackingNotes'
import { triggerLogService, type TriggerLogInput } from './triggerLogService'
import { createLogger } from '../logger'

const log = createLogger('BotTriggers')

/** 触发器替 bot 发的消息里，事件围栏的标签名（agent 面向，仅英文） */
export const TRIGGER_EVENT_TAG = 'trigger_event'

/** 各条绑定上一次触发的时刻（`{ <绑定键>: ISO }`）—— 内部状态，不在 KNOWN_SETTINGS 里 */
export const LAST_FIRED_KEY = 'triggers.bot.lastFired'

/** 一条绑定的键：bot 的对象 id（没有就用名字）+ 第几条 + 埋点 */
export function bindingKey(entry: BotEntry, index: number, trigger: string): string {
  return `${entry.file.objectId ?? entry.file.name}#${index}#${trigger}`
}

function readLastFired(): Record<string, string> {
  const raw = settingsService.get(LAST_FIRED_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** 某个时刻 → 带本机时区偏移的 ISO（`2026-10-24T18:00:00+08:00`）：日期就是本地日，CEL 的 timestamp() 也认得 */
export function localIso(at: Date): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  )
}

/** 本地时间 `HH:MM` 之类的短时刻：事件里有本地字段就用它，没有就用此刻 */
function localStamp(payload: Record<string, unknown>): string {
  const local = payload.local as { date?: unknown; time?: unknown } | undefined
  if (local && typeof local.date === 'string' && typeof local.time === 'string') {
    return `${local.date.slice(5)} ${local.time}`
  }
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export class BotTriggerService {
  /** 正在跑的绑定（键）—— 从新建会话到那一轮结束 */
  private readonly inFlight = new Set<string>()
  /** 每条绑定上一次 `when` 求值出错的信息（同一个错误只记一次） */
  private readonly lastWhenError = new Map<string, string>()

  /** 一次全局埋点：逐个 bot、逐条绑定匹配，命中的各起一次运行（不等它们） */
  fire<K extends GlobalTriggerId>(id: K, payload: TriggerPayloadMap[K]): void {
    let entries: BotEntry[]
    try {
      entries = botService.listAll()
    } catch (err) {
      log.warn(`fire(${id}): listing bots failed — ${err instanceof Error ? err.message : err}`)
      return
    }
    const event = { ...payload, trigger: id } as unknown as Record<string, unknown>
    const env = { host: 'desktop', platform: process.platform }
    for (const entry of entries) {
      ;(entry.file.bindings ?? []).forEach((binding, index) => {
        if (binding.trigger !== id) return
        const key = bindingKey(entry, index, id)
        const logBase = (): Omit<TriggerLogInput, 'outcome' | 'sessionId' | 'error'> => ({
          sourceId: typeof event.sourceId === 'string' ? event.sourceId : '',
          trigger: id,
          bot: entry.file.name,
          botDisplayName: entry.file.displayName,
          botFile: basename(entry.basePath),
          bindingIndex: index,
          when: binding.when ?? '',
          event
        })
        if (!this.whenHit(key, entry, binding, event, env, logBase)) return
        if (this.inFlight.has(key)) {
          log.info(
            `bot "${entry.file.name}" binding ${index} (${id}) skipped: previous run still going`
          )
          triggerLogService.record({ ...logBase(), outcome: 'skipped', sessionId: '', error: '' })
          return
        }
        void this.launch(
          entry,
          binding,
          key,
          id,
          payload as unknown as Record<string, unknown>,
          logBase()
        )
      })
    }
  }

  /** 这条绑定此刻是否在跑（测试与设置页用） */
  isRunning(key: string): boolean {
    return this.inFlight.has(key)
  }

  private whenHit(
    key: string,
    entry: BotEntry,
    binding: BotBinding,
    event: Record<string, unknown>,
    env: Record<string, unknown>,
    logBase: () => Omit<TriggerLogInput, 'outcome' | 'sessionId' | 'error'>
  ): boolean {
    if (!binding.when) return true
    try {
      const hit = evaluateWhen(binding.when, { event, env })
      this.lastWhenError.delete(key)
      return hit
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 同一条绑定同一个错误只记一次（日志与触发日志同一个节流）—— 每分钟都会求值一次
      if (this.lastWhenError.get(key) !== message) {
        this.lastWhenError.set(key, message)
        log.warn(`bot "${entry.file.name}": when evaluation failed — ${message}`)
        triggerLogService.record({
          ...logBase(),
          outcome: 'condition-error',
          sessionId: '',
          error: message
        })
      }
      return false
    }
  }

  private async launch(
    entry: BotEntry,
    binding: BotBinding,
    key: string,
    trigger: GlobalTriggerId,
    payload: Record<string, unknown>,
    logBase: Omit<TriggerLogInput, 'outcome' | 'sessionId' | 'error'>
  ): Promise<void> {
    this.inFlight.add(key)
    let ran: string | null = null
    // 触发日志的那一条：会话开出来才记 started（之后改成 completed / failed）；没开出来记一条没有会话的 failed
    let logId: string | null = null
    // 开出来的运行会话（日志那一条没写成时，失败的补记照样带上它）
    let runSessionId = ''
    try {
      const previous = readLastFired()[key]
      const lastFiredAt =
        previous && !Number.isNaN(Date.parse(previous)) ? localIso(new Date(previous)) : undefined
      const firedAt =
        typeof payload.firedAt === 'string' ? payload.firedAt : new Date().toISOString()

      // 绑定写了 project：按名字找没归档的项目（大小写不敏感）。找不到、或有不止一个同名项目 —— 这一次不跑，记进
      // 触发日志：改在临时里跑，bot 找不到它要的文件，跑出来的结果只会让人困惑（用户 2026-10-31）
      let workProject: string | undefined
      if (binding.project) {
        const hits = projectService.projectsNamed(binding.project)
        if (hits.length !== 1) {
          const error =
            hits.length === 0
              ? `Project "${binding.project}" not found`
              : `More than one project is named "${binding.project}"`
          log.warn(`bot "${entry.file.name}": ${error} — this run is skipped`)
          triggerLogService.record({ ...logBase, outcome: 'failed', sessionId: '', error })
          return
        }
        workProject = hits[0].id
      }

      // 日报与跟踪项目录先建好：不在时 bot 会去翻上一层找它，撞上一张没人回答的询问（见 ensureDailyDir / ensureTrackingDir）
      ensureDailyDir()
      ensureTrackingDir()
      const session = sessionService.create(
        {
          bot: entry.file.name,
          title: `${entry.file.displayName} · ${localStamp(payload)}`,
          ...(workProject ? { workProject } : {})
        },
        { triggerRun: true }
      )
      const origin: TriggerOrigin = {
        kind: 'trigger',
        trigger,
        ...(typeof payload.sourceId === 'string' ? { sourceId: payload.sourceId } : {}),
        bot: entry.file.name
      }
      const text = renderEventPrompt(TRIGGER_EVENT_TAG, binding.message, trigger, {
        ...payload,
        ...(lastFiredAt ? { lastFiredAt } : {})
      })
      runSessionId = session.id
      log.info(`bot "${entry.file.name}" fired by ${trigger} → session ${session.id}`)
      logId = triggerLogService.record({
        ...logBase,
        outcome: 'started',
        sessionId: session.id,
        error: ''
      })
      const agent = await sessionService.ensureAgentSession(session.id)
      if (!agent) {
        log.warn(`bot "${entry.file.name}": session ${session.id} could not be opened`)
        triggerLogService.finish(logId, 'failed', 'The run session could not be opened')
        return
      }
      // 这一轮结束才交回：这段时间里同一条绑定的后续触发都被跳过
      ran = `${entry.file.displayName} · ${localStamp(payload)} (session ${session.id})`
      const result = await agent.prompt(text, undefined, undefined, undefined, origin)
      if (result.error) {
        log.warn(`bot "${entry.file.name}" run in ${session.id} failed: ${result.error}`)
        triggerLogService.finish(logId, 'failed', result.error)
      } else {
        triggerLogService.finish(logId, 'completed')
        // 跑成了才往前推（现读一次：别的绑定可能刚写过这张表）
        settingsService.set(LAST_FIRED_KEY, JSON.stringify({ ...readLastFired(), [key]: firedAt }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`bot "${entry.file.name}" trigger run failed: ${message}`)
      if (logId) triggerLogService.finish(logId, 'failed', message)
      else
        triggerLogService.record({
          ...logBase,
          outcome: 'failed',
          sessionId: runSessionId,
          error: message
        })
    } finally {
      this.inFlight.delete(key)
      // 跟踪项目录（实验）提交一次：bot 全权改那些文件，回退只能靠历史。没写过任何跟踪项（目录不在）就什么都不做
      if (ran) await commitTrackingChanges(ran)
    }
  }
}

/** 主进程里唯一的 bot 触发分发 */
export const botTriggers = new BotTriggerService()
