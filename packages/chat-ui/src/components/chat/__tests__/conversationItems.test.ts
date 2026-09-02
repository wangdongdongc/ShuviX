/**
 * `buildVisibleItems` —— 消息列表 → 对话流的项。
 *
 * 两段逻辑叠在一个函数里，这里分别钉：
 *
 *  - **分组**：连续的 assistant 消息收成一张卡（遇终答 / 用户消息 / 列表结束收口），
 *    每项的 key 取组**首**条消息 id 而代表消息 `msg` 取组**末**条 —— 这条不对称是
 *    「流式占位换成真实终答时不重挂载」的全部依据；
 *  - **群聊气泡的头部合并**：连续同一个 bot 的项只留第一个头（IM 惯例）。它是一遍
 *    **后处理**，判据是「上一**项**」而不是「上一条 assistant 消息」—— 这个差别正是
 *    M-6 / M-7 / M-8 三条在分的。
 *
 * 判定读的是身份键 `metadata.sender.name`（不是显示名）：bot 改名之后历史行仍带着当初
 * 的 displayName，用显示名判就会把两个不同的 bot 合成一坨。而循环只写 `true` 从不写
 * `false`，所以「不合并」的期望一律写 `toBeUndefined()`——写成 `toBe(false)` 会假绿。
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

const SID = 'sess-1'

const base = (id: string): { id: string; sessionId: string; model: string; createdAt: number } => ({
  id,
  sessionId: SID,
  model: '',
  createdAt: 0
})

/**
 * 一条 bot 消息 —— 形状对齐 `chatMessageProjection.rowToChatMessage` 的产物：
 * 单个 text 块的终答 + `metadata.sender`。
 */
function botMsg(
  id: string,
  senderName: string,
  opts: { displayName?: string; blocks?: AssistantBlock[] } = {}
): AssistantMessage {
  return {
    ...base(id),
    role: 'assistant',
    type: 'message',
    content: `${senderName} 说的话`,
    blocks: opts.blocks ?? [{ type: 'text', text: `${senderName} 说的话` }],
    metadata: {
      sender: { kind: 'bot', name: senderName, displayName: opts.displayName ?? senderName }
    }
  }
}

/** 有根会话的普通助手消息（没有 sender） */
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

/** 每项的 mergeHeader（不合并时是 undefined —— 循环只写 true） */
const merges = (items: ReturnType<typeof buildVisibleItems>): Array<boolean | undefined> =>
  items.map((i) => i.mergeHeader)

describe('buildVisibleItems —— 群聊气泡的头部合并', () => {
  it('M-1 连续两条同一 bot → 第二项合并、第一项 undefined（不是 false）', () => {
    const items = buildVisibleItems([botMsg('m1', 'a'), botMsg('m2', 'a')], false)
    expect(items).toHaveLength(2)
    expect(items[0].mergeHeader).toBeUndefined()
    expect(items[1].mergeHeader).toBe(true)
  })

  it('M-2 列表首项永不合并（循环从 i=1 起）', () => {
    expect(buildVisibleItems([botMsg('m1', 'a')], false)[0].mergeHeader).toBeUndefined()
  })

  it('M-3 A、B 交替 → 一处都不合并', () => {
    const items = buildVisibleItems(
      [botMsg('m1', 'a'), botMsg('m2', 'b'), botMsg('m3', 'a')],
      false
    )
    expect(merges(items)).toEqual([undefined, undefined, undefined])
  })

  it('M-4 A、A、B、B → 恰 items[1] 与 items[3] 合并（逐对相邻判定）', () => {
    // 判据是「上一项是不是同一个人」，不是「这一段里第一次出现的人只留一个头」——
    // 后者会让 A A B B 只剩一个头
    const items = buildVisibleItems(
      [botMsg('m1', 'a'), botMsg('m2', 'a'), botMsg('m3', 'b'), botMsg('m4', 'b')],
      false
    )
    expect(merges(items)).toEqual([undefined, true, undefined, true])
  })

  it('M-5 同一个 bot 连说 4 条 → 后 3 条全合并', () => {
    const items = buildVisibleItems(
      ['m1', 'm2', 'm3', 'm4'].map((id) => botMsg(id, 'a')),
      false
    )
    expect(merges(items)).toEqual([undefined, true, true, true])
  })

  it('M-6 A、用户消息、A → 用户消息之后那条不合并', () => {
    // 判据是「上一**项**」。若实现改成「上一条 assistant 消息」，被用户打断的两句话
    // 会粘成一坨，中间那句「用户说了什么」在视觉上就没了归属
    const items = buildVisibleItems([botMsg('m1', 'a'), userMsg('u1'), botMsg('m2', 'a')], false)
    expect(merges(items)).toEqual([undefined, undefined, undefined])
  })

  it('M-7 A、error_event、A → 第三项不合并（扇出触顶的 system 行正是这一种）', () => {
    // 「本轮已达上限」那条 system 行投影出来就是 error_event —— 真实可达的形状
    const items = buildVisibleItems([botMsg('m1', 'a'), errMsg('e1'), botMsg('m2', 'a')], false)
    expect(items.map((i) => i.msg.id)).toEqual(['m1', 'e1', 'm2'])
    expect(merges(items)).toEqual([undefined, undefined, undefined])
  })

  it('M-8 A、非 error 的 system_notify、A → 第三项**仍然合并**（那条根本不成项）', () => {
    // 与 M-7 只差一个 type 字段：非 error 的 system_notify 在段首就被 continue 掉，
    // 于是两条 A 在**项**这一层上仍然相邻。这是这段后处理最容易写错的地方 ——
    // 「跳过它」和「它把两条隔开」是两种截然不同的结果。
    // 类型上今天已经没有这种消息了（ChatMessage 只有 error_event 一种 system_notify），
    // 但那个 continue 分支还在，钉住它的行为
    const notice = {
      ...base('n1'),
      role: 'system_notify',
      type: 'notice',
      content: '一条提示',
      metadata: null
    } as unknown as ChatMessage
    const items = buildVisibleItems([botMsg('m1', 'a'), notice, botMsg('m2', 'a')], false)
    expect(items.map((i) => i.msg.id)).toEqual(['m1', 'm2'])
    expect(merges(items)).toEqual([undefined, true])
  })

  it('M-9 两条无 sender 的普通助手消息（有根会话）→ 全不合并', () => {
    // 合并是群聊气泡的规则；有根会话的助手卡本来就没有头像行可合
    const items = buildVisibleItems([agentMsg('m1'), agentMsg('m2')], false)
    expect(merges(items)).toEqual([undefined, undefined])
  })

  it('M-10 有 sender 与无 sender 相邻（两个方向）→ 都不合并', () => {
    // `prev &&` 的短路半边：上一项没有 sender 时不该拿 undefined 去比 undefined
    expect(merges(buildVisibleItems([agentMsg('m1'), botMsg('m2', 'a')], false))).toEqual([
      undefined,
      undefined
    ])
    expect(merges(buildVisibleItems([botMsg('m1', 'a'), agentMsg('m2')], false))).toEqual([
      undefined,
      undefined
    ])
  })

  it('M-11 两条 sender.name 为空串的消息 → 不合并（`prev &&` 的真值检查）', () => {
    // 少了真值检查，所有「身份不明」的消息（botName 缺失时投影出的就是空串）会被
    // 合并成一坨，看起来像同一个人在连说
    const items = buildVisibleItems([botMsg('m1', ''), botMsg('m2', '')], false)
    expect(merges(items)).toEqual([undefined, undefined])
  })

  it('M-12 判据是身份键 name，不是显示名', () => {
    // 同一个 bot 改过名：两条历史行的 displayName 不同但 name 相同 → 合并
    const renamed = buildVisibleItems(
      [botMsg('m1', 'a', { displayName: '旧名' }), botMsg('m2', 'a', { displayName: '新名' })],
      false
    )
    expect(merges(renamed)).toEqual([undefined, true])

    // 两个不同的 bot 恰好取了同一个显示名 → 不合并
    const sameLabel = buildVisibleItems(
      [botMsg('m1', 'a', { displayName: '助手' }), botMsg('m2', 'b', { displayName: '助手' })],
      false
    )
    expect(merges(sameLabel)).toEqual([undefined, undefined])
  })

  it('M-13 流式占位项自成一项、不合并、metadata 为 null，且不影响前两项', () => {
    const items = buildVisibleItems([botMsg('m1', 'a'), botMsg('m2', 'a')], true)
    expect(items).toHaveLength(3)
    expect(merges(items)).toEqual([undefined, true, undefined])
    expect(items[2].msg.id).toBe(STREAMING_PLACEHOLDER_ID)
    expect(items[2].msg.metadata).toBeNull()
    expect(items[2].isStreamingPlaceholder).toBe(true)
  })

  it('M-14 流式 + 空 messages → 只有占位项一项，不合并、不抛', () => {
    const items = buildVisibleItems([], true)
    expect(items).toHaveLength(1)
    expect(items[0].msg.id).toBe(STREAMING_PLACEHOLDER_ID)
    expect(items[0].mergeHeader).toBeUndefined()
    expect(items[0].msg.sessionId).toBe('')
  })

  it('M-15 合并判定读的是 item.msg（组**末**条），不是组首', () => {
    // 造一个多消息项：带 tool block 的助手消息不收口，与紧随的终答合成同一项。
    // 组首没有 sender、组末有 —— 于是「读组首」与「读组末」会得出相反的结论
    const withTool = agentMsg('m1', { tools: 1 })
    const items = buildVisibleItems([withTool, botMsg('m2', 'a'), botMsg('m3', 'a')], false)
    expect(items).toHaveLength(2)
    // 第一项是 {m1, m2} 这一组：key 取组首 m1，代表消息取组末 m2
    expect(items[0].key).toBe('m1')
    expect(items[0].msg.id).toBe('m2')
    // 读组末 → 与 m3 同为 a → 合并；读组首（无 sender）则会得出不合并
    expect(items[1].mergeHeader).toBe(true)
  })

  it('M-16 纯函数：连调两次结果一致，且不改写传入的 ChatMessage', () => {
    // mergeHeader 只写在新造的 item 上 —— 若哪天挂到消息对象上，store 里的消息会被
    // 一次渲染悄悄改脏，而 zustand 的浅比较看不出来
    const messages = [botMsg('m1', 'a'), botMsg('m2', 'a'), userMsg('u1'), botMsg('m3', 'a')]
    const snapshot = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
    const once = buildVisibleItems(messages, false)
    const twice = buildVisibleItems(messages, false)
    expect(twice).toEqual(once)
    expect(messages).toEqual(snapshot)
    for (const m of messages) expect(m).not.toHaveProperty('mergeHeader')
  })

  it('M-17 合并不改变任何项的 key（仍是组首消息 id）', () => {
    // key 是列表项身份：合并只是少画一个头，不该让 React 认为这是另一项
    const messages = [botMsg('m1', 'a'), botMsg('m2', 'a'), botMsg('m3', 'a')]
    const items = buildVisibleItems(messages, false)
    expect(items.map((i) => i.key)).toEqual(['m1', 'm2', 'm3'])
    expect(merges(items)).toEqual([undefined, true, true])
  })
})
