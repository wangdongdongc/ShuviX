/**
 * botService 消息半边（M3′）—— 无根会话的落盘与广播。
 *
 * **刻意不 mock sessionStorage**：这一层的全部风险都在「树上到底落了什么、按什么顺序」——
 * 双 append 的相邻性、写锁下的并发不交错、append 返回值取 id（而非回读叶子），
 * 换成假树就一条也测不到。真树跑在临时目录里（paths 被 mock），配合真投影做端到端断言。
 *
 * mock 面：electron（shell）/ paths / logger / sessionService（会话事实）/
 * agentRuntimeAdapters（广播出口 spy）。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

/**
 * 目录路径必须在 **import 之前**就定好：botService 是模块级单例，构造时就把
 * `getDefaultBotsDir()` 存进了 `userDir`。vi.hoisted 早于 import 执行，但那里没有
 * fs/os 可用 —— 所以只算路径，目录本身在 beforeEach 里重建（每例清空重来）。
 */
const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botsvc-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  getById: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: mocks.broadcast }
}))
vi.mock('../sessionService', () => ({ sessionService: { getById: mocks.getById } }))

import { BOT_SENDER_CUSTOM_TYPE, INLINE_TOKENS_CUSTOM_TYPE } from '@shuvix/agent-runtime'
import { botService } from '../botService'
import { messageService } from '../messageService'
import {
  clearSessionTreeCacheForTests,
  getSessionTree,
  sessionFilePath,
  withSessionTreeLock,
  appendModelChange
} from '../sessionStorage'

const SID = 'bot-sess'
const SCOUT = { botName: 'scout', displayName: 'Scout' }

/** 往假 HOME 的 bots 目录写一份最小可解析的 bot md */
function writeBot(name: string, opts: { greeting?: string; displayName?: string } = {}): void {
  mkdirSync(dirs.bots, { recursive: true })
  const lines = ['---', 'shuvix: bot v1', `name: ${name}`, `description: unit-test bot ${name}`]
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  if (opts.greeting) lines.push(`shuvix-bot-greeting: ${opts.greeting}`)
  lines.push('---', '', 'BOT BODY.')
  writeFileSync(join(dirs.bots, `${name}.md`), lines.join('\n'))
}

/** 会话事实：工作目录 + 成员名单 */
function seedSession(bots: string[] = ['scout']): void {
  mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bots } })
}

/** 当前分支上的 entry（会话文件不存在时为空数组） */
async function branch(sid = SID): Promise<
  Array<{
    id: string
    parentId: string | null
    type: string
    customType?: string
  }>
> {
  const tree = await getSessionTree(sid)
  if (!tree) return []
  return (await tree.getBranch()) as never
}

/** 广播出去的 ChatEvent（按 type 过滤） */
function broadcasts(type?: string): Array<Record<string, unknown>> {
  return mocks.broadcast.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => !type || e.type === type)
}

/** 广播里那条被 JSON 串起来的消息 */
function broadcastMessage(index = 0, type?: string): ChatMessage {
  return JSON.parse(broadcasts(type)[index].message as string)
}

function senderOf(msg: ChatMessage | undefined): unknown {
  return (msg?.metadata as { sender?: unknown } | null | undefined)?.sender
}

/** 拿住写锁并卡住，返回释放函数 —— 用来造「在飞」的确定性窗口 */
function holdLock(sid = SID): { release: () => void; done: Promise<void> } {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  return { release, done: withSessionTreeLock(sid, () => gate) }
}

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  mocks.broadcast.mockReset()
  mocks.getById.mockReset()
  seedSession()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('appendBotMessage —— 署名侧车与消息的双 append', () => {
  it('落两条 entry：侧车在前、assistant 在后、父子相连；返回 assistant 的 id', async () => {
    const id = await botService.appendBotMessage(SID, SCOUT, { content: '侦察完毕' })

    const b = await branch()
    expect(b).toHaveLength(2)
    expect(b[0]).toMatchObject({ type: 'custom', customType: BOT_SENDER_CUSTOM_TYPE })
    expect(b[1]).toMatchObject({ type: 'message', parentId: b[0].id })
    expect(id).toBe(b[1].id)
  })

  it('并发两条 bot 消息不交错：署名各自跟着自己的正文', async () => {
    // 两条之间若有 await 逃逸点，分支上就会出现 [senderA, senderB, msgA, msgB]
    await Promise.all([
      botService.appendBotMessage(SID, SCOUT, { content: 'A 说的' }),
      botService.appendBotMessage(
        SID,
        { botName: 'ranger', displayName: 'Ranger' },
        { content: 'B 说的' }
      )
    ])

    const b = await branch()
    expect(b.map((e) => e.type)).toEqual(['custom', 'message', 'custom', 'message'])

    const msgs = await messageService.listBySession(SID)
    expect(msgs).toHaveLength(2)
    for (const m of msgs) {
      const expected = m.content === 'A 说的' ? 'scout' : 'ranger'
      expect(senderOf(m)).toMatchObject({ name: expected })
    }
  })

  it('广播 assistant_message：顶层 messageId 与消息体 id 都是 assistant entry id', async () => {
    const id = await botService.appendBotMessage(SID, SCOUT, { content: 'hi' })

    const events = broadcasts('assistant_message')
    expect(events).toHaveLength(1)
    expect(events[0].messageId).toBe(id)
    expect(broadcastMessage(0, 'assistant_message').id).toBe(id)
  })

  it('广播的消息带 metadata.sender', async () => {
    await botService.appendBotMessage(SID, SCOUT, { content: 'hi' })
    expect(senderOf(broadcastMessage(0, 'assistant_message'))).toEqual({
      kind: 'bot',
      name: 'scout',
      displayName: 'Scout'
    })
  })

  it('流式所见 = 重开所见：广播的对象与 message.list 里同 id 的那条逐字段全等', async () => {
    await appendModelChange(SID, 'openai', 'gpt-x')
    const id = await botService.appendBotMessage(SID, SCOUT, { content: 'hi' })

    const streamed = broadcastMessage(0, 'assistant_message')
    const reopened = (await messageService.listBySession(SID)).find((m) => m.id === id)
    expect(reopened).toEqual(streamed)
  })

  it.each([
    ['空串', ''],
    ['全空格', '   '],
    ['只有换行与制表符', '\n\t']
  ])('content 为空白（%s）：拒绝落树、返回 null、不广播', async (_n, content) => {
    // 先落一条正常消息，好证明「树没变」而不是「树本来就空」
    await botService.appendBotMessage(SID, SCOUT, { content: '打底' })
    mocks.broadcast.mockClear()
    const before = (await branch()).length

    expect(await botService.appendBotMessage(SID, SCOUT, { content })).toBeNull()
    expect(await branch()).toHaveLength(before)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('空 content 被拒时不进出计数（enter 在 guard 之后，不留悬挂计数）', async () => {
    expect(botService.isActive(SID)).toBe(false)
    for (let i = 0; i < 3; i++) {
      await botService.appendBotMessage(SID, SCOUT, { content: '   ' })
      expect(botService.isActive(SID)).toBe(false)
    }
  })

  it('缺省 model/provider 落成空串，投影时回落到会话运行配置', async () => {
    await appendModelChange(SID, 'openai', 'gpt-x')
    await botService.appendBotMessage(SID, SCOUT, { content: 'hi' })

    expect(broadcastMessage(0, 'assistant_message')).toMatchObject({
      model: 'gpt-x',
      provider: 'openai'
    })
  })

  it('显式传入 model/provider 时以传入值为准', async () => {
    await appendModelChange(SID, 'openai', 'gpt-x')
    await botService.appendBotMessage(SID, SCOUT, {
      content: 'hi',
      model: 'claude-x',
      provider: 'anthropic'
    })

    expect(broadcastMessage(0, 'assistant_message')).toMatchObject({
      model: 'claude-x',
      provider: 'anthropic'
    })
  })

  it('切片顺序不受废弃分支干扰（树里存在回退遗留的旧分支时署名照样配对）', async () => {
    // projectSlice 按调用方给的 id 顺序逐条取；这条用例守住「顺序不是从 getEntries 的
    // 全表扫描里捡来的」—— 换成过滤 getEntries 的实现，废弃分支就会混进来
    const first = await botService.appendBotMessage(SID, SCOUT, { content: '旧分支' })
    const tree = (await getSessionTree(SID))!
    const target = (await tree.getEntry(first!))!.parentId
    await tree.moveTo(target ? ((await tree.getEntry(target))!.parentId ?? null) : null)
    mocks.broadcast.mockClear()

    await botService.appendBotMessage(
      SID,
      { botName: 'ranger', displayName: 'Ranger' },
      {
        content: '新分支'
      }
    )
    expect(senderOf(broadcastMessage(0, 'assistant_message'))).toMatchObject({ name: 'ranger' })
  })
})

describe('handleUserMessage —— 无根会话的用户消息落盘', () => {
  it('只落一条 user entry，广播 user_message，id 取自 append 的返回值', async () => {
    await botService.handleUserMessage({ sessionId: SID, text: '你好' })

    const b = await branch()
    expect(b).toHaveLength(1)
    expect(b[0].type).toBe('message')
    expect(broadcastMessage(0, 'user_message').id).toBe(b[0].id)
  })

  it('并发两条用户消息各拿到自己的 id（回读叶子的实现下二者会串）', async () => {
    await Promise.all([
      botService.handleUserMessage({ sessionId: SID, text: 'A' }),
      botService.handleUserMessage({ sessionId: SID, text: 'B' })
    ])

    const events = broadcasts('user_message').map((e) => JSON.parse(e.message as string))
    expect(new Set(events.map((m) => m.id)).size).toBe(2)

    const onTree = await messageService.listBySession(SID)
    for (const e of events) {
      expect(onTree.find((m) => m.id === e.id)?.content).toBe(e.content)
    }
  })

  it('带 inlineTokens：落两条（侧车在前 + user），广播里是标记态原文 + metadata.inlineTokens', async () => {
    const tokens = {
      t0: { type: 'cmd', id: 'review', displayText: '/review', payload: '展开后的完整模板' }
    }
    await botService.handleUserMessage({
      sessionId: SID,
      text: '{{shuvixInlineToken:t0}} 参数',
      inlineTokens: tokens
    })

    const b = await branch()
    expect(b.map((e) => e.type)).toEqual(['custom', 'message'])
    expect(b[0].customType).toBe(INLINE_TOKENS_CUSTOM_TYPE)

    const msg = broadcastMessage(0, 'user_message')
    expect(msg.content).toContain('{{shuvixInlineToken:t0}}')
    expect(msg.metadata).toMatchObject({ inlineTokens: tokens })
  })

  it('不带 inlineTokens：只落一条，不产生空侧车', async () => {
    await botService.handleUserMessage({ sessionId: SID, text: '你好' })
    const b = await branch()
    expect(b).toHaveLength(1)
    expect(b[0].parentId).toBeNull()
  })

  it('images 进 metadata.images', async () => {
    await botService.handleUserMessage({
      sessionId: SID,
      text: '看图',
      images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }]
    })

    const msg = broadcastMessage(0, 'user_message')
    expect((msg.metadata as { images?: unknown[] }).images).toEqual([
      { data: 'AAA', mimeType: 'image/png' }
    ])
  })

  it('M3′ 边界：不派发任何管线 —— 广播事件类型恰为 [user_message]', async () => {
    await botService.handleUserMessage({ sessionId: SID, text: '你好' })
    expect(broadcasts().map((e) => e.type)).toEqual(['user_message'])
  })

  it('进出计数在成功与失败路径都归零', async () => {
    await botService.handleUserMessage({ sessionId: SID, text: '你好' })
    expect(botService.isActive(SID)).toBe(false)

    mocks.getById.mockImplementation(() => {
      throw new Error('db down')
    })
    await expect(botService.handleUserMessage({ sessionId: SID, text: 'x' })).rejects.toThrow(
      'db down'
    )
    expect(botService.isActive(SID)).toBe(false)
  })

  it('在飞期间 isActive 为 true（树钉住谓词的数据源）', async () => {
    const lock = holdLock()
    const inflight = botService.handleUserMessage({ sessionId: SID, text: '你好' })
    expect(botService.isActive(SID)).toBe(true)

    lock.release()
    await lock.done
    await inflight
    expect(botService.isActive(SID)).toBe(false)
  })

  it('计数可重入：并发两次期间恒为 true，只结束一个仍为 true', async () => {
    // 写锁是 FIFO 队列，中间再插一个可控的持锁者，就能确定性地「只放行第一条」
    const first = holdLock()
    const a = botService.handleUserMessage({ sessionId: SID, text: 'A' })
    const middle = holdLock()
    const b = botService.handleUserMessage({ sessionId: SID, text: 'B' })
    expect(botService.isActive(SID)).toBe(true)

    first.release()
    await first.done
    await a
    // A 已收尾，B 还卡在 middle 后面 —— 布尔标志位的实现会在这里翻成 false
    expect(botService.isActive(SID)).toBe(true)

    middle.release()
    await middle.done
    await b
    expect(botService.isActive(SID)).toBe(false)
  })
})

describe('seedGreetings —— 成员开场白播种', () => {
  it('按 settings.bots 的顺序逐条落（不是目录扫描的字典序）', async () => {
    for (const n of ['a', 'b', 'c']) writeBot(n, { greeting: `${n} 的开场白` })
    seedSession(['c', 'a', 'b'])

    await botService.seedGreetings(SID)
    const msgs = await messageService.listBySession(SID)
    expect(msgs.map((m) => (senderOf(m) as { name: string }).name)).toEqual(['c', 'a', 'b'])
  })

  it('没写 greeting 的成员被跳过，不留空侧车', async () => {
    writeBot('a')
    writeBot('b', { greeting: 'b 的开场白' })
    seedSession(['a', 'b'])

    await botService.seedGreetings(SID)
    expect(await messageService.listBySession(SID)).toHaveLength(1)
    // 树上只有 b 的 [侧车, 消息] 两条，没有 a 留下的无主 custom
    expect(await branch()).toHaveLength(2)
  })

  it('名单里的未知 bot 名被静默跳过，其余成员照常落', async () => {
    writeBot('b', { greeting: 'b 的开场白' })
    seedSession(['ghost', 'b'])

    await expect(botService.seedGreetings(SID)).resolves.toBeUndefined()
    const msgs = await messageService.listBySession(SID)
    expect(msgs).toHaveLength(1)
    expect(senderOf(msgs[0])).toMatchObject({ name: 'b' })
  })

  it.each([
    ['空名单', [] as string[]],
    ['无 bots 键', undefined]
  ])('%s → 完全 no-op，不创建会话文件', async (_n, bots) => {
    mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bots } })
    await botService.seedGreetings(SID)
    expect(existsSync(sessionFilePath(SID))).toBe(false)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('listAll() 只扫一次目录（别在循环里反复扫）', async () => {
    for (const n of ['a', 'b', 'c']) writeBot(n, { greeting: `${n} 的开场白` })
    seedSession(['a', 'b', 'c'])
    const spy = vi.spyOn(botService, 'listAll')

    await botService.seedGreetings(SID)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(await messageService.listBySession(SID)).toHaveLength(3)
  })

  it('连续多条开场白各带自己的署名（相邻性在批量下也成立）', async () => {
    for (const n of ['a', 'b'])
      writeBot(n, { greeting: `${n} 的开场白`, displayName: n.toUpperCase() })
    seedSession(['a', 'b'])

    await botService.seedGreetings(SID)
    const msgs = await messageService.listBySession(SID)
    expect(
      msgs.map((m) => [m.content, (senderOf(m) as { displayName: string }).displayName])
    ).toEqual([
      ['a 的开场白', 'A'],
      ['b 的开场白', 'B']
    ])
  })
})

describe('abortSession —— 动树之前的会师点', () => {
  it('在飞的 handleUserMessage 未结束前不落定', async () => {
    const lock = holdLock()
    const inflight = botService.handleUserMessage({ sessionId: SID, text: '你好' })

    let aborted = false
    const aborting = botService.abortSession(SID).then(() => {
      aborted = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(aborted).toBe(false)

    lock.release()
    await lock.done
    await inflight
    await aborting
    expect(aborted).toBe(true)
  })

  it('落定之后 isActive 为 false，树可安全删除', async () => {
    await botService.handleUserMessage({ sessionId: SID, text: '你好' })
    await botService.abortSession(SID)
    expect(botService.isActive(SID)).toBe(false)
    expect(() => messageService.clear(SID)).not.toThrow()
    expect(existsSync(sessionFilePath(SID))).toBe(false)
  })

  it('对没写过任何消息的会话是安全 no-op（不抛、分支为空）', async () => {
    await expect(botService.abortSession('never-talked')).resolves.toBeUndefined()
    expect(await branch('never-talked')).toHaveLength(0)
    // 无副作用：没有在飞写入时 drain 直接返回，不会 ensure 出一棵树 ——
    // 否则「新建聊天会话按一下停止」就在磁盘上留下一个空 jsonl
    expect(existsSync(sessionFilePath('never-talked'))).toBe(false)
  })
})
