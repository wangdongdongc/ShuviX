/**
 * 两份「发送那几秒」的会话级状态 —— 乐观占位（`sessionPendingPrompt`）与创建运行时期间
 * 的 MCP 连接态（`sessionMcpConnecting`）。
 *
 * 钉的是三件在 UI 上看不出来、坏了却很贵的事：
 *
 *   - **按会话隔离**：两条会话同时在发，切过去不能看见对方的占位 / 连接行；
 *   - **撤 = 删键，不是置 undefined**：`'A' in state` 是「有没有占位」的判据，留个空键
 *     会让选择器读到 undefined 却仍然认为这条会话有记录；
 *   - **状态没变就不换引用**：zustand 按引用判等，重复置真 / 撤一个没宣告过的名字若每次
 *     都造新对象，输入框与整条对话流会跟着白白重渲染（连接态每台服务器一收一放两次）。
 *
 * 不起 jsdom：这几样都是纯 store 读写，`getState()/setState()` 直接驱动即可（同 useSessionTools）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PENDING_PROMPT_ID,
  pendingPromptMessage,
  selectMcpConnecting,
  selectPendingPrompt,
  useChatStore
} from '../chatStore'

const A = 'sess-A'
const B = 'sess-B'

/** 把这几个键复位（store 是模块级单例，用例之间会串） */
beforeEach(() => {
  useChatStore.setState({
    activeSessionId: A,
    sessionPendingPrompt: {},
    sessionMcpConnecting: {}
  })
})

const state = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

describe('乐观占位（sessionPendingPrompt）', () => {
  it('UIF-U-5 设 / 撤按会话隔离；撤的是键本身；选择器随当前会话走', () => {
    const msgA = pendingPromptMessage(A, 'A 的一句')
    const msgB = pendingPromptMessage(B, 'B 的一句')
    state().setPendingPrompt(A, msgA)
    state().setPendingPrompt(B, msgB)

    // ① 选择器只答「当前会话」的那条：切过去看的是 B 自己的，欢迎页（无会话）什么都没有
    expect(selectPendingPrompt(state())).toBe(msgA)
    useChatStore.setState({ activeSessionId: B })
    expect(selectPendingPrompt(state())).toBe(msgB)
    useChatStore.setState({ activeSessionId: null })
    expect(selectPendingPrompt(state())).toBeNull()
    useChatStore.setState({ activeSessionId: A })

    // ② 撤 A：删键而不是置 undefined，且不碰 B
    state().setPendingPrompt(A, null)
    expect(A in state().sessionPendingPrompt).toBe(false)
    expect(selectPendingPrompt(state())).toBeNull()
    expect(state().sessionPendingPrompt[B]).toBe(msgB)

    // ③ 对没有占位的会话再撤一次：不换引用（user_message / agent_end / finally 三处都会撤，
    //    正常路径上后两次都是空撤 —— 每次都造新对象就是每条消息末尾白白重渲染一次）
    const before = state().sessionPendingPrompt
    state().setPendingPrompt(A, null)
    expect(state().sessionPendingPrompt).toBe(before)
  })

  it('UIF-U-5 pendingPromptMessage 与真实 user entry 同形：固定 id + 原文 + 透传的 metadata', () => {
    // 气泡组件不区分占位与真实 entry，形状必须一致；id 是固定值而非 entry id ——
    // 渲染层正是靠它认出「这条还没落库，不给回退」
    const tokens = {
      tok1: { type: 'at', id: 'src/a.ts', displayText: '@a.ts', payload: 'src/a.ts 的全文' }
    }
    const images = [{ data: 'AAAA', mimeType: 'image/png' }]
    const msg = pendingPromptMessage(A, '带附件的一句', { inlineTokens: tokens, images })
    expect(msg).toMatchObject({
      id: PENDING_PROMPT_ID,
      sessionId: A,
      role: 'user',
      type: 'text',
      content: '带附件的一句'
    })
    expect(msg.metadata).toEqual({ inlineTokens: tokens, images })

    // 不传 metadata 时是空对象（不是 undefined）—— 气泡读 `metadata?.images` 不必再分一档
    expect(pendingPromptMessage(A, '光秃秃一句').metadata).toEqual({})
  })
})

describe('MCP 连接态（sessionMcpConnecting）', () => {
  it('UIF-U-6 按到达序累加、重复置真不换引用、逐台撤空后删键', () => {
    const { setMcpConnecting } = state()
    setMcpConnecting(A, 'x', true)
    setMcpConnecting(A, 'y', true)
    // ① 列表是到达序（连接行按这个顺序念名字，不排序、不去重成 Set）
    expect(state().sessionMcpConnecting[A]).toEqual(['x', 'y'])

    // ② 同一台重复置真：state 原样不动
    const before = state().sessionMcpConnecting
    setMcpConnecting(A, 'x', true)
    expect(state().sessionMcpConnecting).toBe(before)

    // ③ 落定一台只摘一台
    setMcpConnecting(A, 'x', false)
    expect(state().sessionMcpConnecting[A]).toEqual(['y'])

    // ④ 最后一台落定：整键删掉，选择器回到**同一个**空数组常量
    setMcpConnecting(A, 'y', false)
    expect(A in state().sessionMcpConnecting).toBe(false)
    expect(selectMcpConnecting(state())).toBe(selectMcpConnecting(state()))
    expect(selectMcpConnecting(state())).toEqual([])

    // ⑤ 撤一台从没宣告过的：同样不换引用（`announce` 为假时宿主根本不发这一对事件，
    //    但事件是广播的，别的来源发来一条也不能把订阅者全叫醒）
    const emptied = state().sessionMcpConnecting
    setMcpConnecting(A, 'z', false)
    expect(state().sessionMcpConnecting).toBe(emptied)
  })

  it('UIF-U-6 clearMcpConnecting：有键整键删、无键不动；按会话隔离', () => {
    const { setMcpConnecting, clearMcpConnecting } = state()
    setMcpConnecting(A, 'x', true)
    setMcpConnecting(B, 'y', true)

    // 无键的会话（从没连过）：agent_created / agent_end / error 三处都会来清，不能每次都换引用
    const untouched = state().sessionMcpConnecting
    clearMcpConnecting('sess-never')
    expect(state().sessionMcpConnecting).toBe(untouched)

    clearMcpConnecting(A)
    expect(A in state().sessionMcpConnecting).toBe(false)
    expect(state().sessionMcpConnecting[B]).toEqual(['y'])

    // 当前会话是 A：它的连接行没了，B 的还留着（切过去还得看得见）
    expect(selectMcpConnecting(state())).toEqual([])
    useChatStore.setState({ activeSessionId: B })
    expect(selectMcpConnecting(state())).toEqual(['y'])
  })
})
