/**
 * `systemNoticeContract` —— 按正文形状认系统通知的那把尺。
 *
 * 它是侧车之外的兜底判据（steer 路径插不进侧车），所以边界要钉死在
 * 「整段正文只由通知块组成」：多一句人写的话就不算 —— 宁可漏认一条通知（画成气泡），
 * 也不能把用户真正说的话认成系统通知。
 */
import { describe, it, expect } from 'vitest'
import {
  EMPTY_REPLY_NOTICE_KIND,
  GOAL_NOTICE_TAGS,
  goalNoticeKindOf,
  isEmptyReplyNoticeText,
  isSystemNoticeText,
  systemNoticeBlockRe,
  SYSTEM_NOTICE_TAGS
} from './systemNoticeContract'

const bgTask = [
  '<background-task pid="17162" status="killed by SIGTERM" duration="23s">',
  'for i in $(seq 1 30); do echo "tick $i"; sleep 2; done',
  'Last output:',
  'tick 12 17:36:12',
  'Full log: /tmp/x.log',
  '</background-task>'
].join('\n')

const subSession = [
  '<sub-session id="c9f1" title="重构登录页" status="settled">',
  'The turn you started in the background has finished.',
  '</sub-session>'
].join('\n')

describe('isSystemNoticeText', () => {
  it('T-1 一个完整的后台任务通知块 → true（正文里的引号 / $() / 尖括号以外的字符不影响）', () => {
    expect(isSystemNoticeText(bgTask)).toBe(true)
  })

  it('T-2 两个通知块用空行拼接（合并窗口内一起完成）→ true；前后空白也允许', () => {
    expect(isSystemNoticeText(`${bgTask}\n\n${subSession}`)).toBe(true)
    expect(isSystemNoticeText(`\n  ${subSession}\n`)).toBe(true)
  })

  it('T-3 通知块之外多了人写的话 → false（宁可漏认，不把用户的话认成系统通知）', () => {
    expect(isSystemNoticeText(`看看这个：\n${bgTask}`)).toBe(false)
    expect(isSystemNoticeText(`${bgTask}\n然后呢`)).toBe(false)
  })

  it('T-4 普通文本 / 空串 / 纯空白 / 别的标签 → false', () => {
    expect(isSystemNoticeText('帮我重构登录页')).toBe(false)
    expect(isSystemNoticeText('')).toBe(false)
    expect(isSystemNoticeText('   \n ')).toBe(false)
    expect(isSystemNoticeText('<note>hi</note>')).toBe(false)
  })

  it('T-5 半截标签（有开无合）→ false', () => {
    expect(isSystemNoticeText('<background-task pid="1" status="x" duration="1s">\nls')).toBe(false)
  })
})

describe('systemNoticeBlockRe', () => {
  it('R-1 每次调用给一个新实例：上一次 exec 留下的 lastIndex 不会串到下一次', () => {
    const a = systemNoticeBlockRe()
    expect(a.exec(bgTask)).not.toBeNull()
    expect(a.lastIndex).toBeGreaterThan(0)
    const b = systemNoticeBlockRe()
    expect(b).not.toBe(a)
    expect(b.lastIndex).toBe(0)
    expect(b.flags).toContain('g')
  })

  it('R-2 捕获组：1 = 标签名，2 = 属性串，3 = 正文；标签表里的每个名字都能匹配', () => {
    const m = systemNoticeBlockRe().exec(subSession)!
    expect(m[1]).toBe('sub-session')
    expect(m[2]).toContain('title="重构登录页"')
    expect(m[3]).toContain('has finished')
    for (const tag of SYSTEM_NOTICE_TAGS) {
      expect(systemNoticeBlockRe().test(`<${tag} a="1">\nbody\n</${tag}>`)).toBe(true)
    }
  })
})

describe('empty-reply notice (emptyReply.ts 的空回复追问)', () => {
  const emptyReply = '<empty-reply>\nYour previous reply had no visible text.\n</empty-reply>'

  // 追问正文本身（agent-runtime 的 EMPTY_REPLY_NOTICE_TEXT）对这两把尺的断言在
  // agent-runtime/src/durable/__tests__/emptyReply.test.ts —— chat-protocol 是叶子包，不反引它
  it('ER-1 种类是 empty-reply、在标签表里；一整块 <empty-reply> 信封两把尺都认', () => {
    expect(EMPTY_REPLY_NOTICE_KIND).toBe('empty-reply')
    expect(SYSTEM_NOTICE_TAGS).toContain(EMPTY_REPLY_NOTICE_KIND)
    expect(isSystemNoticeText(emptyReply)).toBe(true)
    expect(isEmptyReplyNoticeText(emptyReply)).toBe(true)
  })

  it.each([
    ['two empty-reply blocks separated by a blank line', `${emptyReply}\n\n${emptyReply}`, true],
    ['a block with attributes', '<empty-reply attempt="1">\nbody\n</empty-reply>', true],
    ['empty-reply joined with a background-task', `${emptyReply}\n\n${bgTask}`, false],
    ['a background-task only', bgTask, false],
    ['a sub-session only', subSession, false],
    ['the empty string', '', false],
    ['plain text', 'please carry on', false],
    ['the envelope plus a human sentence', `${emptyReply}\nand also deploy`, false],
    ['a human sentence before the envelope', `hi ${emptyReply}`, false],
    ['an unclosed envelope', '<empty-reply>\nbody', false],
    ['a self-closing tag', '<empty-reply/>', false]
  ])('ER-2 isEmptyReplyNoticeText: %s → %s', (_label, text, expected) => {
    expect(isEmptyReplyNoticeText(text)).toBe(expected)
  })

  it('ER-3 混拼的一条仍是系统通知（isSystemNoticeText），只是不是空回复追问', () => {
    expect(isSystemNoticeText(`${emptyReply}\n\n${bgTask}`)).toBe(true)
    expect(isEmptyReplyNoticeText(`${emptyReply}\n\n${bgTask}`)).toBe(false)
  })
})

describe('<session> 通知里夹着 <running-background-tasks>（BT-70）', () => {
  const block = [
    '<running-background-tasks>',
    'Still running in that session:',
    '- command (pid 4242): dev server',
    'They belong to that session and keep running after its turn ends.',
    '</running-background-tasks>'
  ].join('\n')
  const notice = [
    '<session id="c1" title="Title" status="idle">',
    'The turn you started in the background has finished.',
    block,
    'Collect it with the session tool: action "wait-for-sessions".',
    '</session>'
  ].join('\n')

  it('BT-70 整条还是一块系统通知（标签 session），不是空回复追问', () => {
    expect(isSystemNoticeText(notice)).toBe(true)
    expect(isEmptyReplyNoticeText(notice)).toBe(false)
    expect([...notice.matchAll(systemNoticeBlockRe())].map((m) => m[1])).toEqual(['session'])
  })

  it('BT-70 那一块单独拿出来不是通知（它不在标签表里）', () => {
    expect(isSystemNoticeText(block)).toBe(false)
  })
})

/**
 * 目标模式的通知（docs/goal-mode-design.md §5）：续跑消息 steer 进当前轮时只能按正文形状认 —— 标签漏登记，
 * 续跑消息（连同判定理由）就会被转写摘要当成人写的。
 *
 *   NC-1 五个 goal-* 标签都在标签表里；`goal-set` / `goal` 不是通知标签（设定目标那条是人的消息）
 *   NC-2 `goalNoticeKindOf`：只由同一种 goal-* 块组成 → 那个标签；混了别的、夹了人话、半截 → undefined。
 *        混拼的一条照样是系统通知（安全性质不随种类丢失）
 */
describe('goal notices (目标模式)', () => {
  const goalBlock = (tag: string): string => `<${tag} id="g_1">\nbody\n</${tag}>`

  it('NC-1 每个 goal-* 标签都登记在 SYSTEM_NOTICE_TAGS；一整块各自都认；goal-set / goal 不是通知标签', () => {
    expect(GOAL_NOTICE_TAGS).toEqual([
      'goal-continue',
      'goal-checkin',
      'goal-budget',
      'goal-updated',
      'goal-status'
    ])
    for (const tag of GOAL_NOTICE_TAGS) {
      expect(SYSTEM_NOTICE_TAGS).toContain(tag)
      expect(isSystemNoticeText(goalBlock(tag))).toBe(true)
    }
    expect(SYSTEM_NOTICE_TAGS).not.toContain('goal-set')
    expect(SYSTEM_NOTICE_TAGS).not.toContain('goal')
    expect(isSystemNoticeText(goalBlock('goal-set'))).toBe(false)
    expect(isSystemNoticeText(goalBlock('goal'))).toBe(false)
  })

  it('NC-2 goalNoticeKindOf：单块 → 标签；同标签两块 → 标签', () => {
    for (const tag of GOAL_NOTICE_TAGS) {
      expect(goalNoticeKindOf(goalBlock(tag))).toBe(tag)
      expect(goalNoticeKindOf(`${goalBlock(tag)}\n\n${goalBlock(tag)}`)).toBe(tag)
    }
  })

  it.each([
    ['goal-continue + goal-status', `${goalBlock('goal-continue')}\n\n${goalBlock('goal-status')}`],
    ['goal-continue + background-task', `${goalBlock('goal-continue')}\n\n${bgTask}`],
    ['empty-reply', '<empty-reply>\nx\n</empty-reply>'],
    ['text + block', `ok then ${goalBlock('goal-continue')}`],
    ['unclosed', '<goal-continue id="g_1">\nbody'],
    ['plain text', 'keep going']
  ])('NC-2 goalNoticeKindOf: %s → undefined', (_label, text) => {
    expect(goalNoticeKindOf(text)).toBeUndefined()
  })

  it('NC-2 目标通知与后台任务通知拼成一条：种类丢了，但照样是系统通知（不会被当成人话）', () => {
    const joined = `${bgTask}\n\n${goalBlock('goal-continue')}`
    expect(goalNoticeKindOf(joined)).toBeUndefined()
    expect(isSystemNoticeText(joined)).toBe(true)
  })
})
