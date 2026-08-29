/**
 * 通知决策器 —— 宿主无关。
 *
 * 订阅一端的 ChatEvent 流，判定「这条事件该不该打扰用户」，把结论交给宿主端口去弹
 * （桌面 Electron `Notification`，扩展 `chrome.notifications`）。两端共用这一份逻辑，
 * 宿主只剩四件它才知道的事：怎么弹、用户此刻在看哪、会话叫什么、开关开没开。
 *
 * 三个触发点：
 *  - **询问**：`input_request` 一挂起就弹，用户在界面里答了（`input_request_resolved`）就撤回。
 *  - **完成**：根会话 `agent_end` 且 `reason === 'ok'`。
 *  - **异常**：根会话 `agent_end` 且 `reason === 'error'`，或运行中/运行外的 `error` 事件。
 *
 * 三条刻意的取舍：
 *
 * 1. **`reason === 'aborted'` 不弹。** 中止只可能是用户自己按的，人就在跟前，弹一条
 *    「已中止」纯属噪音。
 *
 * 2. **派生 agent 的 `agent_end` 不弹。** 事件流里子 agent 与根 agent 完全同构（同一套
 *    HarnessSession，只是 sessionId 是子会话 id），不区分的话一次 explore 就多一条通知。
 *    但**子 agent 的询问要弹** —— 卡住的是整轮，用户不答就没人往下走；只是通知点击要
 *    落到根会话上，所以这里维护 sub→root 映射（`ChatEventBase.subAgentId` 是个从没有人
 *    写过的字段，指望不上，只能像 ChatFrontendRegistry 那样自己按 register/end 记）。
 *
 * 3. **非工具派发的子会话（如 workflow 引擎 `run()` 起的 agent）算一次运行**，用
 *    `sub_session_end` 补一条完成/失败通知 —— 这类运行没有根 agent 的 `agent_end` 兜底，
 *    不补就永远等不到通知。Agent 自己派发的（带 `parentToolCallId`）不补，那是上面第 2 条。
 */
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'
import type { ChatEvent } from '../types'

/** 宿主通知端口：把一条 AgentNotification 落到具体平台上 */
export interface NotifierPort {
  show(notification: AgentNotification): void
  /** 撤回（用户已在界面里处理掉了）。key 不存在时应静默忽略 */
  dismiss(key: string): void
}

/** 文案函数 —— 宿主注入自己的 i18next 实例（两端共用同一份 locale） */
export type NotificationTranslate = (key: string, vars?: Record<string, string | number>) => string

export interface NotificationCenterDeps {
  notifier: NotifierPort
  /**
   * 用户此刻正看着这个会话吗？true → 不打扰。
   *
   * 判定含两件事，缺一不可：窗口/标签页处于前台**且**当前展示的就是这个会话。
   * 传进来的必定是根会话 id。
   */
  isForeground(sessionId: string): boolean
  t: NotificationTranslate
  /** 会话标题（通知标题）。取不到返回 undefined，走兜底文案 */
  sessionTitle?(sessionId: string): string | undefined
  /** 总开关，每次判定时实时读（用户改设置立即生效，不必重建） */
  enabled?(): boolean
  logger?: { warn(message: string): void }
}

export interface NotificationCenter {
  /** 喂事件。宿主把整条 ChatEvent 流接进来即可，过滤在内部做 */
  handleEvent(event: ChatEvent): void
  /**
   * 用户打开/切到了某个会话 —— 撤回它名下所有还挂着的通知。
   *
   * 点通知跳过去时宿主会调，用户自己点侧边栏切过去时也该调：
   * 通知的意义是「你不在的时候发生了事」，人到了就没意义了。
   */
  sessionOpened(sessionId: string): void
}

/** 通知正文上限 —— 两端原生通知都只给一两行，长了会被系统硬截在难看的地方 */
const MAX_BODY = 140

/** 压成单行并截断：命令可能是多行 heredoc，错误可能带整个堆栈 */
function oneLine(text: string, max = MAX_BODY): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 询问请求 → 一句人话 */
function describeRequest(request: InputRequest, t: NotificationTranslate): string {
  switch (request.kind) {
    case 'ask':
      return oneLine(request.command)
    case 'choice':
      return oneLine(request.question)
    case 'sshCredentials':
      return t('notification.askSshDetail')
  }
}

export function createNotificationCenter(deps: NotificationCenterDeps): NotificationCenter {
  /** 子会话 id → 血缘。register 时记，end 时删 */
  const subSessions = new Map<string, { root: string; userTriggered: boolean }>()
  /** 会话 → 它名下已弹出的通知 key（撤回用） */
  const keysBySession = new Map<string, Set<string>>()
  /**
   * 正在运行的会话（agent_start 置，agent_end 清）—— 判断 error 该不该立刻弹。
   * 按**事件原本的 sessionId** 记，不归一到根：派生 agent 跑完只该清它自己那条，
   * 归一了就会在根还在跑的时候把根的运行态抹掉。
   */
  const runningSessions = new Set<string>()
  /** 本轮已收到的错误文本（等 agent_end 一起弹，避免一次失败弹两条）。同上，按原 sessionId 记 */
  const pendingErrors = new Map<string, string>()

  /** 事件的 sessionId 归一到可见会话（子会话逐级上溯到根） */
  function rootOf(sessionId: string): string {
    let current = sessionId
    // 嵌套派生最多 MAX_AGENT_DEPTH 层，给个上限纯粹是防御环形数据
    for (let i = 0; i < 8; i++) {
      const parent = subSessions.get(current)
      if (!parent) return current
      current = parent.root
    }
    return current
  }

  function titleOf(sessionId: string): string {
    const title = deps.sessionTitle?.(sessionId)?.trim()
    return title || deps.t('notification.untitledSession')
  }

  function show(notification: AgentNotification): void {
    if (deps.enabled && !deps.enabled()) return
    if (deps.isForeground(notification.sessionId)) return
    let keys = keysBySession.get(notification.sessionId)
    if (!keys) {
      keys = new Set()
      keysBySession.set(notification.sessionId, keys)
    }
    keys.add(notification.key)
    try {
      deps.notifier.show(notification)
    } catch (err) {
      deps.logger?.warn(`通知发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function dismiss(key: string, sessionId?: string): void {
    try {
      deps.notifier.dismiss(key)
    } catch {
      /* 撤回失败无所谓：通知本来就会自己过期 */
    }
    if (sessionId) {
      keysBySession.get(sessionId)?.delete(key)
      return
    }
    for (const [sid, keys] of keysBySession) {
      if (keys.delete(key) && keys.size === 0) keysBySession.delete(sid)
    }
  }

  /** 一轮运行结束 —— 成功/失败各一条，同会话只留最新（key 固定） */
  function notifyRunEnd(sessionId: string, failed: boolean, error?: string): void {
    const body = failed
      ? deps.t('notification.failedBody', { error: oneLine(error ?? '', 100) })
      : deps.t('notification.doneBody')
    show({
      key: `run:${sessionId}`,
      kind: failed ? 'failed' : 'done',
      sessionId,
      title: titleOf(sessionId),
      body
    })
  }

  return {
    handleEvent(event: ChatEvent): void {
      switch (event.type) {
        case 'sub_session_register': {
          subSessions.set(event.sessionId, {
            root: event.rootSessionId || event.parentSessionId,
            // 无 parentToolCallId = 非工具派发（如 workflow 引擎 run()），这一支算一次完整运行
            userTriggered: !event.parentToolCallId
          })
          break
        }

        case 'sub_session_end': {
          const lineage = subSessions.get(event.sessionId)
          subSessions.delete(event.sessionId)
          if (lineage?.userTriggered) {
            notifyRunEnd(rootOf(lineage.root), !!event.isError, event.result)
          }
          break
        }

        case 'agent_start': {
          runningSessions.add(event.sessionId)
          pendingErrors.delete(event.sessionId)
          break
        }

        case 'error': {
          // 运行中出的错等 agent_end 一起弹（同一次失败可能先后广播 message_end 的
          // error 和 prompt() catch 的 error，攒着才不会弹两条）；
          // 不在运行中说明这轮压根没起来（模型解析失败等），没有 agent_end 兜底，立刻弹。
          if (runningSessions.has(event.sessionId)) pendingErrors.set(event.sessionId, event.error)
          else notifyRunEnd(rootOf(event.sessionId), true, event.error)
          break
        }

        case 'agent_end': {
          runningSessions.delete(event.sessionId)
          const error = pendingErrors.get(event.sessionId)
          pendingErrors.delete(event.sessionId)
          // 派生 agent 跑完不是「一轮结束」（见文件头注 2、3）：它的失败会以 tool error
          // 的形式回到父 agent，父 agent 那轮的 agent_end 才是真正的结局
          if (rootOf(event.sessionId) !== event.sessionId) break
          if (event.reason === 'aborted') break
          if (event.reason === 'error' || error) notifyRunEnd(event.sessionId, true, error)
          else notifyRunEnd(event.sessionId, false)
          break
        }

        case 'input_request': {
          const root = rootOf(event.sessionId)
          show({
            key: `ask:${event.request.id}`,
            kind: 'ask',
            sessionId: root,
            title: titleOf(root),
            body: deps.t('notification.askBody', {
              detail: describeRequest(event.request, deps.t)
            }),
            requestId: event.request.id
          })
          break
        }

        case 'input_request_resolved': {
          dismiss(`ask:${event.requestId}`, rootOf(event.sessionId))
          break
        }

        default:
          break
      }
    },

    sessionOpened(sessionId: string): void {
      const keys = keysBySession.get(sessionId)
      if (!keys) return
      keysBySession.delete(sessionId)
      for (const key of keys) dismiss(key, sessionId)
    }
  }
}
