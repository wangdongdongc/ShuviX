/**
 * 写入回执里的 bot 定时运行权限核对（services/botAccessHint）—— 只认「这是不是那种文件」并调 main 启动时注入的核对
 * （setBotAccessChecker）；判定与文字在 botAccessCheck / agent-runtime（各有单测）。
 *
 * 契约（botAccessHint.ts 的注释）：
 *  - 没注入 = 不核对（两个入口都回 null）；setBotAccessChecker(null) 复位；
 *  - botAccessNoteFor(text, path) 原样转给 forBotFile；policyBotAccessNoteFor(text, fileName) 先做便宜的预筛
 *    （正文里没有 `subject.bot` 这个词 → 不调核对），再转给 forPolicyFile；核对抛错 → null（它只是附言）；
 *  - policyBotAccessHint 的认法与策略扫描一致：策略目录顶层的 md（标记可以不写），或 frontmatter 标记是
 *    `shuvix: policy`；扩展名 .md 不分大小写；拿到的文件名是 basename；getDefaultPoliciesDir 抛错 → null；
 *  - 刻意轻：只依赖路径与标记检测 —— 这里只替身 utils/paths，bot 注册表、项目、策略服务、安全上下文与数据库一被
 *    引入就炸（BAH-5）。
 *
 *   BAH-1 没注入 → 两个入口都是 null；注入后再复位成 null → 又是 null、旧的那份不被调
 *   BAH-2 botAccessNoteFor 原样转发 (text, path)、交回结果；核对抛错 → null
 *   BAH-3 policyBotAccessNoteFor：没有 subject.bot（含 subject.botany）→ null、不调；否则转发文件名；抛错 → null
 *   BAH-4 policyBotAccessHint 的认法表
 *   BAH-5 模块（连同 botScheduleHint）只靠 utils/paths 的替身就加载得起来：不引 botService / projectService /
 *         policyService / toolContext / 数据库
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotAccessChecker } from '../botAccessCheck'

const state = vi.hoisted(() => ({
  policies: '/tmp/shuvix-bah/policies',
  policiesThrows: false
}))

vi.mock('../../utils/paths', () => ({
  getDefaultPoliciesDir: () => {
    if (state.policiesThrows) throw new Error('no home')
    return state.policies
  },
  getDefaultBotsDir: () => '/tmp/shuvix-bah/bots'
}))
// BAH-5：这些一被引入就炸 —— 回执挂在 file 工具上，静态引入它们会把数据库拖进 file 工具的依赖图
const { forbidden } = vi.hoisted(() => ({
  forbidden: (name: string) => (): never => {
    throw new Error(`${name} must not be imported by botAccessHint / botScheduleHint`)
  }
}))
vi.mock('../botService', forbidden('botService'))
vi.mock('../projectService', forbidden('projectService'))
vi.mock('../policyService', forbidden('policyService'))
vi.mock('../toolContext', forbidden('toolContext'))
vi.mock('../botAccessWiring', forbidden('botAccessWiring'))
vi.mock('../../dao/database', forbidden('dao/database'))

import {
  botAccessNoteFor,
  policyBotAccessHint,
  policyBotAccessNoteFor,
  setBotAccessChecker
} from '../botAccessHint'
import { botFileNoteFor, botScheduleHint } from '../botScheduleHint'

type StubChecker = {
  [K in keyof BotAccessChecker]: ReturnType<typeof vi.fn<BotAccessChecker[K]>>
}

function stubChecker(
  over: Partial<Record<'forBotFile' | 'forPolicyFile', () => string | null>> = {}
): StubChecker {
  return {
    forBotFile: vi.fn<BotAccessChecker['forBotFile']>(over.forBotFile ?? (() => 'ACCESS-BOT')),
    forPolicyFile: vi.fn<BotAccessChecker['forPolicyFile']>(
      over.forPolicyFile ?? (() => 'ACCESS-POLICY')
    ),
    forBotName: vi.fn<BotAccessChecker['forBotName']>(() => ({ text: 'x' }))
  }
}

const NAMING = 'match: "has(subject.bot) && subject.bot == \'buddy\'"'
const policyMd = (marker: string | null, extra: string[] = []): string =>
  [
    '---',
    ...(marker === null ? [] : [marker]),
    'name: buddy-access',
    'shuvix-policy-rules:',
    '  - effect: force-allow',
    `    ${NAMING}`,
    ...extra,
    '---',
    '',
    'Body.',
    ''
  ].join('\n')

beforeEach(() => {
  state.policiesThrows = false
})
afterEach(() => {
  setBotAccessChecker(null)
})

describe('BAH-1 / BAH-2 / BAH-3 转发', () => {
  it('BAH-1 没注入 → 两个入口都是 null；复位成 null → 又是 null、旧的那份不被调', () => {
    expect(botAccessNoteFor('text', '/b/buddy.md')).toBeNull()
    expect(policyBotAccessNoteFor("subject.bot == 'x'", 'x.md')).toBeNull()
    const stub = stubChecker()
    setBotAccessChecker(stub)
    setBotAccessChecker(null)
    expect(botAccessNoteFor('text', '/b/buddy.md')).toBeNull()
    expect(policyBotAccessNoteFor("subject.bot == 'x'", 'x.md')).toBeNull()
    expect(stub.forBotFile).not.toHaveBeenCalled()
    expect(stub.forPolicyFile).not.toHaveBeenCalled()
  })

  it('BAH-2 botAccessNoteFor 原样转发 (text, path)、交回结果；回 null 就是 null', () => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    expect(botAccessNoteFor('the text', '/abs/bots/buddy.md')).toBe('ACCESS-BOT')
    expect(stub.forBotFile.mock.calls).toEqual([['the text', '/abs/bots/buddy.md']])
    setBotAccessChecker(stubChecker({ forBotFile: () => null }))
    expect(botAccessNoteFor('the text', '/abs/bots/buddy.md')).toBeNull()
  })

  it('BAH-2 核对抛错 → null，不抛', () => {
    setBotAccessChecker(
      stubChecker({
        forBotFile: () => {
          throw new Error('boom')
        }
      })
    )
    expect(() => botAccessNoteFor('t', '/b/x.md')).not.toThrow()
    expect(botAccessNoteFor('t', '/b/x.md')).toBeNull()
  })

  it('BAH-3 没有 subject.bot（subject.botany 也不算）→ null、不调核对', () => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    expect(policyBotAccessNoteFor("object.path == '/x'", 'x.md')).toBeNull()
    expect(policyBotAccessNoteFor("subject.botany == 'x'", 'x.md')).toBeNull()
    expect(stub.forPolicyFile).not.toHaveBeenCalled()
  })

  it('BAH-3 有 subject.bot → 转发 (text, fileName)、交回结果；抛错 → null', () => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    const text = "has(subject.bot) && subject.bot == 'x'"
    expect(policyBotAccessNoteFor(text, 'x-access.md')).toBe('ACCESS-POLICY')
    expect(stub.forPolicyFile.mock.calls).toEqual([[text, 'x-access.md']])
    setBotAccessChecker(
      stubChecker({
        forPolicyFile: () => {
          throw new Error('boom')
        }
      })
    )
    expect(policyBotAccessNoteFor(text, 'x-access.md')).toBeNull()
  })
})

describe('BAH-4 policyBotAccessHint 认不认这是一份策略', () => {
  const outside = (name: string): string => `/tmp/shuvix-bah/elsewhere/${name}`

  it.each<[string, () => string, string, string | null]>([
    ['策略目录顶层、没写标记', () => `${state.policies}/x.md`, policyMd(null), 'x.md'],
    ['策略目录顶层、带标记', () => `${state.policies}/x.md`, policyMd('shuvix: policy v1'), 'x.md'],
    ['策略目录的子目录', () => `${state.policies}/sub/x.md`, policyMd(null), null],
    [
      '目录外、带 `shuvix: policy v1`',
      () => outside('draft.md'),
      policyMd('shuvix: policy v1'),
      'draft.md'
    ],
    ['目录外、没有标记', () => outside('draft.md'), policyMd(null), null],
    ['目录外、别家的标记', () => outside('draft.md'), policyMd('shuvix: bot v2'), null],
    ['扩展名 .txt', () => `${state.policies}/x.txt`, policyMd('shuvix: policy v1'), null],
    ['扩展名 X.MD', () => `${state.policies}/X.MD`, policyMd(null), 'X.MD']
  ])('BAH-4 %s', (_label, path, text, fileName) => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    const got = policyBotAccessHint(path(), text)
    if (fileName === null) {
      expect(got).toBeNull()
      expect(stub.forPolicyFile).not.toHaveBeenCalled()
    } else {
      expect(got).toBe('ACCESS-POLICY')
      expect(stub.forPolicyFile.mock.calls).toEqual([[text, fileName]])
    }
  })

  it('BAH-4 标记只在正文里 → null', () => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    const bodyOnly = `${policyMd(null).trimEnd()}\nshuvix: policy v1\n`
    expect(bodyOnly).toContain('\nshuvix: policy v1\n')
    expect(policyBotAccessHint(outside('draft.md'), bodyOnly)).toBeNull()
    expect(stub.forPolicyFile).not.toHaveBeenCalled()
  })

  it('BAH-4 getDefaultPoliciesDir 抛错 → null，不抛', () => {
    const stub = stubChecker()
    setBotAccessChecker(stub)
    state.policiesThrows = true
    expect(() => policyBotAccessHint(`${state.policies}/x.md`, policyMd(null))).not.toThrow()
    expect(policyBotAccessHint(`${state.policies}/x.md`, policyMd(null))).toBeNull()
    expect(stub.forPolicyFile).not.toHaveBeenCalled()
  })
})

describe('BAH-5 刻意轻', () => {
  it('BAH-5 只靠 utils/paths 的替身就加载起来，且两个模块都能用（被禁的模块一个都没被引入）', () => {
    // 走到这里就说明上面那些「一引入就炸」的替身一个都没被求值
    expect(typeof setBotAccessChecker).toBe('function')
    expect(typeof botScheduleHint).toBe('function')
    const stub = stubChecker()
    setBotAccessChecker(stub)
    expect(botFileNoteFor('---\nname: buddy\n---\n', '/tmp/shuvix-bah/bots/buddy.md')).toBe(
      'ACCESS-BOT'
    )
    expect(stub.forBotFile.mock.calls).toEqual([
      ['---\nname: buddy\n---\n', '/tmp/shuvix-bah/bots/buddy.md']
    ])
  })
})
