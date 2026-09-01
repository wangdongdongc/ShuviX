/**
 * 通知决策器 —— 两端共用的那份「什么时候该打扰用户」。
 *
 * 这里钉的都是**只能靠断言守住的取舍**：事件流里派生 agent 与根 agent 完全同构，
 * 一次失败会广播不止一条 error，笔记本会话整轮跑在子会话里……任何一条判错，症状都是
 * 「通知多了 / 少了一条」这种上线才有人抱怨、且没人会写复现步骤的事。
 */
import { describe, it, expect } from 'vitest'
import { createNotificationCenter, type NotificationCenter } from '../notificationCenter'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'
import type { ChatEvent } from '../../types'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

const ROOT = 'sess-root'
const SUB = 'sub-1'

interface Harness {
  center: NotificationCenter
  shown: AgentNotification[]
  dismissed: string[]
  foreground: Set<string>
  enabled: { value: boolean }
  titles: Map<string, string>
}

function makeCenter(): Harness {
  const shown: AgentNotification[] = []
  const dismissed: string[] = []
  const foreground = new Set<string>()
  const enabled = { value: true }
  const titles = new Map<string, string>()
  const center = createNotificationCenter({
    notifier: {
      show: (n) => shown.push(n),
      dismiss: (key) => dismissed.push(key)
    },
    isForeground: (sessionId) => foreground.has(sessionId),
    sessionTitle: (sessionId) => titles.get(sessionId),
    enabled: () => enabled.value,
    // 文案断言只关心 key 与插值，不关心具体译文
    t: (key, vars) => (vars ? `${key}|${Object.values(vars).join(',')}` : key)
  })
  return { center, shown, dismissed, foreground, enabled, titles }
}

function askRequest(id = 'req-1', command = 'rm -rf build'): InputRequest {
  return { id, kind: 'ask', toolName: 'bash', createdAt: 0, command }
}

/** 子会话登记：parentToolCallId 有值 = agent 经派发工具起的；无值 = workflow 引擎 run() 起的 */
function register(sessionId: string, parent: string, parentToolCallId?: string): ChatEvent {
  return {
    type: 'sub_session_register',
    sessionId,
    parentSessionId: parent,
    rootSessionId: parent,
    parentToolCallId,
    subAgentName: 'explore',
    displayName: 'Explore',
    description: '找点东西',
    systemPrompt: '',
    prompt: ''
  }
}

describe('通知决策器 — 三个触发点', () => {
  it('询问挂起就弹，界面里答了就撤回', () => {
    const h = makeCenter()
    h.titles.set(ROOT, '重构会话')

    h.center.handleEvent({ type: 'input_request', sessionId: ROOT, request: askRequest() })
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]).toMatchObject({
      key: 'ask:req-1',
      kind: 'ask',
      sessionId: ROOT,
      title: '重构会话',
      requestId: 'req-1'
    })
    expect(h.shown[0].body).toBe('notification.askBody|rm -rf build')

    h.center.handleEvent({ type: 'input_request_resolved', sessionId: ROOT, requestId: 'req-1' })
    expect(h.dismissed).toEqual(['ask:req-1'])
  })

  it('一轮正常跑完弹完成，出错弹失败，用户中止不弹', () => {
    const h = makeCenter()

    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown.map((n) => n.kind)).toEqual(['done'])

    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    expect(h.shown.map((n) => n.kind)).toEqual(['done', 'failed'])

    // 中止只可能是用户自己按的 —— 人就在跟前，再弹一条纯属噪音
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'aborted' })
    expect(h.shown).toHaveLength(2)
  })

  it('运行中的 error 攒到 agent_end 一起弹，一次失败只弹一条', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    // 同一次失败可能先后广播 message_end 的 error 与 prompt() catch 的 error
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: '401 Unauthorized' })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: '401 Unauthorized' })
    expect(h.shown).toHaveLength(0)

    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].kind).toBe('failed')
    expect(h.shown[0].body).toBe('notification.failedBody|401 Unauthorized')
  })

  it('压根没起来的一轮（无 agent_start，也就没有 agent_end 兜底）立刻弹', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: '模型未配置' })
    expect(h.shown.map((n) => n.kind)).toEqual(['failed'])
  })

  it('reason 省略（老事件）按正常结束处理', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT })
    expect(h.shown.map((n) => n.kind)).toEqual(['done'])
  })
})

describe('通知决策器 — 不打扰的条件', () => {
  it('用户正看着这个会话就不弹', () => {
    const h = makeCenter()
    h.foreground.add(ROOT)
    h.center.handleEvent({ type: 'input_request', sessionId: ROOT, request: askRequest() })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(0)
  })

  it('总开关关掉就不弹', () => {
    const h = makeCenter()
    h.enabled.value = false
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(0)
  })

  it('用户打开会话后，它名下挂着的通知一并撤回', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'input_request', sessionId: ROOT, request: askRequest('a') })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(2)

    h.center.sessionOpened(ROOT)
    expect(h.dismissed.sort()).toEqual([`run:${ROOT}`, 'ask:a'].sort())
  })

  it('会话无标题时走兜底文案', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown[0].title).toBe('notification.untitledSession')
  })

  it('正文压成单行并截断 —— 命令可能是多行 heredoc', () => {
    const h = makeCenter()
    h.center.handleEvent({
      type: 'input_request',
      sessionId: ROOT,
      request: askRequest('r', `cat <<'EOF'\n${'x'.repeat(300)}\nEOF`)
    })
    const detail = h.shown[0].body.split('|')[1]
    expect(detail).not.toContain('\n')
    expect(detail.length).toBeLessThanOrEqual(140)
    expect(detail.endsWith('…')).toBe(true)
  })
})

describe('通知决策器 — 派生 agent', () => {
  it('派生 agent 跑完不算「一轮结束」，不弹', () => {
    const h = makeCenter()
    h.center.handleEvent(register(SUB, ROOT, 'tool-call-1'))
    h.center.handleEvent({ type: 'agent_start', sessionId: SUB })
    h.center.handleEvent({ type: 'agent_end', sessionId: SUB, reason: 'ok' })
    expect(h.shown).toHaveLength(0)

    // 但根会话那轮照常弹 —— 子 agent 的 agent_end 不能把根的运行态一起抹掉
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown.map((n) => n.kind)).toEqual(['done'])
  })

  it('派生 agent 的失败不弹 —— 它会以 tool error 回到父 agent，父那轮才是结局', () => {
    const h = makeCenter()
    h.center.handleEvent(register(SUB, ROOT, 'tool-call-1'))
    h.center.handleEvent({ type: 'agent_start', sessionId: SUB })
    h.center.handleEvent({ type: 'error', sessionId: SUB, error: '子任务炸了' })
    h.center.handleEvent({ type: 'agent_end', sessionId: SUB, reason: 'error' })
    expect(h.shown).toHaveLength(0)

    // 且不能污染根会话：根这轮成功就该是成功
    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown.map((n) => n.kind)).toEqual(['done'])
  })

  it('派生 agent 的询问照弹，但落点归一到根会话', () => {
    const h = makeCenter()
    h.titles.set(ROOT, '根会话')
    h.center.handleEvent(register(SUB, ROOT, 'tool-call-1'))
    h.center.handleEvent({ type: 'input_request', sessionId: SUB, request: askRequest('q') })

    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].sessionId).toBe(ROOT)
    expect(h.shown[0].title).toBe('根会话')
  })

  it('派生 agent 的 error 落在运行态之外也不弹 —— 血缘在手，就不该被当成根会话那轮', () => {
    const h = makeCenter()
    h.center.handleEvent(register(SUB, ROOT, 'tool-call-1'))
    // 没有 agent_start（例如这轮压根没起来）：根会话遇到这种会立刻弹，子会话不该
    h.center.handleEvent({ type: 'error', sessionId: SUB, error: '模型未配置' })
    expect(h.shown).toHaveLength(0)
  })

  it('子会话结束一律不补通知 —— 无论是不是工具派发的', () => {
    const h = makeCenter()
    // 工具派发（agent 自己起的）
    h.center.handleEvent(register(SUB, ROOT, 'tool-call-1'))
    h.center.handleEvent({
      type: 'sub_session_end',
      sessionId: SUB,
      parentSessionId: ROOT,
      result: '找完了'
    })
    // 非工具派发（workflow 引擎 run()：auto-title / bot 管线），成功与失败都不弹 ——
    // 用户等的是根会话那轮，机械动作跑完先弹一条「已完成」只会误导
    h.center.handleEvent(register('sub-wf', ROOT))
    h.center.handleEvent({ type: 'agent_end', sessionId: 'sub-wf', reason: 'ok' })
    h.center.handleEvent({
      type: 'sub_session_end',
      sessionId: 'sub-wf',
      parentSessionId: ROOT,
      result: '标题已改'
    })
    h.center.handleEvent(register('sub-wf2', ROOT))
    h.center.handleEvent({
      type: 'sub_session_end',
      sessionId: 'sub-wf2',
      parentSessionId: ROOT,
      result: '工具连续失败',
      isError: true
    })
    expect(h.shown).toHaveLength(0)

    // 根会话那轮照常弹
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown.map((n) => n.kind)).toEqual(['done'])
  })
})
