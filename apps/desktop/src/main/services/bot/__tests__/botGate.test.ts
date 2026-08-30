/**
 * L0 确定性门（设计 §6.0）的单测。
 *
 * 这一层是纯函数、零 IO —— 宿主事实全部以参数交付，所以每条边界都可以直接摆出来。
 * 断言的重点不是「返回了什么」，而是**四段的顺序即语义**：任何一段命中都固定后续，
 * 以及决策记录这个观测面（「这个 bot 为什么没说话」）在每条路径上都能自圆其说。
 */
import { describe, it, expect } from 'vitest'
import type { ParsedBotFile } from '@shuvix/agent-runtime'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import {
  mentionsFromText,
  mentionsFromTokens,
  runL0Gate,
  type L0Input,
  type L0Result
} from '../botGate'
import type { BotDecisionKind } from '../botJournal'

/** 门只读 name / displayName / respond 三个字段，其余补齐到 ParsedBotFile 的形状即可 */
function stubBot(p: {
  name: string
  displayName?: string
  respond?: 'auto' | 'mention-only'
}): ParsedBotFile {
  return {
    name: p.name,
    displayName: p.displayName ?? p.name,
    description: `stub ${p.name}`,
    systemPrompt: '',
    tools: [],
    instructionFiles: [],
    projectAwareness: false,
    pipeline: 'bot-chat',
    pipelineInput: {},
    respond: p.respond ?? 'auto',
    notesEnabled: true,
    agents: {},
    greeting: '',
    suggestions: [],
    notes: null
  }
}

function knownOf(bots: ParsedBotFile[]): Map<string, ParsedBotFile> {
  return new Map(bots.map((b) => [b.name, b]))
}

function input(members: string[], bots: ParsedBotFile[], over: Partial<L0Input> = {}): L0Input {
  return {
    members,
    known: knownOf(bots),
    text: '',
    lastBotSender: null,
    clarifyConsumed: new Set<string>(),
    ...over
  }
}

/** 某个 bot 名下的记录种类（按产生顺序） */
function kindsOf(res: L0Result, botName: string): BotDecisionKind[] {
  return res.records.filter((r) => r.botName === botName).map((r) => r.kind)
}

function countOf(res: L0Result, botName: string, kind: BotDecisionKind): number {
  return kindsOf(res, botName).filter((k) => k === kind).length
}

function mentionToken(id: string): InlineToken {
  return { type: 'bot', id, displayText: `@${id}`, payload: `@${id}` }
}

describe('mentionsFromTokens —— 提及胶囊的消费口', () => {
  it('没有 tokens 时返回空数组（undefined 与空表都不该炸）', () => {
    expect(mentionsFromTokens(undefined)).toEqual([])
    expect(mentionsFromTokens({})).toEqual([])
  })

  it('判据是 type + 非空 id，不是位置：其余类型与空 id 一律不算提及', () => {
    const tokens: Record<string, InlineToken> = {
      t0: { type: 'paste', id: 'a', displayText: '[粘贴]', payload: '@a 在正文里' },
      t1: { type: 'cmd', id: 'review', displayText: '/review', payload: '模板' },
      t2: { type: 'at', id: 'a', displayText: '@a', payload: '@a' },
      t3: { type: 'bot', id: '', displayText: '@', payload: '@' },
      t4: mentionToken('scout')
    }
    expect(mentionsFromTokens(tokens)).toEqual(['scout'])
  })

  it('不去重、按 Object.values 序返回（F-1：同一 bot 的两个胶囊会产出两条）', () => {
    // 钉住当前形状：去重发生在这里之外还是根本没发生，是消费口的语义边界
    const tokens: Record<string, InlineToken> = { t0: mentionToken('a'), t1: mentionToken('a') }
    expect(mentionsFromTokens(tokens)).toEqual(['a', 'a'])
  })
})

describe('mentionsFromText —— 裸文本降级匹配', () => {
  const bob = stubBot({ name: 'bob', displayName: 'Bobby' })

  it('按成员名命中', () => {
    expect(mentionsFromText('@a 你好', ['a'], knownOf([stubBot({ name: 'a' })]))).toEqual(['a'])
  })

  it('按 displayName 命中；displayName === name 时不重复计入', () => {
    expect(mentionsFromText('@Bobby 在吗', ['bob'], knownOf([bob]))).toEqual(['bob'])
    const plain = stubBot({ name: 'a' }) // displayName 与 name 相同
    expect(mentionsFromText('@a', ['a'], knownOf([plain]))).toEqual(['a'])
  })

  it('长名优先（成员名）：@研究员 不该顺带唤醒「研究」', () => {
    const bots = [stubBot({ name: '研究' }), stubBot({ name: '研究员' })]
    expect(mentionsFromText('@研究员 帮我查一下', ['研究', '研究员'], knownOf(bots))).toEqual([
      '研究员'
    ])
    // 反向：真的 @研究 时命中的只有短名那个
    expect(mentionsFromText('@研究 帮我查一下', ['研究', '研究员'], knownOf(bots))).toEqual([
      '研究'
    ])
  })

  it('长名优先（跨字段）：别名比另一个成员的名字长时同样成立', () => {
    const bots = [stubBot({ name: 'al' }), stubBot({ name: 'b', displayName: 'alpha' })]
    expect(mentionsFromText('@alpha 上', ['al', 'b'], knownOf(bots))).toEqual(['b'])
  })

  it('@ 前必须是行首或空白：邮箱与词中 @ 不是提及', () => {
    const known = knownOf([bob])
    for (const text of ['mail@bob.com', 'x@bob', '(@bob']) {
      expect(mentionsFromText(text, ['bob'], known), text).toEqual([])
    }
  })

  it('换行后的 @ 命中（\\s 含换行）', () => {
    expect(mentionsFromText('第一行\n@bob 第二行', ['bob'], knownOf([bob]))).toEqual(['bob'])
  })

  it('大小写不敏感（双向）', () => {
    expect(mentionsFromText('@BOB', ['bob'], knownOf([bob]))).toEqual(['bob'])
    const upper = stubBot({ name: 'Bob' })
    expect(mentionsFromText('@bob', ['Bob'], knownOf([upper]))).toEqual(['Bob'])
  })

  it('输出按成员序而非匹配序', () => {
    const bots = [stubBot({ name: 'a' }), stubBot({ name: 'b' })]
    expect(mentionsFromText('@b 先 @a 后', ['a', 'b'], knownOf(bots))).toEqual(['a', 'b'])
  })

  it('无尾部词边界：@bobby 命中 bob（F-2：降级路径刻意的宽松）', () => {
    const plain = stubBot({ name: 'bob' }) // displayName 与 name 相同，不存在更长的别名
    expect(mentionsFromText('@bobby', ['bob'], knownOf([plain]))).toEqual(['bob'])
  })

  it('known 里没有的成员仍可按名匹配（别名表只少一条 displayName）', () => {
    // 剔除缺失成员是 present() 的活，不是匹配器的
    expect(mentionsFromText('@ghost 在吗', ['ghost'], new Map())).toEqual(['ghost'])
  })

  it('同一别名多次出现只记一次', () => {
    expect(mentionsFromText('@bob @bob @bob', ['bob'], knownOf([bob]))).toEqual(['bob'])
  })

  it('text 首字符即 @（before === "" 分支）', () => {
    expect(mentionsFromText('@bob', ['bob'], knownOf([bob]))).toEqual(['bob'])
  })
})

describe('runL0Gate —— 段序语义', () => {
  const a = stubBot({ name: 'a' })
  const b = stubBot({ name: 'b' })

  it('token 优先于裸文本：有可用胶囊就不看正文', () => {
    const res = runL0Gate(
      input(['a', 'b'], [a, b], { text: '@b 你来', inlineTokens: { t0: mentionToken('a') } })
    )
    expect(res.cohort).toEqual(['a'])
    expect(res.records.find((r) => r.kind === 'l0_directed')?.detail).toEqual({ via: 'token' })
  })

  it('token 全都不是成员时降级到文本', () => {
    const res = runL0Gate(
      input(['a', 'b'], [a, b], { text: '@b 你来', inlineTokens: { t0: mentionToken('ghost') } })
    )
    expect(res.cohort).toEqual(['b'])
    expect(res.records.find((r) => r.kind === 'l0_directed')?.detail).toEqual({ via: 'text' })
  })

  it('提及命中 → mention-only 不再过滤（段 1 固定后续）', () => {
    const quiet = stubBot({ name: 'quiet', respond: 'mention-only' })
    const res = runL0Gate(input(['quiet'], [quiet], { text: '@quiet 在吗' }))
    expect(res.cohort).toEqual(['quiet'])
    expect(res.directed).toBe(true)
    expect(kindsOf(res, 'quiet')).not.toContain('l0_mention_only_skipped')
  })

  it('提及命中 → clarify 不被消费（段 1 固定后续）', () => {
    const res = runL0Gate(
      input(['a', 'b'], [a, b], {
        text: '@a 好的',
        lastBotSender: { botName: 'b', displayName: 'b', decision: 'clarify', entryId: 'e1' }
      })
    )
    expect(res.cohort).toEqual(['a'])
    expect(res.consumedClarifyEntryId).toBeUndefined()
  })

  it('提及路径的记录形状：每成员一条 l0_directed + 一条 cohort_formed', () => {
    const res = runL0Gate(input(['a', 'b'], [a, b], { text: '@a 和 @b 都来' }))
    expect(res.cohort).toEqual(['a', 'b'])
    expect(res.directed).toBe(true)
    expect(kindsOf(res, 'a')).toEqual(['l0_directed', 'cohort_formed'])
    expect(res.records.find((r) => r.kind === 'cohort_formed')?.detail).toEqual({
      members: ['a', 'b'],
      directed: true,
      size: 2
    })
  })

  it('cohort 非空时未参与者零记录（G-1：观测面缺口，钉住现状）', () => {
    const res = runL0Gate(input(['a', 'b'], [a, b], { text: '@a 来' }))
    expect(res.cohort).toEqual(['a'])
    expect(kindsOf(res, 'b')).toEqual([])
  })

  it('扫的是标记态原文：paste 胶囊的 payload 不参与匹配', () => {
    const tokens: Record<string, InlineToken> = {
      p1: {
        type: 'paste',
        id: 'p1',
        displayText: '[粘贴]',
        payload: '这段里写了 @b 但那是别人的正文'
      }
    }
    const res = runL0Gate(
      input(['a', 'b'], [a, b], { text: '{{shuvixInlineToken:p1}}', inlineTokens: tokens })
    )
    expect(res.directed).toBe(false)
    expect(res.records.some((r) => r.kind === 'l0_directed')).toBe(false)
    expect(res.cohort).toEqual(['a', 'b'])
  })
})

describe('runL0Gate —— clarify 回连', () => {
  const a = stubBot({ name: 'a' })
  const b = stubBot({ name: 'b' })
  const clarify = (botName: string, entryId = 'e1'): L0Input['lastBotSender'] => ({
    botName,
    displayName: botName,
    decision: 'clarify',
    entryId
  })

  it('三个前置条件齐备 → 硬路由给它一个', () => {
    const res = runL0Gate(input(['a', 'b'], [a, b], { text: '是的', lastBotSender: clarify('b') }))
    expect(res.cohort).toEqual(['b'])
    expect(res.directed).toBe(true)
    expect(res.consumedClarifyEntryId).toBe('e1')
    expect(kindsOf(res, 'b')).toContain('l0_clarify_relink')
  })

  it.each([['reply'], ['task'], [undefined]])(
    'decision 是 %s（不是 clarify）→ 不回连，落到段 3',
    (decision) => {
      const res = runL0Gate(
        input(['a', 'b'], [a, b], {
          text: '是的',
          lastBotSender: { botName: 'b', displayName: 'b', decision, entryId: 'e1' }
        })
      )
      expect(res.cohort).toEqual(['a', 'b'])
      expect(res.directed).toBe(false)
      expect(res.consumedClarifyEntryId).toBeUndefined()
    }
  )

  it('提问的 bot 已不在名单 → 不回连', () => {
    const res = runL0Gate(input(['a'], [a, b], { text: '是的', lastBotSender: clarify('b') }))
    expect(res.cohort).toEqual(['a'])
    expect(res.directed).toBe(false)
    expect(res.consumedClarifyEntryId).toBeUndefined()
  })

  it('entryId 已被消费 → 不回连（一次性），也不再回传', () => {
    const res = runL0Gate(
      input(['a', 'b'], [a, b], {
        text: '是的',
        lastBotSender: clarify('b'),
        clarifyConsumed: new Set(['e1'])
      })
    )
    expect(res.cohort).toEqual(['a', 'b'])
    expect(res.consumedClarifyEntryId).toBeUndefined()
  })

  it('lastBotSender 为 null → 落段 3', () => {
    const res = runL0Gate(input(['a', 'b'], [a, b], { text: '是的' }))
    expect(res.cohort).toEqual(['a', 'b'])
    expect(res.directed).toBe(false)
  })

  it('回连绕过 mention-only', () => {
    const quiet = stubBot({ name: 'quiet', respond: 'mention-only' })
    const res = runL0Gate(
      input(['a', 'quiet'], [a, quiet], { text: '是的', lastBotSender: clarify('quiet') })
    )
    expect(res.cohort).toEqual(['quiet'])
    expect(res.consumedClarifyEntryId).toBe('e1')
  })

  it('提问的 bot 在 known 里缺失 → 落段 3，且 l0_member_missing 只记一次', () => {
    // 缺失判定前移到段 2 的谓词里；否则段 2 的 present([b]) 记一次、回落到段 3 的
    // present(members) 又记一次 —— 决策记录按 bot 分目录，重复归因会读出两次缺失
    const res = runL0Gate(input(['b', 'a'], [a], { text: '是的', lastBotSender: clarify('b') }))
    expect(res.cohort).toEqual(['a'])
    expect(res.directed).toBe(false)
    expect(countOf(res, 'b', 'l0_member_missing')).toBe(1)
  })
})

describe('runL0Gate —— mention-only / cohort / 全体沉默', () => {
  const a = stubBot({ name: 'a' })
  const b = stubBot({ name: 'b' })
  const quiet = stubBot({ name: 'quiet', respond: 'mention-only' })

  it('混合名单：auto 成 cohort、mention-only 各记一条跳过', () => {
    const res = runL0Gate(input(['a', 'quiet', 'b'], [a, quiet, b], { text: '大家好' }))
    expect(res.cohort).toEqual(['a', 'b'])
    expect(kindsOf(res, 'quiet')).toEqual(['l0_mention_only_skipped'])
  })

  it('全员 mention-only → cohort 空，且不再补 l0_silent（已解释过的不重复记）', () => {
    const q2 = stubBot({ name: 'q2', respond: 'mention-only' })
    const res = runL0Gate(input(['quiet', 'q2'], [quiet, q2], { text: '大家好' }))
    expect(res.cohort).toEqual([])
    expect(res.records.map((r) => r.kind)).toEqual([
      'l0_mention_only_skipped',
      'l0_mention_only_skipped'
    ])
  })

  it('缺失成员被剔除，其余照常组队', () => {
    const res = runL0Gate(input(['ghost', 'a'], [a], { text: '大家好' }))
    expect(res.cohort).toEqual(['a'])
    expect(kindsOf(res, 'ghost')).toEqual(['l0_member_missing'])
  })

  it('提及了一个已删除的成员 → 不当作定向，继续正常组队', () => {
    // 「命中」指解析出了活着的成员，不是「文本里出现了 @」—— 否则打一个已删除的名字
    // 就成了会话的静音开关（它会吞掉本该发生的 clarify 回连与正常组队）
    const res = runL0Gate(input(['ghost', 'a', 'b'], [a, b], { text: '@ghost 在吗' }))
    expect(res.cohort).toEqual(['a', 'b'])
    expect(res.directed).toBe(false)
    expect(kindsOf(res, 'ghost')).toEqual(['l0_member_missing'])
  })

  it('L0 层不产生 l0_silent：每一次沉默都有具体原因', () => {
    // 在册且非 mention-only 的成员必然进 cohort ——「无从解释的沉默」在这一层不存在。
    // 设计 §7 的「全体沉默」是成员们自己判 ignore，那归仲裁（M6′）
    const res = runL0Gate(input(['ghost', 'quiet'], [quiet], { text: '大家好' }))
    expect(res.cohort).toEqual([])
    expect(res.records.some((r) => r.kind === 'l0_silent')).toBe(false)
    expect(kindsOf(res, 'ghost')).toEqual(['l0_member_missing'])
    expect(kindsOf(res, 'quiet')).toEqual(['l0_mention_only_skipped'])
  })

  it('cohort 顺序跟 members，不跟 known 的插入序', () => {
    const known = new Map([
      ['b', b],
      ['a', a]
    ])
    const res = runL0Gate({
      members: ['a', 'b'],
      known,
      text: '大家好',
      lastBotSender: null,
      clarifyConsumed: new Set()
    })
    expect(res.cohort).toEqual(['a', 'b'])
  })

  it('members 为空 → cohort 空、records 空', () => {
    const res = runL0Gate(input([], [], { text: '@a 在吗' }))
    expect(res.cohort).toEqual([])
    expect(res.records).toEqual([])
  })
})
