/**
 * `waitForPromptOutcome`：`agent.prompt` 因断线被拒之后，等视图回答这条消息受理了没有。
 * 宽限只算看得见视图的时间（连接连着、且这条会话是当前会话），不改任何状态。
 *
 *   PO-0  宽限比服务端受理前可能花的时间（MCP 惰性连接 5s）久
 *   PO-1  没有占位 → 立刻 true，不碰连接、没有定时器
 *   PO-2  连着，GRACE-1 时占位撤下 → true；监听与定时器全收
 *   PO-3  连着，占位一直在 → GRACE-1 未定、GRACE 时 false；占位不动
 *   PO-4  断着 → 多久都未定、没有定时器；连回来之后恰好 GRACE 判 false
 *   PO-5  连着走到 GRACE-1 → 断 → 再连：从头算
 *   PO-6  断着时占位撤下 → 立刻 true
 *   PO-7  连续两次 up（中间没有 down）→ 从第二次起算
 *   PO-8  别的会话的占位、无关的 store 写入 → 不算受理，也不重新起算
 *   PO-9  连接没有可选方法（isUp / onUp / onDown）→ 当它一直连着
 *   PO-10 落定之后 goUp / goDown / store 写入都没有动静、不留定时器；可以自定义宽限
 *   PO-11 一开始就不是当前会话 → 不起定时器；成为当前会话之后恰好 GRACE 判 false
 *   PO-12 当前会话走到 GRACE-1 → 切走很久 → 切回：从头算
 *   PO-13 切走期间占位撤下 → 立刻 true
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROMPT_OUTCOME_GRACE_MS as GRACE, waitForPromptOutcome } from '../promptOutcome'
import { pendingPromptMessage, useChatStore } from '../chatStore'
import { resetStore, store } from '../../__tests__/support/views'
import { fakeLink, useFakeClock, type FakeLink } from '../../__tests__/support/sendFailure'

const S = 's1'

let link: FakeLink

const setBubble = (sid = S): void =>
  store().setPendingPrompt(sid, pendingPromptMessage(sid, 'hello'))
const clearBubble = (sid = S): void => store().setPendingPrompt(sid, null)

/** 开始等；`state()` 读此刻的结果（undefined = 未定） */
function wait(
  graceMs?: number,
  channel: Parameters<typeof waitForPromptOutcome>[1] = link
): { state(): boolean | undefined } {
  let outcome: boolean | undefined
  void waitForPromptOutcome(S, channel, graceMs).then((value) => {
    outcome = value
  })
  return { state: () => outcome }
}

const tick = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  useFakeClock()
  resetStore(S)
  link = fakeLink()
})

afterEach(() => {
  resetStore(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('waitForPromptOutcome', () => {
  it('PO-0 the grace outlasts what the server may spend before accepting (a lazy MCP connect is 5 s)', () => {
    expect(GRACE).toBeGreaterThan(5000)
  })

  it('PO-1 no bubble: true at once, the link untouched, no timers', async () => {
    const pending = wait()
    await tick()
    expect(pending.state()).toBe(true)
    expect(link.isUp).not.toHaveBeenCalled()
    expect(link.onUp).not.toHaveBeenCalled()
    expect(link.onDown).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('PO-2 link up, bubble cleared at GRACE-1: true, every listener off, no timers', async () => {
    const subscribe = useChatStore.subscribe
    let storeListeners = 0
    vi.spyOn(useChatStore, 'subscribe').mockImplementation((listener) => {
      storeListeners++
      const stop = subscribe(listener)
      return () => {
        storeListeners--
        stop()
      }
    })
    setBubble()
    const pending = wait()
    expect(link.upListeners()).toBe(1)
    expect(link.downListeners()).toBe(1)
    expect(storeListeners).toBe(1)
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    clearBubble()
    await tick()
    expect(pending.state()).toBe(true)
    expect(link.upListeners()).toBe(0)
    expect(link.downListeners()).toBe(0)
    expect(storeListeners).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('PO-3 link up, never cleared: undecided at GRACE-1, false at GRACE, the bubble stays', async () => {
    setBubble()
    const pending = wait()
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
    expect(store().sessionPendingPrompt[S]).toBeDefined()
  })

  it('PO-4 link down: undecided with no timers however long; false exactly GRACE after the up', async () => {
    link = fakeLink(false)
    setBubble()
    const pending = wait()
    expect(vi.getTimerCount()).toBe(0)
    await tick(10 * GRACE)
    expect(pending.state()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    link.goUp()
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-5 up, GRACE-1, down, 10×GRACE, up: counts from the second up', async () => {
    setBubble()
    const pending = wait()
    await tick(GRACE - 1)
    link.goDown()
    expect(vi.getTimerCount()).toBe(0)
    await tick(10 * GRACE)
    expect(pending.state()).toBeUndefined()
    link.goUp()
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-6 link down, bubble cleared: true at once', async () => {
    link = fakeLink(false)
    setBubble()
    const pending = wait()
    clearBubble()
    await tick()
    expect(pending.state()).toBe(true)
  })

  it('PO-7 two ups with no down between: restarts from the second', async () => {
    setBubble()
    const pending = wait()
    await tick(GRACE / 2)
    link.goUp()
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    link.goUp()
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it("PO-8 another session's bubble and unrelated writes: undecided, and the timer is not restarted", async () => {
    setBubble()
    const pending = wait()
    await tick(GRACE / 2)
    setBubble('other')
    clearBubble('other')
    store().setInputText('typing')
    store().setMcpConnecting(S, 'srv', true)
    await tick()
    expect(pending.state()).toBeUndefined()
    await tick(GRACE / 2 - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-9 a link with no optional methods: the timer starts at once, false at GRACE', async () => {
    setBubble()
    const pending = wait(undefined, {})
    expect(vi.getTimerCount()).toBe(1)
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-10 after settling nothing reacts and no timers remain; a custom grace is honoured', async () => {
    setBubble()
    const pending = wait(1000)
    await tick(999)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)

    link.goDown()
    link.goUp()
    store().setInputText('later')
    clearBubble()
    await tick(5 * GRACE)
    expect(pending.state()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(link.upListeners()).toBe(0)
    expect(link.downListeners()).toBe(0)
  })

  it('PO-11 not the active session at the start: no timer however long; false exactly GRACE after it becomes active', async () => {
    setBubble()
    store().setActiveSessionId('other')
    const pending = wait()
    expect(vi.getTimerCount()).toBe(0)
    await tick(10 * GRACE)
    expect(pending.state()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    store().setActiveSessionId(S)
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-12 active, GRACE-1, away for 10×GRACE, back: counts from the return', async () => {
    setBubble()
    const pending = wait()
    await tick(GRACE - 1)
    store().setActiveSessionId('other')
    expect(vi.getTimerCount()).toBe(0)
    await tick(10 * GRACE)
    expect(pending.state()).toBeUndefined()
    store().setActiveSessionId(S)
    await tick(GRACE - 1)
    expect(pending.state()).toBeUndefined()
    await tick(1)
    expect(pending.state()).toBe(false)
  })

  it('PO-13 away, bubble cleared: true at once', async () => {
    setBubble()
    const pending = wait()
    store().setActiveSessionId('other')
    clearBubble()
    await tick()
    expect(pending.state()).toBe(true)
  })
})
