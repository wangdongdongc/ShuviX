/**
 * 用户原话怎么挑（services/userWords.ts）：父会话的转写项 → 要附给子会话的那几条。
 *
 *   UWS-1 收：人打的消息（点提议发出的标明）、人对卡片的回答；不收：有来源记录的（父会话 / 别的会话 / 触发器 / 认不出的）、
 *         旧会话里系统写的、空白的、父会话被代答的回答、agent 的正文
 *   UWS-2 第一次：首条 + 最近 10 条，省掉的数在中间；没超就全给；scope = start
 *   UWS-3 之后：只给游标之后的，最近 10 条，省掉的数在前面；scope = since-last；游标之后没有新的 → undefined
 *   UWS-4 游标前移到这次覆盖到的最后一条（含被省掉的）；回答取提问那条的时间戳
 *   UWS-5 截长：按码点、首尾各半、中间写明截了多少；没超原样
 *   UWS-6 readUserWordsFor：按 tokens:'copy' 读父会话、游标取子会话设置（没写过 = undefined 或库里的 null）；
 *         markUserWordsSent 写子会话设置
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../transcriptSource'

const mocks = vi.hoisted(() => ({
  readSessionTranscript: vi.fn(),
  pickSettings: vi.fn(),
  updateSettings: vi.fn()
}))
vi.mock('../transcriptSource', () => ({ readSessionTranscript: mocks.readSessionTranscript }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pickSettings: mocks.pickSettings, updateSettings: mocks.updateSettings }
}))

const {
  USER_WORDS_LIMITS,
  clipWord,
  markUserWordsSent,
  readUserWordsFor,
  selectUserWords,
  userWordsOf
} = await import('../userWords')

const user = (ts: number, text: string, extra: Record<string, unknown> = {}): TranscriptItem =>
  ({ kind: 'user', ts, text, ...extra }) as TranscriptItem

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
})

describe('userWordsOf', () => {
  it('UWS-1 收人写的、不收机器写的', () => {
    const items: TranscriptItem[] = [
      user(1, '需求 A'),
      user(2, '父会话代发', { source: { kind: 'parent-session', sessionId: 'X' } }),
      user(3, '别的会话', { source: { kind: 'session', sessionId: 'Y' } }),
      user(4, '触发器', { source: { kind: 'trigger', trigger: 'timer.fired', bot: 'b' } }),
      user(5, '旧通知', { systemWritten: true }),
      user(6, '   '),
      user(7, '点了提议', { suggested: true }),
      { kind: 'assistant', ts: 8, text: 'agent 说的' },
      { kind: 'ask', ts: 9, question: '选哪个？', answer: 'User selected: B' },
      {
        kind: 'ask',
        ts: 10,
        question: '代答的',
        answer: 'x',
        answeredBy: { kind: 'parent-session', sessionId: 'Z' }
      },
      { kind: 'ask', ts: 11, question: '空回答', answer: ' ' }
    ]
    expect(userWordsOf(items)).toEqual([
      { kind: 'message', ts: 1, text: '需求 A' },
      { kind: 'message', ts: 7, text: '点了提议', suggested: true },
      { kind: 'answer', ts: 9, text: 'User selected: B', question: '选哪个？' }
    ])
  })
})

describe('selectUserWords', () => {
  const words = (n: number): ReturnType<typeof userWordsOf> =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'message' as const,
      ts: i + 1,
      text: `m${i + 1}`
    }))

  it('UWS-2 第一次：首条 + 最近 10 条', () => {
    const sel = selectUserWords(words(15), 'P')!
    expect(sel.scope).toBe('start')
    expect(sel.sessionId).toBe('P')
    expect(sel.words.map((w) => w.text)).toEqual([
      'm1',
      ...Array.from({ length: 10 }, (_, i) => `m${i + 6}`)
    ])
    expect(sel.omitted).toBe(4)
    expect(sel.through).toBe(15)
    const few = selectUserWords(words(USER_WORDS_LIMITS.first + USER_WORDS_LIMITS.recent), 'P')!
    expect(few.words).toHaveLength(11)
    expect(few.omitted).toBe(0)
    expect(selectUserWords([], 'P')).toBeUndefined()
  })

  it('UWS-3 之后：只给游标之后的最近 10 条', () => {
    const sel = selectUserWords(words(30), 'P', 5)!
    expect(sel.scope).toBe('since-last')
    expect(sel.words.map((w) => w.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 21}`))
    expect(sel.omitted).toBe(15)
    expect(selectUserWords(words(3), 'P', 3)).toBeUndefined()
    expect(selectUserWords(words(3), 'P', 2)!.words.map((w) => w.text)).toEqual(['m3'])
  })

  it('UWS-4 游标 = 覆盖到的最后一条（含省掉的）；回答按提问的时间戳', () => {
    const mixed = [
      { kind: 'message' as const, ts: 100, text: 'a' },
      { kind: 'answer' as const, ts: 90, text: 'User selected: X', question: 'q' }
    ]
    expect(selectUserWords(mixed, 'P')!.through).toBe(100)
    expect(selectUserWords(mixed, 'P', 95)!.words).toEqual([
      { kind: 'message', ts: 100, text: 'a' }
    ])
  })
})

describe('clipWord', () => {
  it('UWS-5 按码点首尾各半，中间写明截了多少', () => {
    expect(clipWord('short', 10)).toBe('short')
    const long = `${'a'.repeat(6)}😀😀${'b'.repeat(6)}`
    const clipped = clipWord(long, 6)
    expect(clipped).toBe('aaa\n…[8 characters left out by ShuviX]…\nbbb')
    expect(clipWord('😀😀😀😀', 2)).toBe('😀\n…[2 characters left out by ShuviX]…\n😀')
  })
})

describe('readUserWordsFor / markUserWordsSent', () => {
  it('UWS-6 按 copy 读父会话、游标取子会话、写回子会话', async () => {
    mocks.readSessionTranscript.mockResolvedValue([user(1, 'a'), user(2, 'b')])
    mocks.pickSettings.mockReturnValue({ userWordsThrough: 1 })
    const sel = await readUserWordsFor('P', 'C')
    expect(mocks.readSessionTranscript).toHaveBeenCalledWith('P', { tokens: 'copy' })
    expect(mocks.pickSettings).toHaveBeenCalledWith('C', ['userWordsThrough'])
    expect(sel).toMatchObject({ scope: 'since-last', through: 2, words: [{ text: 'b' }] })

    mocks.pickSettings.mockReturnValue(undefined)
    expect((await readUserWordsFor('P', 'C'))?.scope).toBe('start')
    // 没写过的键从库里读出来是 null（e2e UW-E1 抓到的）：照样是第一次
    mocks.pickSettings.mockReturnValue({ userWordsThrough: null })
    expect(await readUserWordsFor('P', 'C')).toMatchObject({ scope: 'start', words: [{}, {}] })

    markUserWordsSent('C', 42)
    expect(mocks.updateSettings).toHaveBeenCalledWith('C', { userWordsThrough: 42 })
  })
})
