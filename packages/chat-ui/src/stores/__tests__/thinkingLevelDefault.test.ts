/**
 * 思考档位的「默认档」标记（`thinkingLevelIsDefault`）—— 欢迎页发送写不写档位，看的就是它。
 *
 * 钉三件事：
 *
 *   - **没有宿主种子就不算默认档**：store 的初始态是 DEFAULT_THINKING_LEVEL、标记为假 —— 扩展侧栏与
 *     单测没有启动种子，欢迎页发送照旧把显示的档位写进新会话；
 *   - **种子 = 默认档**：`seedDefaultThinkingLevel(v)` 把档位设成 v、标记置真（宿主启动时从设置里种）；
 *   - **任何 `setThinkingLevel` 都清掉标记**：用户点了一档（哪怕点的就是种下的那一档）、或切会话时
 *     useSessionInit 同步会话自己的档位，都是「有人定过了」，之后欢迎页发送照显示的写。
 *
 * 不起 jsdom：纯 store 读写，`getState()/setState()` 直接驱动（同 pendingPrompt.test.ts）。
 * 欢迎页发送据此写 / 不写的时间线在 `inputAreaWelcomeSend.dom.test.tsx`（WS-D-8…10），选择器本身
 * 改档位的行为在 `modelPicker.dom.test.tsx`（MP-13 / MP-14）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import { useChatStore } from '../chatStore'

const state = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 把这两个键复位到初始态（store 是模块级单例，用例之间会串） */
beforeEach(() => {
  const initial = useChatStore.getInitialState()
  useChatStore.setState({
    thinkingLevel: initial.thinkingLevel,
    thinkingLevelIsDefault: initial.thinkingLevelIsDefault
  })
})

describe('思考档位的默认档标记', () => {
  it('DT-U-1 初始态：档位 = DEFAULT_THINKING_LEVEL，标记为假（没有宿主种子不算默认档）', () => {
    const initial = useChatStore.getInitialState()
    expect(initial.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL)
    expect(initial.thinkingLevelIsDefault).toBe(false)
  })

  it('DT-U-2 seedDefaultThinkingLevel(xhigh) → 档位 xhigh、标记为真', () => {
    state().seedDefaultThinkingLevel('xhigh')
    expect(state().thinkingLevel).toBe('xhigh')
    expect(state().thinkingLevelIsDefault).toBe(true)
  })

  it.each(['low', 'xhigh', 'off'])(
    'DT-U-3 种了 xhigh 之后 setThinkingLevel(%s) → 档位跟过去、标记清掉（同一档也清）',
    (level) => {
      state().seedDefaultThinkingLevel('xhigh')
      expect(state().thinkingLevelIsDefault).toBe(true)

      state().setThinkingLevel(level)
      expect(state().thinkingLevel).toBe(level)
      expect(state().thinkingLevelIsDefault).toBe(false)
    }
  )
})
