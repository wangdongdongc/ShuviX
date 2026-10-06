/**
 * 通知决策器 —— 宿主无关。
 *
 * 订阅一端的 ChatEvent 流（余项：运行生命周期、错误、派生 agent 的登记 / 收尾），外加询问的钩子
 * （`askRaised` / `askResolved`，宿主接到会话的 `subscribeInputs` 上 —— 前端线路上已经没有询问事件，
 * P3-08），判定「该不该打扰用户」，把结论交给宿主端口去弹（桌面 Electron `Notification`，扩展
 * `chrome.notifications`）。宿主只剩几件它才知道的事：怎么弹、用户此刻在看哪、会话叫什么、开关开没开，
 * 以及一轮以失败收尾时那条错误行写的是什么（`runErrorText`，PIN-08）。
 *
 * 三个触发点：
 *  - **询问**：`askRaised` 一挂起就弹，落定（`askResolved`：答了 / 取消 / 会话关了）就撤回。
 *  - **完成**：根会话 `agent_end` 且 `reason === 'ok'`（`runEnded`）。
 *  - **异常**：根会话 `agent_end` 且 `reason === 'error'`，或运行中/运行外的 `error` 事件。模型侧的失败
 *    如今是会话里的一条错误条目、不再另发 `error` 事件，所以失败通知的正文从 `runErrorText` 现取。
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
 * 3. **子会话的结束一律不弹**：`sub_session_end` 只用来销血缘。这里一度按「无
 *    `parentToolCallId` = 用户触发」补过一条完成/失败通知 —— 那时笔记本发送整轮跑在子会话里，
 *    没有根 agent 的 `agent_end` 兜底。笔记本改回真正的根 agent 之后，唯一还这么派发的是
 *    hook runner，而它起的都是机械动作（auto-title 每个会话一两次）：补通知的结果是用户刚
 *    发完消息就先收到一条「已完成」，而他等的那轮还在跑。
 *    真要给某类 hook 运行发通知，得由发起方说自己是一次用户在等的运行，而不是从
 *    「有没有 toolCallId」反推。
 */
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'
import type { ChatEvent } from '../types'
import type { RunEndReason } from '../durable/projection/sessionProjector'

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
  /**
   * 一轮以失败收尾时，这条会话最后那条错误行的文本（PIN-08：宿主从投影里读最后一条 `error_event`）。
   * 只在 `reason === 'error'`、调用方没给文本、本轮也没攒下 `error` 事件时才问。取不到 → undefined。
   */
  runErrorText?(sessionId: string): string | undefined
  logger?: { warn(message: string): void }
}

export interface NotificationCenter {
  /** 喂事件。宿主把整条 ChatEvent 流接进来即可，过滤在内部做 */
  handleEvent(event: ChatEvent): void
  /**
   * 一条询问挂起（会话 `subscribeInputs` 的 onRequest）。`sessionId` 是询问所在的会话（派生 agent 的询问
   * 就挂在它的根会话上；登记过的子会话 id 照样归一到根）
   */
  askRaised(sessionId: string, request: InputRequest): void
  /** 一条询问落定（onResolved：答了 / 取消 / 被顶替 / 会话关了）—— 撤回它的通知 */
  askResolved(sessionId: string, requestId: string): void
  /**
   * 一轮运行结束（PIN-08）。`agent_end` 经 `handleEvent` 来时也走这里（不带文本）；失败而又没有文本时
   * 问宿主的 `runErrorText`。派生 agent / 中止不弹
   */
  runEnded(sessionId: string, reason: RunEndReason, errorText?: string): void
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
function describeRequest(request: InputRequest): string {
  switch (request.kind) {
    case 'ask':
      return oneLine(request.command)
    case 'choice':
      return oneLine(request.question)
  }
}

export function createNotificationCenter(deps: NotificationCenterDeps): NotificationCenter {
  /** 子会话 id → 根会话 id。register 时记，end 时删 */
  const subSessions = new Map<string, string>()
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
      const root = subSessions.get(current)
      if (!root) return current
      current = root
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

  function runEnded(sessionId: string, reason: RunEndReason, errorText?: string): void {
    runningSessions.delete(sessionId)
    const pending = pendingErrors.get(sessionId)
    pendingErrors.delete(sessionId)
    // 派生 agent 跑完不是「一轮结束」（见文件头注 2、3）：它的失败会以 tool error
    // 的形式回到父 agent，父 agent 那轮的 agent_end 才是真正的结局
    if (rootOf(sessionId) !== sessionId) return
    if (reason === 'aborted') return
    if (reason === 'error' || pending !== undefined) {
      const text = pending ?? errorText ?? safeRunErrorText(sessionId)
      notifyRunEnd(sessionId, true, text)
    } else {
      notifyRunEnd(sessionId, false)
    }
  }

  /** 宿主的错误文本 seam 抛错只当取不到 */
  function safeRunErrorText(sessionId: string): string | undefined {
    try {
      return deps.runErrorText?.(sessionId)
    } catch (err) {
      deps.logger?.warn(`读取失败文本出错: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  return {
    handleEvent(event: ChatEvent): void {
      switch (event.type) {
        case 'sub_session_register': {
          subSessions.set(event.sessionId, event.rootSessionId || event.parentSessionId)
          break
        }

        case 'sub_session_end': {
          // 只销血缘，不补通知（见文件头注 3）：子会话的结局属于派它的那一轮
          subSessions.delete(event.sessionId)
          break
        }

        case 'agent_start': {
          runningSessions.add(event.sessionId)
          pendingErrors.delete(event.sessionId)
          break
        }

        case 'error': {
          // 运行中出的错等 agent_end 一起弹（同一轮可能广播不止一条 error，攒着只弹最后一条，
          // 不会弹两条）；
          // 不在运行中说明这轮压根没起来（模型解析失败等），没有 agent_end 兜底，立刻弹。
          if (runningSessions.has(event.sessionId)) pendingErrors.set(event.sessionId, event.error)
          // 派生 agent 的错同样不弹（与 agent_end 分支同因）：它以 tool error 回到父 agent，
          // 父那轮的 agent_end 才是结局
          else if (rootOf(event.sessionId) === event.sessionId)
            notifyRunEnd(event.sessionId, true, event.error)
          break
        }

        case 'agent_end': {
          runEnded(event.sessionId, event.reason)
          break
        }

        default:
          break
      }
    },

    askRaised(sessionId: string, request: InputRequest): void {
      const root = rootOf(sessionId)
      show({
        key: `ask:${request.id}`,
        kind: 'ask',
        sessionId: root,
        title: titleOf(root),
        body: deps.t('notification.askBody', { detail: describeRequest(request) }),
        requestId: request.id
      })
    },

    askResolved(sessionId: string, requestId: string): void {
      dismiss(`ask:${requestId}`, rootOf(sessionId))
    },

    runEnded,

    sessionOpened(sessionId: string): void {
      const keys = keysBySession.get(sessionId)
      if (!keys) return
      keysBySession.delete(sessionId)
      for (const key of keys) dismiss(key, sessionId)
    }
  }
}
