/**
 * `buildVisibleItems` —— 消息列表 → 对话流的项。
 *
 * 钉的是**分组**：连续的 assistant 消息收成一张卡（遇终答 / 用户消息 / 列表结束收口），
 * 代表消息 `msg` 取组**末**条。助手卡的 key **按轮次起**（`turn:<用户消息条数>.<本轮第几张卡>`），
 * 不取任何一条消息的 id —— 流式到落定之间卡里的消息 id 会换三次（见 K 组），key 一次都不能跟着换，
 * 否则整张卡重挂载。用户消息 / 压缩摘要 / 错误行仍按自己的 id。压缩摘要是边界标记，自成一项。
 *
 * 另有一组钉**项的复用**（IR 组）：内容没变的项交回上一次的同一个对象（助手项连同同一个 msgs 数组），
 * 卡的 memo 才拦得住 —— 缓存按消息对象记（模块级 WeakMap），所以 IR 组每条用例都用自己新造的消息对象。
 */
import { describe, it, expect } from 'vitest'
import type {
  AssistantBlock,
  AssistantMessage,
  ChatMessage,
  ErrorEventMessage,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import { buildVisibleItems } from '../conversationItems'
import { STREAMING_PLACEHOLDER_ID } from '../MessageRenderer'
import { PENDING_PROMPT_ID, pendingPromptMessage } from '../../../stores/chatStore'

const SID = 'sess-1'

const base = (id: string): { id: string; sessionId: string; model: string; createdAt: number } => ({
  id,
  sessionId: SID,
  model: '',
  createdAt: 0
})

/** 普通助手消息：`tools` 条工具块（有工具块 = 不收口），没有则是一条终答 */
function agentMsg(id: string, opts: { tools?: number } = {}): AssistantMessage {
  const blocks: AssistantBlock[] = []
  for (let i = 0; i < (opts.tools ?? 0); i++) {
    blocks.push({ type: 'tool', toolCallId: `${id}-t${i}`, toolName: 'read' })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: 'answer' })
  return {
    ...base(id),
    role: 'assistant',
    type: 'message',
    content: 'answer',
    blocks,
    metadata: null
  }
}

function userMsg(id: string): UserTextMessage {
  return { ...base(id), role: 'user', type: 'text', content: 'hi', metadata: null }
}

function errMsg(id: string): ErrorEventMessage {
  return {
    ...base(id),
    role: 'system_notify',
    type: 'error_event',
    content: 'boom',
    metadata: null
  }
}

/**
 * 压缩摘要 —— 形状对齐 `projection.ts` 对 compaction entry 的投影：
 * 单个 text 块的 assistant 消息 + `metadata.isCompactionSummary`。
 */
function compactionMsg(id: string, summary = '此前对话的摘要'): AssistantMessage {
  return {
    ...base(id),
    role: 'assistant',
    type: 'message',
    content: summary,
    blocks: [{ type: 'text', text: summary }],
    metadata: { isCompactionSummary: true }
  }
}

describe('buildVisibleItems —— 分组', () => {
  it('G-1 带工具块的消息不收口，与紧随的终答合成一项：key 按轮次、msg 取组末', () => {
    const items = buildVisibleItems(
      [agentMsg('m1', { tools: 1 }), agentMsg('m2'), agentMsg('m3')],
      false
    )
    expect(items).toHaveLength(2)
    expect(items[0].key).toBe('turn:0.0')
    expect(items[0].msg.id).toBe('m2')
    expect(items[0].msgs?.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(items[1].key).toBe('turn:0.1')
  })

  it('G-2 用户消息与 error_event 各自成项，并把前后的助手消息隔开', () => {
    const items = buildVisibleItems(
      [agentMsg('m1', { tools: 1 }), userMsg('u1'), agentMsg('m2'), errMsg('e1'), agentMsg('m3')],
      false
    )
    expect(items.map((i) => i.msg.id)).toEqual(['m1', 'u1', 'm2', 'e1', 'm3'])
  })

  it('G-3 非 error 的 system_notify 根本不成项 —— 它两侧的助手消息仍在同一组', () => {
    // 类型上今天已经没有这种消息了（ChatMessage 只有 error_event 一种 system_notify），
    // 但那个 continue 分支还在，钉住它：「跳过它」和「它把两侧隔开」是两种截然不同的结果
    const notice = {
      ...base('n1'),
      role: 'system_notify',
      type: 'notice',
      content: '一条提示',
      metadata: null
    } as unknown as ChatMessage
    const items = buildVisibleItems([agentMsg('m1', { tools: 1 }), notice, agentMsg('m2')], false)
    expect(items.map((i) => i.key)).toEqual(['turn:0.0'])
    expect(items[0].msgs?.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('G-4 流式 + 末项已收口 → 占位自成一项，metadata 为 null，前面的项不受影响', () => {
    const items = buildVisibleItems([agentMsg('m1'), agentMsg('m2')], true)
    expect(items).toHaveLength(3)
    expect(items.slice(0, 2).map((i) => i.key)).toEqual(['turn:0.0', 'turn:0.1'])
    expect(items[2].key).toBe('turn:0.2')
    expect(items[2].msg.id).toBe(STREAMING_PLACEHOLDER_ID)
    expect(items[2].msg.metadata).toBeNull()
    expect(items[2].isStreamingPlaceholder).toBe(true)
  })

  it('G-5 流式 + 空 messages → 只有占位项一项，不抛', () => {
    const items = buildVisibleItems([], true)
    expect(items).toHaveLength(1)
    expect(items[0].msg.id).toBe(STREAMING_PLACEHOLDER_ID)
    expect(items[0].msg.sessionId).toBe('')
  })

  it('G-6 纯函数：连调两次结果一致，且不改写传入的 ChatMessage', () => {
    // 项是另造的对象（没变的项会被复用，见 IR 组），派生字段从不挂到消息对象上 —— 若哪天挂上去，
    // store 里的消息会被一次渲染悄悄改脏，而 zustand 的浅比较看不出来
    const messages: ChatMessage[] = [agentMsg('m1', { tools: 1 }), agentMsg('m2'), userMsg('u1')]
    const snapshot = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
    const once = buildVisibleItems(messages, false)
    const twice = buildVisibleItems(messages, false)
    expect(twice).toEqual(once)
    expect(messages).toEqual(snapshot)
  })
})

describe('buildVisibleItems —— 空回复追问', () => {
  it('ER-G-1 u → 工具 → 只有思考的空回复 → 追问（系统写的 user 消息）→ 终答：空回复收口第一张卡，追问自成一项，终答另起一张卡', () => {
    const thinkingOnly: AssistantMessage = {
      ...agentMsg('m2'),
      content: '',
      blocks: [{ type: 'thinking', text: 'I will read it' }]
    }
    const notice: UserTextMessage = {
      ...userMsg('n1'),
      content: '<empty-reply>\nYour previous reply had no visible text.\n</empty-reply>',
      metadata: { isSystemNotice: true, noticeKind: 'empty-reply' }
    }
    const items = buildVisibleItems(
      [userMsg('u1'), agentMsg('m1', { tools: 1 }), thinkingOnly, notice, agentMsg('m3')],
      false
    )
    expect(items.map((i) => i.msg.id)).toEqual(['u1', 'm2', 'n1', 'm3'])
    expect(items[1].msgs?.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(items[2].key).toBe('n1')
    expect(items[2].msgs).toBeUndefined()
    expect(items[3].msgs?.map((m) => m.id)).toEqual(['m3'])
  })
})

/**
 * 压缩摘要虽然也是 assistant 消息，却是**边界标记**而不是哪一轮的终答：自成一项，
 * 不并入前后任何一张卡。并进去的话，一段没有终答的过程（中止 / steer）会把摘要
 * 当成自己的「结论」画在正文位上。
 */
describe('buildVisibleItems —— 压缩摘要自成一项', () => {
  it('C-1 只有一条压缩摘要 → 一项：key 是它的 id，msg 是它，没有 msgs 也没有占位标记', () => {
    const c = compactionMsg('c')
    const items = buildVisibleItems([c], false)
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('c')
    expect(items[0].msg).toBe(c)
    expect(items[0].msgs).toBeUndefined()
    expect(items[0].isStreamingPlaceholder).toBeUndefined()
  })

  it('C-2 未收口的组（带工具块、没有终答）后面来了压缩摘要 → 先 flush 那张卡，摘要另成一项', () => {
    // 回归：摘要若并入前一组，那张没有终答的卡会拿摘要当终答
    const m1 = agentMsg('m1', { tools: 1 })
    const c = compactionMsg('c')
    const items = buildVisibleItems([m1, c], false)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'turn:0.0', msgs: [m1] })
    expect(items[1].key).toBe('c')
    expect(items[1].msgs).toBeUndefined()
  })

  it('C-3 压缩摘要之后的终答另起一项：msgs 只有它，key 是一张卡的 key 而不是摘要的 id', () => {
    // 回归：摘要若留在 group 里当组首，后面终答那张卡会把摘要卷进 msgs
    const c = compactionMsg('c')
    const m2 = agentMsg('m2')
    const items = buildVisibleItems([c, m2], false)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ key: 'turn:0.0', msgs: [m2] })
    expect(items[1].msg.id).toBe('m2')
  })

  it('C-4 u1 → m1(工具) → c → m2(工具) → m3(终答)：keys 为 u1 / 第 1 轮第 0 张 / c / 第 1 轮第 1 张，末项 msgs=[m2,m3]', () => {
    const m2 = agentMsg('m2', { tools: 1 })
    const m3 = agentMsg('m3')
    const items = buildVisibleItems(
      [userMsg('u1'), agentMsg('m1', { tools: 1 }), compactionMsg('c'), m2, m3],
      false
    )
    expect(items.map((i) => i.key)).toEqual(['u1', 'turn:1.0', 'c', 'turn:1.1'])
    expect(items[3].msgs).toEqual([m2, m3])
    expect(items[3].msg.id).toBe('m3')
  })

  it('C-5 流式 + 末尾是压缩摘要 → [摘要项, 占位项]：占位自成一组，不把摘要卷进来', () => {
    // 摘要 flush 后 group 为空，占位卡另起一组；sessionId 从列表末条（摘要）兜底取
    const c = compactionMsg('c')
    const items = buildVisibleItems([c], true)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ key: 'c', msg: c })
    expect(items[1].key).toBe('turn:0.0')
    expect(items[1].isStreamingPlaceholder).toBe(true)
    expect(items[1].msgs).not.toContain(c)
    expect(items[1].msgs?.map((m) => m.id)).toEqual([STREAMING_PLACEHOLDER_ID])
    expect(items[1].msg.sessionId).toBe(c.sessionId)
  })

  it('C-6 metadata 为 null / 没有该标记 / 标记为 false → 按普通助手消息分组（并入前面的工具卡）', () => {
    // 判据是 `metadata?.isCompactionSummary` 的真值：三种「不是摘要」的写法都走普通分组
    const variants: Array<AssistantMessage['metadata']> = [null, {}, { isCompactionSummary: false }]
    for (const metadata of variants) {
      const m1 = agentMsg('m1', { tools: 1 })
      const m2: AssistantMessage = { ...agentMsg('m2'), metadata }
      const items = buildVisibleItems([m1, m2], false)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ key: 'turn:0.0', msgs: [m1, m2] })
      expect(items[0].msg.id).toBe('m2')
    }
  })
})

/**
 * 乐观占位（`pending`）—— 正在发送、后端还没落库的那条用户消息。
 *
 * 它在列表里的位置是一条呈现契约：**末尾、流式占位卡之前**，且**不并进上一张没收口的
 * 助手卡**。并进去的话，新一轮的那句话会画在上一轮的过程区里；排在流式卡之后则会
 * 变成「答完了才显示问题」。
 */
describe('buildVisibleItems —— 乐观占位', () => {
  it('UIF-U-1 排在末尾、流式卡之前，且不并入上一张没收口的助手卡', () => {
    const a1 = agentMsg('a1', { tools: 1 })
    const pending = pendingPromptMessage(SID, '新的一句')
    const items = buildVisibleItems([userMsg('u1'), a1], true, pending)

    expect(items.map((i) => i.key)).toEqual(['u1', 'turn:1.0', PENDING_PROMPT_ID, 'turn:2.0'])
    // a1 那张卡在占位之前就收口了：它是上一轮的，既不是流式卡也不该把占位卷进去
    expect(items[1].isStreamingPlaceholder).toBeUndefined()
    expect(items[1].msgs?.map((m) => m.id)).toEqual(['a1'])
    // 占位自成一项，msg 就是它本身
    expect(items[2].msg).toBe(pending)
    expect(items[2].msgs).toBeUndefined()
    // 流式卡另起一组，只有它自己
    expect(items[3].isStreamingPlaceholder).toBe(true)
    expect(items[3].msgs).toHaveLength(1)
    expect(items[3].msgs?.[0].id).toBe(STREAMING_PLACEHOLDER_ID)
  })

  it('UIF-U-2 不传 pending 时逐项与改前一致（null / undefined / 不传三者等价）', () => {
    // 回归：第三个参数是后加的，「没有占位」这条主路径上一个字节都不该变
    const msgs: ChatMessage[] = [
      userMsg('u1'),
      agentMsg('m1', { tools: 1 }),
      agentMsg('m2'),
      compactionMsg('c'),
      errMsg('e1')
    ]
    const bare = buildVisibleItems(msgs, false)
    expect(buildVisibleItems(msgs, false, null)).toEqual(bare)
    expect(buildVisibleItems(msgs, false, undefined)).toEqual(bare)

    expect(bare.map((i) => i.key)).toEqual(['u1', 'turn:1.0', 'c', 'e1'])
    expect(bare.map((i) => i.msg.id)).toEqual(['u1', 'm2', 'c', 'e1'])
  })

  it('UIF-U-3 非流式时占位就是最后一项，不凭空造出流式卡', () => {
    const items = buildVisibleItems(
      [userMsg('u1'), agentMsg('m1')],
      false,
      pendingPromptMessage(SID, '刚发出去')
    )
    expect(items.at(-1)?.key).toBe(PENDING_PROMPT_ID)
    expect(items.map((i) => i.msg.id)).not.toContain(STREAMING_PLACEHOLDER_ID)
  })

  it('UIF-U-4 消息列表为空时，流式占位卡的 sessionId 取自 pending', () => {
    // 空列表 + 流式：sessionId 只剩 pending 这一个来源（G-5 里没有它时回落空串），
    // 而 AssistantBubble 要靠它读本会话的流式状态
    const items = buildVisibleItems([], true, pendingPromptMessage(SID, '会话里的第一句'))
    expect(items.map((i) => i.key)).toEqual([PENDING_PROMPT_ID, 'turn:1.0'])
    expect(items[1].msg.sessionId).toBe(SID)
  })
})

/**
 * 一张助手卡从「刚按下发送」到「这一轮写完」，里面的消息 id 要换三次；它的 key 一次都不能换 ——
 * 换了就是整张卡重挂载：展开的工具卡 / 思考块被折回去，卡里的交互图（```interactive）整块重载。
 * 从前 key 取组首消息 id，纯文字回复收尾那一刻占位本身就是组首，于是恰好在第 3 步换了 key
 * （chat-interactive e2e 的 E-4b）。
 */
describe('buildVisibleItems —— 助手卡的 key 从流式到落定不变', () => {
  const cardKey = (items: ReturnType<typeof buildVisibleItems>): string | undefined =>
    items.find((i) => i.msgs !== undefined)?.key

  it('K-1 纯文字的一轮：乐观占位 → 落库的用户消息 → 流式占位 → 真实终答，卡的 key 始终一样', () => {
    const history: ChatMessage[] = [userMsg('u0'), agentMsg('a0')]
    const sending = buildVisibleItems(history, true, pendingPromptMessage(SID, '问一句'))
    const accepted = buildVisibleItems([...history, userMsg('u1')], true)
    const settled = buildVisibleItems([...history, userMsg('u1'), agentMsg('a1')], false)
    const last = (items: ReturnType<typeof buildVisibleItems>): string => items.at(-1)!.key
    expect(last(sending)).toBe(last(accepted))
    expect(last(accepted)).toBe(last(settled))
    // 上一轮那张卡的 key 在三个时刻都没动
    expect(cardKey(sending)).toBe(cardKey(settled))
  })

  it('K-2 带工具的一轮：第一条落库的助手消息并进流式卡、再到终答，key 不变', () => {
    const history: ChatMessage[] = [userMsg('u1')]
    const placeholderOnly = buildVisibleItems(history, true)
    const withTool = buildVisibleItems([...history, agentMsg('m1', { tools: 1 })], true)
    const settled = buildVisibleItems(
      [...history, agentMsg('m1', { tools: 1 }), agentMsg('m2')],
      false
    )
    expect(placeholderOnly.at(-1)!.key).toBe(withTool.at(-1)!.key)
    expect(withTool.at(-1)!.key).toBe(settled.at(-1)!.key)
    expect(settled.at(-1)!.msgs?.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('K-3 key 互不相同：同一轮里收口后又来的卡、各轮之间、与消息 id 都不撞', () => {
    const items = buildVisibleItems(
      [
        userMsg('u1'),
        agentMsg('m1'),
        agentMsg('m2'),
        errMsg('e1'),
        agentMsg('m3'),
        userMsg('u2'),
        agentMsg('m4')
      ],
      true
    )
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([
      'u1',
      'turn:1.0',
      'turn:1.1',
      'e1',
      'turn:1.2',
      'u2',
      'turn:2.0',
      'turn:2.1'
    ])
  })
})

/**
 * 运行中的会话每落盘一步整张列表都要重建；没变的项若每次都是新对象，每张助手卡的 memo 全数失效、屏幕上每张卡都
 * 重新解析自己的 markdown。按身份缓存之后只有真变了的那几项是新的。命中的条件：同一条消息对象（助手项看组首），
 * 且 key、流式标记、组内消息逐个相同 —— 少一条都会把旧项错当成新项交出去（key 错了是重挂载，msgs 错了是画旧内容）。
 */
describe('buildVisibleItems —— 项的复用', () => {
  type Items = ReturnType<typeof buildVisibleItems>

  it('IR-1 同一份 messages 连建两次：每一项都是上一次的同一个对象，助手项的 msgs 也是同一个数组', () => {
    const messages: ChatMessage[] = [
      userMsg('ir1-u1'),
      agentMsg('ir1-m1', { tools: 1 }),
      agentMsg('ir1-m2'),
      errMsg('ir1-e1'),
      compactionMsg('ir1-c'),
      userMsg('ir1-u2'),
      agentMsg('ir1-m3')
    ]
    const first = buildVisibleItems(messages, false)
    const second = buildVisibleItems(messages, false)
    expect(second).toHaveLength(first.length)
    second.forEach((item, i) => {
      expect(item, `第 ${i} 项`).toBe(first[i])
      expect(item.msgs, `第 ${i} 项的 msgs`).toBe(first[i].msgs)
    })
  })

  it('IR-2 末尾追加一条用户消息（新数组、原来的对象）：之前的项都复用，新那一项是新的', () => {
    const u1 = userMsg('ir2-u1')
    const m1 = agentMsg('ir2-m1', { tools: 1 })
    const m2 = agentMsg('ir2-m2')
    const before = buildVisibleItems([u1, m1, m2], false)
    const u2 = userMsg('ir2-u2')
    const after = buildVisibleItems([u1, m1, m2, u2], false)
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2].msg).toBe(u2)
    expect(before).not.toContain(after[2])
  })

  it('IR-3 组末条换成同 id 的新对象（块变了）：卡是新项、msgs 是新数组，末条与 msg 都是新对象，key 不变', () => {
    const u1 = userMsg('ir3-u1')
    const m1 = agentMsg('ir3-m1', { tools: 1 })
    const m2 = agentMsg('ir3-m2')
    const before = buildVisibleItems([u1, m1, m2], false)
    const m2b: AssistantMessage = { ...m2, blocks: [{ type: 'text', text: 'changed' }] }
    const after = buildVisibleItems([u1, m1, m2b], false)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].msgs).not.toBe(before[1].msgs)
    expect(after[1].msgs![0]).toBe(m1)
    expect(after[1].msgs![1]).toBe(m2b)
    expect(after[1].msg).toBe(m2b)
    expect(after[1].key).toBe('turn:1.0')
    expect(after[1].key).toBe(before[1].key)
  })

  it('IR-4 组首换成同 id 的新对象：新项，msgs[0] 是新对象', () => {
    const u1 = userMsg('ir4-u1')
    const m1 = agentMsg('ir4-m1', { tools: 1 })
    const m2 = agentMsg('ir4-m2')
    const before = buildVisibleItems([u1, m1, m2], false)
    const m1b: AssistantMessage = { ...m1, blocks: [...m1.blocks] }
    const after = buildVisibleItems([u1, m1b, m2], false)
    expect(after[1]).not.toBe(before[1])
    expect(after[1].msgs![0]).toBe(m1b)
    expect(after[1].msgs![1]).toBe(m2)
    expect(after[1].key).toBe(before[1].key)
  })

  it('IR-5 [u1, m1(工具)] → [u1, m1, m2(终答)]：卡是新项（msgs [m1, m2]、msg m2）；旧项没被改写（msgs 仍是 [m1]）', () => {
    const u1 = userMsg('ir5-u1')
    const m1 = agentMsg('ir5-m1', { tools: 1 })
    const before = buildVisibleItems([u1, m1], false)
    const oldCard = before[1]
    const m2 = agentMsg('ir5-m2')
    const after = buildVisibleItems([u1, m1, m2], false)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(oldCard)
    expect(after[1].msgs).toEqual([m1, m2])
    expect(after[1].msg).toBe(m2)
    expect(oldCard.msgs).toEqual([m1])
    expect(oldCard.msgs![0]).toBe(m1)
    expect(oldCard.msg).toBe(m1)
  })

  it('IR-6 [u1, m1(工具), m2] → [u1, m1]（末条撤回）：卡是新项，msgs 只剩 [m1]', () => {
    const u1 = userMsg('ir6-u1')
    const m1 = agentMsg('ir6-m1', { tools: 1 })
    const m2 = agentMsg('ir6-m2')
    const before = buildVisibleItems([u1, m1, m2], false)
    const after = buildVisibleItems([u1, m1], false)
    expect(after[1]).not.toBe(before[1])
    expect(after[1].msgs).toEqual([m1])
    expect(after[1].msg).toBe(m1)
  })

  it('IR-7 同一个组首、key 变了（前面多了一条用户消息 / 同一轮里前面的卡没了）：交出的是带新 key 的新项', () => {
    const u0 = userMsg('ir7-u0')
    const u1 = userMsg('ir7-u1')
    const m1 = agentMsg('ir7-m1')
    const shortList = buildVisibleItems([u1, m1], false)
    expect(shortList[1].key).toBe('turn:1.0')
    const longer = buildVisibleItems([u0, u1, m1], false)
    expect(longer[2].key).toBe('turn:2.0')
    expect(longer[2]).not.toBe(shortList[1])
    expect(longer[2].msg).toBe(m1)

    const v1 = userMsg('ir7-v1')
    const n1 = agentMsg('ir7-n1')
    const n2 = agentMsg('ir7-n2')
    const both = buildVisibleItems([v1, n1, n2], false)
    expect(both[2].key).toBe('turn:1.1')
    const onlySecond = buildVisibleItems([v1, n2], false)
    expect(onlySecond[1].key).toBe('turn:1.0')
    expect(onlySecond[1]).not.toBe(both[2])
    expect(onlySecond[1].msg).toBe(n2)
  })

  it('IR-8 流式标记不同就不复用：流式 → 落定 → 落定 → 流式，只有两次落定之间复用', () => {
    const u1 = userMsg('ir8-u1')
    const m1 = agentMsg('ir8-m1', { tools: 1 })
    const messages: ChatMessage[] = [u1, m1]
    const last = (items: Items): Items[number] => items.at(-1)!

    const A = last(buildVisibleItems(messages, true))
    expect(A.isStreamingPlaceholder).toBe(true)

    const B = last(buildVisibleItems(messages, false))
    expect(B.key).toBe(A.key)
    expect('isStreamingPlaceholder' in B).toBe(false)
    expect(B.msgs).toEqual([m1])
    expect(B).not.toBe(A)

    const C = last(buildVisibleItems(messages, false))
    expect(C).toBe(B)

    const D = last(buildVisibleItems(messages, true))
    expect(D.isStreamingPlaceholder).toBe(true)
    expect(D).not.toBe(B)
    expect(D.key).toBe(B.key)
  })

  it('IR-9 单条项（用户 / 错误 / 压缩摘要 / 乐观占位）：同一个对象 → 同一个项；同 id 的新对象 → 新项、msg 是新对象、key 不变', () => {
    const u1 = userMsg('ir9-u1')
    const e1 = errMsg('ir9-e1')
    const c1 = compactionMsg('ir9-c')
    const pending = pendingPromptMessage(SID, 'sending')
    const before = buildVisibleItems([u1, e1, c1], false, pending)
    const again = buildVisibleItems([u1, e1, c1], false, pending)
    again.forEach((item, i) => expect(item, `第 ${i} 项`).toBe(before[i]))

    const u1b: UserTextMessage = { ...u1 }
    const pendingB = pendingPromptMessage(SID, 'sending')
    const after = buildVisibleItems([u1b, e1, c1], false, pendingB)
    expect(after[0]).not.toBe(before[0])
    expect(after[0].msg).toBe(u1b)
    expect(after[0].key).toBe(before[0].key)
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(after[3]).not.toBe(before[3])
    expect(after[3].msg).toBe(pendingB)
    expect(after[3].key).toBe(PENDING_PROMPT_ID)
  })

  it('IR-10 两份列表来回交替：每次 key 都对，旧项不会串到另一份里', () => {
    const u0 = userMsg('ir10-u0')
    const u1 = userMsg('ir10-u1')
    const m1 = agentMsg('ir10-m1')
    const keysOf = (items: Items): string[] => items.map((i) => i.key)
    for (let round = 0; round < 3; round++) {
      const long = buildVisibleItems([u0, u1, m1], false)
      expect(keysOf(long), `第 ${round} 轮 · 长`).toEqual(['ir10-u0', 'ir10-u1', 'turn:2.0'])
      expect(long[2].msgs).toEqual([m1])
      const short = buildVisibleItems([u1, m1], false)
      expect(keysOf(short), `第 ${round} 轮 · 短`).toEqual(['ir10-u1', 'turn:1.0'])
      expect(short[1].msgs).toEqual([m1])
      expect(short[1]).not.toBe(long[2])
    }
  })

  it('IR-11 缓存热了之后，输出与一份深拷贝（全是新对象）建出来的逐项相等', () => {
    const messages: ChatMessage[] = [
      userMsg('ir11-u1'),
      agentMsg('ir11-m1', { tools: 2 }),
      agentMsg('ir11-m2'),
      compactionMsg('ir11-c'),
      errMsg('ir11-e1'),
      userMsg('ir11-u2'),
      agentMsg('ir11-m3', { tools: 1 })
    ]
    buildVisibleItems(messages, true)
    const warm = buildVisibleItems(messages, false)
    const cold = buildVisibleItems(structuredClone(messages), false)
    expect(warm).toEqual(cold)
    expect(warm[1]).not.toBe(cold[1])
  })
})
