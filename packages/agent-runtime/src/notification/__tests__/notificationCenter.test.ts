/**
 * 通知决策器 —— 两端共用的那份「什么时候该打扰用户」。
 *
 * 这里钉的都是**只能靠断言守住的取舍**：事件流里派生 agent 与根 agent 完全同构，
 * 一次失败会广播不止一条 error，笔记本会话整轮跑在子会话里……任何一条判错，症状都是
 * 「通知多了 / 少了一条」这种上线才有人抱怨、且没人会写复现步骤的事。
 */
import { describe, it, expect } from 'vitest'
import { createNotificationCenter, type NotificationCenter } from '../notificationCenter'
import type { AgentNotification, AgentNotificationKind } from '@shuvix/chat-protocol/notification'
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
  /** 这几类的开关关着（其余看 enabled.value） */
  disabled: Set<AgentNotificationKind>
  titles: Map<string, string>
  /** 宿主的失败文本 seam（PIN-08）：会话 → 最后一条错误行 */
  errorTexts: Map<string, string>
}

function makeCenter(): Harness {
  const shown: AgentNotification[] = []
  const dismissed: string[] = []
  const foreground = new Set<string>()
  const enabled = { value: true }
  const disabled = new Set<AgentNotificationKind>()
  const titles = new Map<string, string>()
  const errorTexts = new Map<string, string>()
  const center = createNotificationCenter({
    notifier: {
      show: (n) => shown.push(n),
      dismiss: (key) => dismissed.push(key)
    },
    isForeground: (sessionId) => foreground.has(sessionId),
    sessionTitle: (sessionId) => titles.get(sessionId),
    enabled: (kind) => enabled.value && !disabled.has(kind),
    runErrorText: (sessionId) => errorTexts.get(sessionId),
    // 文案断言只关心 key 与插值，不关心具体译文
    t: (key, vars) => (vars ? `${key}|${Object.values(vars).join(',')}` : key)
  })
  return { center, shown, dismissed, foreground, enabled, disabled, titles, errorTexts }
}

function askRequest(id = 'req-1', command = 'rm -rf build'): InputRequest {
  return { id, kind: 'ask', toolName: 'bash', createdAt: 0, command }
}

/** 子会话登记：parentToolCallId 有值 = agent 经派发工具起的；无值 = hook 派发起的 */
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

    h.center.askRaised(ROOT, askRequest())
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]).toMatchObject({
      key: 'ask:req-1',
      kind: 'ask',
      sessionId: ROOT,
      title: '重构会话',
      requestId: 'req-1'
    })
    expect(h.shown[0].body).toBe('notification.askBody|rm -rf build')

    h.center.askResolved(ROOT, 'req-1')
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

  it('P3-08-56 失败的正文取宿主给的最后一条错误行（PIN-08）；runEnded 带的文本优先，攒下的 error 事件更优先', () => {
    const h = makeCenter()
    h.errorTexts.set(ROOT, '429 Too Many Requests')
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    expect(h.shown.at(-1)!.body).toBe('notification.failedBody|429 Too Many Requests')

    h.center.runEnded(ROOT, 'error', 'explicit text')
    expect(h.shown.at(-1)!.body).toBe('notification.failedBody|explicit text')

    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: 'MCP down' })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    expect(h.shown.at(-1)!.body).toBe('notification.failedBody|MCP down')
    // 每一轮恰一条
    expect(h.shown.map((n) => n.kind)).toEqual(['failed', 'failed', 'failed'])

    // ok / aborted 从不问 seam；ok 弹完成
    h.errorTexts.clear()
    h.center.runEnded(ROOT, 'aborted')
    h.center.runEnded(ROOT, 'ok')
    expect(h.shown.map((n) => n.kind)).toEqual(['failed', 'failed', 'failed', 'done'])
  })

  it('P3-08-56 seam 取不到 / 抛错 → 正文为空的失败通知，照弹', () => {
    const h = makeCenter()
    h.center.runEnded(ROOT, 'error')
    expect(h.shown.map((n) => n.kind)).toEqual(['failed'])
    expect(h.shown[0].body).toBe('notification.failedBody|')
  })
})

describe('通知决策器 — 不打扰的条件', () => {
  it('用户正看着这个会话就不弹', () => {
    const h = makeCenter()
    h.foreground.add(ROOT)
    h.center.askRaised(ROOT, askRequest())
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(0)
  })

  it('开关判定回关就不弹', () => {
    const h = makeCenter()
    h.enabled.value = false
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(0)
  })

  it('用户打开会话后，它名下挂着的通知一并撤回', () => {
    const h = makeCenter()
    h.center.askRaised(ROOT, askRequest('a'))
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
    h.center.askRaised(ROOT, askRequest('r', `cat <<'EOF'\n${'x'.repeat(300)}\nEOF`))
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
    h.center.askRaised(SUB, askRequest('q'))

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
    // 非工具派发（hook runner：auto-title），成功与失败都不弹 ——
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

/**
 * 一类一个开关（设置 → 通用 → 通知）。决策器只认 `enabled(kind)`：开关管的是**弹不弹这一类**，不改这件事
 * 算哪一类（失败不会因为失败通知关着就降级成完成），也不碰已经弹出去的那些（撤回照常）。
 *
 *   NK-C1 只关一类：另外两类照弹
 *   NK-C2 失败 / 完成互不牵连：失败的一轮不降级成完成，运行外的 error 同样按失败算
 *   NK-C3 每次判定时现读：同一个决策器上改开关立即生效，不必重建
 *   NK-C4 弹出之后全关：撤回不受开关影响，也不补弹
 *   NK-C5 关着时没弹的询问不留 key：打开会话不撤回它，落定不抛错；再开之后新的一条照常登记与撤回
 *   NK-C6 关着时吞掉的失败不留到下一轮：开回来后那轮正常结束就是完成
 *   NK-C7 失败关着时，同会话上一条完成不被这次失败覆盖；它的 key 还在，打开会话照样撤回
 *   NK-C8 宿主没给 enabled：三类都弹
 */
describe('通知决策器 — 一类一个开关', () => {
  const S1 = 'sess-1'
  const S2 = 'sess-2'
  const KINDS: AgentNotificationKind[] = ['ask', 'done', 'failed']

  it.each(KINDS)('NK-C1 只关 %s：另外两类照弹', (off) => {
    const h = makeCenter()
    h.disabled.add(off)
    h.errorTexts.set(S2, '429')

    h.center.askRaised(ROOT, askRequest('a'))
    h.center.handleEvent({ type: 'agent_end', sessionId: S1, reason: 'ok' })
    h.center.handleEvent({ type: 'agent_end', sessionId: S2, reason: 'error' })

    expect(h.shown.map((n) => n.kind)).toEqual(KINDS.filter((kind) => kind !== off))
  })

  /** 两条路：运行中攒下 error、这轮却以 ok 收尾（仍算失败）；然后一条运行外的 error */
  function failThroughBothPaths(h: Harness): void {
    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: 'boom' })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: 'no model' })
  }

  it('NK-C2a 失败关、完成开：什么都不弹，不降级成完成', () => {
    const h = makeCenter()
    h.disabled.add('failed')
    failThroughBothPaths(h)
    expect(h.shown).toEqual([])
  })

  it('NK-C2b 完成关、失败开：每条路各一条失败', () => {
    const h = makeCenter()
    h.disabled.add('done')
    failThroughBothPaths(h)
    expect(h.shown.map((n) => n.kind)).toEqual(['failed', 'failed'])
    expect(h.shown.map((n) => n.body)).toEqual([
      'notification.failedBody|boom',
      'notification.failedBody|no model'
    ])
  })

  it('NK-C3 同一个决策器上改开关立即生效：关 → 开 → 关，只弹开着时那条', () => {
    const h = makeCenter()
    h.disabled.add('ask')
    h.center.askRaised(ROOT, askRequest('a'))
    h.disabled.delete('ask')
    // 打开本身不补弹
    expect(h.shown).toEqual([])
    h.center.askRaised(ROOT, askRequest('b'))
    h.disabled.add('ask')
    h.center.askRaised(ROOT, askRequest('c'))
    expect(h.shown.map((n) => n.key)).toEqual(['ask:b'])
  })

  it('NK-C4 弹出之后三类全关：落定与打开会话照样撤回，不多弹', () => {
    const h = makeCenter()
    h.center.askRaised(ROOT, askRequest('a'))
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown).toHaveLength(2)

    for (const kind of KINDS) h.disabled.add(kind)
    h.center.askResolved(ROOT, 'a')
    h.center.sessionOpened(ROOT)

    expect(h.dismissed).toEqual(['ask:a', `run:${ROOT}`])
    expect(h.shown).toHaveLength(2)
  })

  it('NK-C5 关着时没弹的询问不留 key；再开之后新的一条照常撤回', () => {
    const h = makeCenter()
    h.disabled.add('ask')
    h.center.askRaised(ROOT, askRequest('a'))

    h.center.sessionOpened(ROOT)
    expect(h.dismissed).toEqual([])
    // 撤回一条没弹过的：宿主的 dismiss 对不存在的 key 本来就静默，这里只要求不抛
    expect(() => h.center.askResolved(ROOT, 'a')).not.toThrow()

    h.disabled.delete('ask')
    h.center.askRaised(ROOT, askRequest('b'))
    h.center.sessionOpened(ROOT)
    expect(h.dismissed).toContain('ask:b')
    expect(h.shown.map((n) => n.key)).toEqual(['ask:b'])
  })

  it('NK-C6 关着时吞掉的失败不留到下一次收尾：开回来之后正常结束就是完成', () => {
    const h = makeCenter()
    h.disabled.add('failed')
    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: 'boom' })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    expect(h.shown).toEqual([])

    h.disabled.delete('failed')
    h.center.runEnded(ROOT, 'ok')
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]).toMatchObject({ kind: 'done', body: 'notification.doneBody' })
  })

  it('NK-C7 失败关着时同会话的一轮失败不弹；上一条完成的 key 还在，打开会话撤回一次', () => {
    const h = makeCenter()
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'ok' })
    expect(h.shown.map((n) => n.key)).toEqual([`run:${ROOT}`])

    h.disabled.add('failed')
    h.center.handleEvent({ type: 'agent_start', sessionId: ROOT })
    h.center.handleEvent({ type: 'error', sessionId: ROOT, error: 'boom' })
    h.center.handleEvent({ type: 'agent_end', sessionId: ROOT, reason: 'error' })
    h.center.sessionOpened(ROOT)

    expect(h.shown).toHaveLength(1)
    expect(h.dismissed).toEqual([`run:${ROOT}`])
  })

  it('NK-C8 宿主没给 enabled：三类都弹', () => {
    const shown: AgentNotification[] = []
    const center = createNotificationCenter({
      notifier: { show: (n) => shown.push(n), dismiss: () => {} },
      isForeground: () => false,
      t: (key) => key
    })
    center.askRaised(ROOT, askRequest('a'))
    center.handleEvent({ type: 'agent_end', sessionId: S1, reason: 'ok' })
    center.handleEvent({ type: 'agent_end', sessionId: S2, reason: 'error' })
    expect(shown.map((n) => n.kind)).toEqual(KINDS)
  })
})
