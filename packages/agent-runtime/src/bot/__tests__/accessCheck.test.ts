/**
 * bot 定时运行的权限核对（bot/accessCheck，设计稿 docs/bot-access-check-design.md）—— 拿一组具体客体交给注入的 judge
 * （真实引擎的 judgeGate）判，按 allowed / review / stops / denied 归类，写成写入回执里的那一段（模型面英文）。
 *
 * 契约（accessCheck.ts 文件头 + 2026-10-31 的裁定；设计稿里的会话年龄阶梯已删：只在「此刻」试一次会话）：
 *  - 点名：policyNamesBot(p, id) 恰是 botIdentitiesNamedBy(p).includes(id) —— 与 `subject.bot` 的相等比较
 *    （`==` 两个方向、`in [...]`，规则与 lets 都算）；`!=` 不算点名；
 *  - 点名路径：策略文本里的字符串字面量（绝对路径或 `~` 开头）与 `vars.*` 里是路径的那些；家目录 / 根本身、宽泛变量
 *    （home / workspace / now / systemDirs）、取不到的变量不算；`vars.x + '…'` 先折成一个字面量（取不到值连字面量
 *    一起丢）；`inDir` 的参数、`/` 结尾、isDirectory 为真 → 文件夹（试里面的样例文件）；至多 6 个，多的回执里说一句；
 *    按位置的 vars 算（`vars.workspace` 随位置变）；
 *  - 试探：别的会话读 / 发消息各一次（lastActiveAt = 这个位置的 vars.now）、每个点名路径读写各一次、它旁边那份读写各
 *    一次（只在被策略放行时报，从不让运行「停下」）、家目录里的样例读写、家目录外的样例写；每次带真实调用会带的工具；
 *  - 归类：胜出规则 `<策略>#<序号>` → 策略名；`default:` → 没人拦；deny → denied；普通 ask 且审查开着、不是会话 / 组件
 *    → review；其余 → stops；
 *  - 文字：结果相同的位置合成一节；身份那一行（id / name / untrusted-id 三种说法，身份按 CEL 字符串转义）、写成普通
 *    allow 的规则、会停的那一句、没有策略点名时的建议、求值出错的告警（去重、至多 3 条、CEL 错误只要第一行），都只出现一次。
 *
 * 引擎夹具：createSecurityContext + 内联的内置策略（同 security/__tests__/builtinPolicies.test.ts），provider pathSep '/'、
 * 不给 realPath；主体是 bot 的根 agent（档案 bot、attrs.bot = 身份），env 是 desktop；judge = judgeGate(a, o, {tool})。
 *
 *   AC-1  policyNamesBot：三种写法、双引号、转义、lets 里也算；没有 subject.bot 比较 / 大小写 / 子串 / `!=` → false
 *   AC-2  botIdentitiesNamedBy：规则 + lets、去重、空串丢掉；只有 has(subject.bot) / `!=` → []
 *   AC-3  namedPathsOf：字面量、`~`、家目录与根、相对与非路径、`/` 结尾、inDir、isDirectory、vars（数组、宽泛、未知）、
 *         拼接折叠（拼错的变量名什么都不留）、跨策略去重、上限 6、Windows
 *   AC-4  accessOutcomeOf 的归类表
 *   AC-5  逐字：没有策略点名、临时文件夹、审查开着、身份是 UUID
 *   AC-6  审查关着：每个询问都「只有用户能答」，elsewhere 合成一句，会停那句在
 *   AC-7  手册里的模板（en policy-md 的 xiaozhou-access）：会话读放行、发消息会停、那份笔记读写放行，没有建议
 *   AC-8  同一份模板写成 `allow`：照样要问；普通 allow 那一行逐条列出
 *   AC-9  放得太宽：整个家目录 → also allowed 列出家目录里的两条，elsewhere 只剩家目录外的写；没有客体条件 → 三条都在
 *         also allowed、没有 elsewhere
 *   AC-10 旁边那份：startsWith 写法连 `notes-…` 都放行（报出来）；inDir 不会；点名文件 + 整个文件夹的规则 → 报旁边的文件
 *   AC-11 用户的 force-ask → 审查开着也会停；deny → denied
 *   AC-12 日记 bot 与真实的内置 daily-bot-access
 *   AC-13 会话只试一次（此刻）：客体逐字；按最近 24 小时放行的规则 → allowed；vars.now 不是字符串 → 用 input.now
 *   AC-14 试探的全集与顺序、带的工具；旁边那份的结果从不让「会停」那句出现
 *   AC-15 几个位置：结果相同 → 一节；不同 → 两节；身份 / 会停 / 建议只出现一次；点名路径按位置的 vars 算
 *   AC-16 身份的另外两种说法（name / untrusted-id）
 *   AC-17 求值告警：引擎格式改写、CEL 错误只要第一行、去重、至多 3 条；没有告警就没有那一行
 *   AC-18 Windows（fake judge）：样例路径与 `~\…` 的说法
 *   AC-19 点名路径超过上限 → 「N more path(s) … not checked」
 *   AC-20 celQuote 转义 `'` 与 `\`；身份那一行与建议里都用它
 *   AC-21 按 `tool.name: [write]` 收窄的 force-allow：核对里写放行、读照问
 *   AC-22 按 object.sessionId 放行会话的 allow / force-allow 规则：照问，另说一句为什么盖不住之后的运行（ask / deny 不提）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSecurityContext } from '../../security/context'
import { resolvePolicyFiles } from '../../security/assemble'
import { buildBuiltinPolicies } from '../../security/builtinPolicies'
import { parsePolicyDefinitionFile } from '../../security/policyFile'
import { createInlinePolicyMdReader } from '../../security/builtinPolicies/inlineSources'
import type {
  GateVerdict,
  ParsedPolicyFile,
  SecurityHostProvider,
  SecurityObject,
  SecurityToolRef,
  UserPolicyFile
} from '../../security/types'
import {
  accessOutcomeOf,
  botAccessNote,
  botIdentitiesNamedBy,
  celQuote,
  namedPathsOf,
  policyNamesBot,
  type AccessAction,
  type BotAccessCheckInput,
  type BotAccessHost,
  type BotAccessLocation
} from '../accessCheck'

const READ_MD = createInlinePolicyMdReader()
const BUILTINS = buildBuiltinPolicies({ readMd: READ_MD })

const HOME = '/Users/u'
const WORKDIR = '/Users/u/work/tiny-cli'
const BOT_FILE = '/Users/u/.shuvix/bots/xiaozhou.md'
const KB_DIR = '/Users/u/.shuvix/knowledge-shuvix/projects/p1'
const DAILY_DIR = '/Users/u/.shuvix/daily'
const NOW = '2026-10-31T10:00:00.000Z'
const UUID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

/** `…/packages/agent-runtime/src/bot/__tests__` 往上五层是仓库根 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

// ─────────────────────────── 夹具 ───────────────────────────

interface Probe {
  action: AccessAction
  object: SecurityObject
  tool: SecurityToolRef
}

type Trial = BotAccessLocation & {
  vars: Record<string, unknown>
  warnings: string[]
  calls: Probe[]
}

/** 一个位置的一次定时运行，交给真实引擎判（宿主 getDesktopBotRunTrial 的形状：权限表只有派生的那几行） */
function engineLocation(
  opts: {
    identity?: string
    users?: UserPolicyFile[]
    label?: string
    workdir?: string
    disabled?: string[]
    vars?: Record<string, unknown>
  } = {}
): Trial {
  const workdir = opts.workdir ?? WORKDIR
  const warnings: string[] = []
  const calls: Probe[] = []
  const vars: Record<string, unknown> = {
    home: HOME,
    workspace: workdir,
    aclRead: [workdir, BOT_FILE, KB_DIR],
    aclWrite: [workdir, BOT_FILE, KB_DIR],
    aclSessionRead: [],
    aclSessionWrite: [],
    aclWidgetRead: [],
    aclWidgetWrite: [],
    now: NOW,
    dailyDir: DAILY_DIR,
    trackingDir: '/Users/u/.shuvix/tracking',
    ...opts.vars
  }
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => vars as never,
    readBuiltinPolicyMd: READ_MD,
    getUserPolicies: () => opts.users ?? [],
    isPolicyDisabled: (p) => (opts.disabled ?? []).includes(p.name),
    logger: {
      info: () => {},
      warn: (m) => void warnings.push(m),
      error: (m) => void warnings.push(m)
    }
  }
  const context = createSecurityContext(
    {
      kind: 'agent',
      sessionId: '',
      agentKind: 'root',
      profileName: 'bot',
      attrs: { bot: opts.identity ?? UUID }
    },
    { host: 'desktop' },
    provider
  )
  return {
    label: opts.label ?? 'a temporary folder',
    vars,
    warnings,
    calls,
    judge: (action, object, tool) => {
      calls.push({ action, object, tool })
      return context.judgeGate(action, object, { tool })
    }
  }
}

/** 一个不判的位置：每次都回 verdictFor 的结果，并记下来 */
function fakeLocation(
  verdictFor: (action: AccessAction, object: SecurityObject) => GateVerdict = () => ALLOW,
  opts: { label?: string; vars?: Record<string, unknown> } = {}
): Trial {
  const calls: Probe[] = []
  return {
    label: opts.label ?? 'a temporary folder',
    vars: opts.vars ?? { home: HOME, workspace: WORKDIR, now: NOW },
    warnings: [],
    calls,
    judge: (action, object, tool) => {
      calls.push({ action, object, tool })
      return verdictFor(action, object)
    }
  }
}

function verdict(
  allowed: boolean,
  winning: string,
  effect: 'allow' | 'ask' | 'deny',
  tier: GateVerdict['decision']['tier']
): GateVerdict {
  return {
    allowed,
    decision: { effect, tier, matched: winning.startsWith('default:') ? [] : [winning], winning },
    downgraded: effect === 'ask'
  }
}
const ALLOW = verdict(true, 'default:path', 'allow', 'default')

/** 此刻生效、点名这个身份的策略（同宿主：内置 + 用户，遮蔽的、停用的不算） */
function namingOf(
  identity: string,
  users: UserPolicyFile[],
  disabled: string[] = []
): ParsedPolicyFile[] {
  return resolvePolicyFiles(BUILTINS, users)
    .filter((e) => !e.shadowedBy && !disabled.includes(e.policy.name))
    .map((e) => e.policy)
    .filter((p) => policyNamesBot(p, identity))
}

function host(opts: Partial<BotAccessHost> & { dirs?: string[] } = {}): BotAccessHost {
  const dirs = new Set(opts.dirs ?? [])
  return {
    home: opts.home ?? HOME,
    root: opts.root ?? '/',
    sep: opts.sep ?? '/',
    vars: opts.vars ?? {},
    isDirectory: opts.isDirectory ?? ((p) => dirs.has(p))
  }
}

/** 回执那一段：缺省一个引擎位置、身份 UUID、审查开着、点名的策略按 users 现算 */
function noteOf(
  opts: {
    identity?: string
    identityFrom?: BotAccessCheckInput['identityFrom']
    botName?: string
    users?: UserPolicyFile[]
    naming?: ParsedPolicyFile[]
    review?: boolean
    locations?: Trial[]
    dirs?: string[]
    warnings?: string[]
  } = {}
): string {
  const identity = opts.identity ?? UUID
  const locations = opts.locations ?? [engineLocation({ identity, users: opts.users })]
  return botAccessNote({
    botName: opts.botName ?? 'xiaozhou',
    identity,
    identityFrom: opts.identityFrom ?? 'id',
    naming: opts.naming ?? namingOf(identity, opts.users ?? []),
    locations,
    reviewActive: opts.review ?? true,
    host: host({ vars: locations[0]?.vars ?? {}, dirs: opts.dirs }),
    policiesDirLabel: '~/.shuvix/policies/',
    now: new Date(NOW),
    warnings: () => opts.warnings ?? locations.flatMap((l) => l.warnings)
  })
}

/** 一份用户策略（md 原文 → 解析）；rules 是 `- effect …` 起的那几段 YAML 行 */
function policy(name: string, rules: string[][], fileName = `${name}.md`): UserPolicyFile {
  const text = [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    'description: Test policy.',
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  env.host: [desktop]',
    'shuvix-policy-rules:',
    ...rules.flat(),
    '---',
    '',
    'Test.',
    ''
  ].join('\n')
  const parsed = parsePolicyDefinitionFile(text, fileName.replace(/\.md$/, ''), (m) => {
    throw new Error(`fixture ${name}: ${m}`)
  })
  if (!parsed) throw new Error(`fixture policy ${name} does not parse`)
  return { ...parsed, fileName }
}

/** 一条规则的 YAML 行 */
function rule(effect: string, conditions: Record<string, string[]>, match?: string): string[] {
  return [
    `  - effect: ${effect}`,
    ...Object.entries(conditions).map(([k, v]) => `    ${k}: [${v.join(', ')}]`),
    ...(match ? ['    match: >-', `      ${match}`] : [])
  ]
}

const guard = (identity: string): string =>
  `has(subject.bot) && subject.bot == ${celQuote(identity)} && subject.agentKind == 'root'`

/** 只为纯函数用例：不经解析器的一份策略（match 文本原样） */
function bare(name: string, matches: string[], lets?: Record<string, string>): ParsedPolicyFile {
  return {
    name,
    displayName: name,
    description: '',
    rules: matches.map((match) => ({ effect: 'force-allow' as const, match })),
    ...(lets ? { lets } : {}),
    body: ''
  }
}

const REVIEW = (by: string): string =>
  `asks (${by}; the automatic review answers at run time and may refuse)`
const STOPS = (by: string): string =>
  `asks (${by}; only the user can answer, so the run would stop)`
const HEADER = (where: string, name = 'xiaozhou'): string =>
  `Unattended access check for bot ${name} (scheduled runs have nobody to answer asks; as run in ${where}):`
const STOP_LINE =
  'A run that asks something only the user can answer waits until they come back, and that binding’s next ' +
  'firings are skipped while it waits.'
const ELSEWHERE_REVIEW =
  '- elsewhere: read a file in the home folder outside its working folder, write there, write outside the home ' +
  `folder: ${REVIEW('ask-on-external-path')}.`
const count = (text: string, part: string): number => text.split(part).length - 1
const lines = (text: string): string[] => text.split('\n')

// ─────────────────────────── 点名 ───────────────────────────

describe('AC-1 policyNamesBot', () => {
  it.each([
    ['subject.bot == lit', "subject.bot == 'x'"],
    ['lit == subject.bot', "'x' == subject.bot"],
    ['in list', "subject.bot in ['a', 'x']"],
    ['double quotes', 'subject.bot == "x"'],
    ['no spaces', "subject.bot=='x'"],
    ['in list, double quotes', 'subject.bot in ["a", "x"]']
  ])('AC-1 %s → true', (_label, match) => {
    expect(policyNamesBot(bare('p', [`has(subject.bot) && ${match}`]), 'x')).toBe(true)
  })

  it("AC-1 转义（in 列表）：`subject.bot in ['x\\'y']` 点名 x'y", () => {
    expect(policyNamesBot(bare('p', ["subject.bot in ['x\\'y']"]), "x'y")).toBe(true)
  })

  // 产品缺陷（2026-10-31 写测时发现）：`==` 两个方向抓到的字面量没有去掉转义（`in` 列表那条经 stringLiterals 去掉了），
  // 于是 CEL 里 `'x\'y'` 本是 x'y，核对却认成 `x\'y` —— 回执给 agent 照抄的条件（celQuote）写回策略后，这份策略
  // 「没有点名」这个 bot。修好之后去掉 .fails
  it("AC-1 转义（==）：`subject.bot == 'x\\'y'` 点名 x'y", () => {
    expect(policyNamesBot(bare('p', ["subject.bot == 'x\\'y'"]), "x'y")).toBe(true)
  })

  it('AC-1 lets 里的比较也算', () => {
    expect(policyNamesBot(bare('p', ['me'], { me: "subject.bot == 'x'" }), 'x')).toBe(true)
  })

  it.each([
    ['字面量只出现在别的比较里', "object.title == 'x'"],
    ['大小写不同', "subject.bot == 'X'"],
    ['子串', "subject.bot == 'xy'"],
    ['只是 has', 'has(subject.bot)'],
    ['`!=` 是排除，不是点名', "subject.bot != 'x'"],
    ['别的主体字段', "subject.botany == 'x'"]
  ])('AC-1 %s → false', (_label, match) => {
    expect(policyNamesBot(bare('p', [match]), 'x')).toBe(false)
  })

  it('AC-1 恰是 botIdentitiesNamedBy(p).includes(id)', () => {
    const p = bare('p', ["subject.bot != 'x' && subject.bot == 'y'"])
    for (const id of ['x', 'y', 'z']) {
      expect(policyNamesBot(p, id)).toBe(botIdentitiesNamedBy(p).includes(id))
    }
  })
})

describe('AC-2 botIdentitiesNamedBy', () => {
  it('AC-2 三种写法跨规则与 lets、去重、空串丢掉', () => {
    const p = bare(
      'p',
      ["subject.bot == 'a' && x", "'b' == subject.bot || subject.bot == 'a'", "subject.bot == ''"],
      { l: "subject.bot in ['c', \"d\", 'a', '']" }
    )
    expect(botIdentitiesNamedBy(p).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('AC-2 只有 has(subject.bot) → []；只有 `!=` → []', () => {
    expect(botIdentitiesNamedBy(bare('p', ['has(subject.bot)']))).toEqual([])
    expect(botIdentitiesNamedBy(bare('p', ["subject.bot != 'x'"]))).toEqual([])
  })
})

// ─────────────────────────── 点名路径 ───────────────────────────

describe('AC-3 namedPathsOf', () => {
  const H = host({
    vars: {
      dailyDir: DAILY_DIR,
      skillsDirs: ['/opt/skills-a', '/opt/skills-b'],
      workspace: '/Users/u/work',
      home: HOME,
      now: NOW,
      systemDirs: ['/System']
    },
    dirs: ['/Users/u/projects']
  })
  const paths = (
    matches: string[],
    lets?: Record<string, string>,
    h: BotAccessHost = H
  ): ReturnType<typeof namedPathsOf> => namedPathsOf([bare('p', matches, lets)], h)

  it('AC-3 绝对路径字面量 → 文件；双引号同', () => {
    expect(paths(["object.path == '/etc/hosts'"])).toEqual([{ path: '/etc/hosts', dir: false }])
    expect(paths(['object.path == "/etc/hosts"'])).toEqual([{ path: '/etc/hosts', dir: false }])
  })

  it('AC-3 `~/…` 按家目录展开', () => {
    expect(paths(["object.path == '~/notes/a.md'"])).toEqual([
      { path: '/Users/u/notes/a.md', dir: false }
    ])
  })

  it.each([["'~'"], ["'/Users/u'"], ["'/Users/u/'"], ["'/'"]])(
    'AC-3 家目录 / 根本身（%s）→ 丢掉',
    (lit) => {
      expect(paths([`inDir(object.path, ${lit})`])).toEqual([])
    }
  )

  it('AC-3 相对路径与不是路径的字面量 → 丢掉', () => {
    expect(paths(["object.path == 'notes/a.md' && subject.agentKind == 'root'"])).toEqual([])
  })

  it('AC-3 `/` 结尾 → 文件夹（去掉末尾的 /）', () => {
    expect(paths(["object.path.startsWith('/Users/u/notes/')"])).toEqual([
      { path: '/Users/u/notes', dir: true }
    ])
  })

  it('AC-3 inDir 的字面量参数 → 文件夹；isDirectory 为真 → 文件夹', () => {
    expect(paths(["inDir(object.path, '/x')"])).toEqual([{ path: '/x', dir: true }])
    expect(paths(["object.path.startsWith('/Users/u/projects')"])).toEqual([
      { path: '/Users/u/projects', dir: true }
    ])
  })

  it('AC-3 vars.dailyDir：inDir 里 → 文件夹；比较里 → 文件（宿主说不是文件夹）', () => {
    expect(paths(['inDir(object.path, vars.dailyDir)'])).toEqual([{ path: DAILY_DIR, dir: true }])
    expect(paths(['object.path == vars.dailyDir'])).toEqual([{ path: DAILY_DIR, dir: false }])
  })

  it('AC-3 数组变量：每个元素一条', () => {
    expect(paths(['inDir(object.path, vars.skillsDirs)'])).toEqual([
      { path: '/opt/skills-a', dir: true },
      { path: '/opt/skills-b', dir: true }
    ])
  })

  it('AC-3 宽泛变量（home / workspace / now / systemDirs）单独出现 → 不算；未知变量 → 不算', () => {
    expect(
      paths([
        'inDir(object.path, vars.home)',
        'inDir(object.path, vars.workspace)',
        "timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('24h')",
        'inDir(object.path, vars.systemDirs)',
        'inDir(object.path, vars.nope)'
      ])
    ).toEqual([])
  })

  it('AC-3 拼接折叠：vars.home + …、vars.workspace + …、inDir(…, vars.home + …) → 文件夹', () => {
    expect(paths(["object.path == vars.home + '/notes/a.md'"])).toEqual([
      { path: '/Users/u/notes/a.md', dir: false }
    ])
    expect(paths(["object.path == vars.workspace + '/out.md'"])).toEqual([
      { path: '/Users/u/work/out.md', dir: false }
    ])
    expect(paths(["inDir(object.path, vars.home + '/notes')"])).toEqual([
      { path: '/Users/u/notes', dir: true }
    ])
    expect(paths(['object.path == vars.home + "/notes/b.md"'])).toEqual([
      { path: '/Users/u/notes/b.md', dir: false }
    ])
  })

  it('AC-3 拼错的变量名 + 字面量 → 什么都不留（字面量不会被当成根下的路径）', () => {
    expect(paths(["object.path == vars.typo + '/notes/a.md'"])).toEqual([])
  })

  it('AC-3 跨策略去重', () => {
    expect(
      namedPathsOf(
        [bare('a', ["object.path == '/etc/hosts'"]), bare('b', ["object.path == '/etc/hosts/'"])],
        H
      )
    ).toEqual([{ path: '/etc/hosts', dir: false }])
  })

  it('AC-3 上限 6 个', () => {
    const many = Array.from({ length: 8 }, (_v, i) => `object.path == '/data/f${i}.md'`)
    const got = paths(many)
    expect(got).toHaveLength(6)
    expect(got.map((p) => p.path)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `/data/f${i}.md`))
  })

  it('AC-3 Windows：sep `\\`、家目录 C:\\Users\\u、根 C:\\', () => {
    const W = host({ home: 'C:\\Users\\u', root: 'C:\\', sep: '\\', vars: {} })
    expect(
      paths(
        [
          "object.path == 'C:\\\\Users\\\\u\\\\notes\\\\a.md'",
          "inDir(object.path, 'C:\\\\Users\\\\u\\\\x')",
          "inDir(object.path, 'C:\\\\Users\\\\u')",
          "inDir(object.path, 'C:\\\\')"
        ],
        undefined,
        W
      )
    ).toEqual([
      { path: 'C:\\Users\\u\\notes\\a.md', dir: false },
      { path: 'C:\\Users\\u\\x', dir: true }
    ])
  })
})

// ─────────────────────────── 归类 ───────────────────────────

describe('AC-4 accessOutcomeOf', () => {
  it.each<[string, GateVerdict, string, boolean, unknown]>([
    ['默认放行', ALLOW, 'path', true, { kind: 'allowed', by: null }],
    [
      'p#2 放行',
      verdict(true, 'p#2', 'allow', 'force-allow'),
      'path',
      true,
      { kind: 'allowed', by: 'p' }
    ],
    [
      '名字里带 #',
      verdict(true, 'a#b#3', 'allow', 'force-allow'),
      'path',
      true,
      { kind: 'allowed', by: 'a#b' }
    ],
    ['deny', verdict(false, 'p#0', 'deny', 'deny'), 'path', true, { kind: 'denied', by: 'p' }],
    [
      '普通 ask + 审查开着 + path',
      verdict(false, 'p#1', 'ask', 'ask'),
      'path',
      true,
      { kind: 'review', by: 'p' }
    ],
    [
      '普通 ask + 审查关着',
      verdict(false, 'p#1', 'ask', 'ask'),
      'path',
      false,
      { kind: 'stops', by: 'p' }
    ],
    [
      'force-ask + 审查开着',
      verdict(false, 'p#1', 'ask', 'force-ask'),
      'path',
      true,
      { kind: 'stops', by: 'p' }
    ],
    [
      '普通 ask + session',
      verdict(false, 'p#1', 'ask', 'ask'),
      'session',
      true,
      { kind: 'stops', by: 'p' }
    ],
    [
      '普通 ask + widget',
      verdict(false, 'p#1', 'ask', 'ask'),
      'widget',
      true,
      { kind: 'stops', by: 'p' }
    ]
  ])('AC-4 %s', (_label, v, type, review, expected) => {
    expect(accessOutcomeOf(v, type, review)).toEqual(expected)
  })
})

// ─────────────────────────── 回执文字 ───────────────────────────

describe('AC-5 / AC-6 没有策略点名它', () => {
  it('AC-5 逐字：临时文件夹、审查开着、身份是 UUID', () => {
    expect(noteOf()).toBe(
      [
        'Unattended access check for bot xiaozhou (scheduled runs have nobody to answer asks; as run in a temporary folder):',
        '- read other sessions: asks (ask-on-session-access; only the user can answer, so the run would stop).',
        '- send messages into other sessions: asks (ask-on-session-access; only the user can answer, so the run would stop).',
        '- elsewhere: read a file in the home folder outside its working folder, write there, write outside the home folder: asks (ask-on-external-path; the automatic review answers at run time and may refuse).',
        "In a policy this bot is `subject.bot == '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'` (its shuvix-id). No policy names it.",
        'A run that asks something only the user can answer waits until they come back, and that binding’s next firings are skipped while it waits.',
        "If the bot’s job needs any of the above, tell the user what it needs and why, and offer a companion policy for this bot, the way the diary bot has daily-bot-access: one `force-allow` rule per need (a plain `allow` does not override an ask), each matching `has(subject.bot) && subject.bot == '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10' && subject.agentKind == 'root'` plus the narrowest condition on the object; the policy-md manual entry has the template. Write it into ~/.shuvix/policies/ only after the user agrees — the result of that write checks the bot again."
      ].join('\n')
    )
  })

  it('AC-6 审查关着：每个询问都只有用户能答；elsewhere 合成一句；会停那句在', () => {
    const out = noteOf({ review: false })
    expect(lines(out).slice(0, 4)).toEqual([
      HEADER('a temporary folder'),
      `- read other sessions: ${STOPS('ask-on-session-access')}.`,
      `- send messages into other sessions: ${STOPS('ask-on-session-access')}.`,
      '- elsewhere: read a file in the home folder outside its working folder, write there, write outside the home ' +
        `folder: ${STOPS('ask-on-external-path')}.`
    ])
    expect(count(out, '- elsewhere:')).toBe(1)
    expect(out).not.toContain('automatic review')
    expect(count(out, STOP_LINE)).toBe(1)
  })
})

/** 手册（en policy-md「Loosening and tightening」）里那份配套策略模板的原文 */
function manualTemplate(): string {
  const md = readFileSync(
    resolve(REPO_ROOT, 'apps/desktop/resources/knowledge/shuvix/en/policy-md.md'),
    'utf-8'
  )
  const block = [...md.matchAll(/```markdown\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .find((b) => b.includes('name: xiaozhou-access'))
  if (!block) throw new Error('the xiaozhou-access template is not in en/policy-md.md')
  return block
}

function parseTemplate(text: string): UserPolicyFile {
  const parsed = parsePolicyDefinitionFile(text, 'xiaozhou-access')
  if (!parsed) throw new Error('template does not parse')
  return { ...parsed, fileName: 'xiaozhou-access.md' }
}

describe('AC-7 / AC-8 手册里的模板', () => {
  it('AC-7 原样装上：会话读放行、发消息会停、那份笔记读写放行；没有 also allowed、没有建议', () => {
    const template = parseTemplate(manualTemplate())
    const out = noteOf({ identity: 'xiaozhou', identityFrom: 'name', users: [template] })
    expect(lines(out)).toEqual([
      HEADER('a temporary folder'),
      '- read other sessions: allowed (xiaozhou-access).',
      `- send messages into other sessions: ${STOPS('ask-on-session-access')}.`,
      '- ~/notes/daily-summary.md: read and write allowed (xiaozhou-access).',
      ELSEWHERE_REVIEW,
      "In a policy this bot is `subject.bot == 'xiaozhou'` — it has no shuvix-id, so policies know it by its " +
        'name and renaming the bot breaks them. Policies that name it: xiaozhou-access.',
      STOP_LINE
    ])
    expect(out).not.toContain('also allowed')
    expect(out).not.toContain('companion policy')
    expect(out).not.toContain('plain `allow`')
  })

  it('AC-8 写成 `allow`：照样要问；普通 allow 那一行逐条列出', () => {
    const text = manualTemplate().replace(/effect: force-allow/g, 'effect: allow')
    expect(text).not.toContain('force-allow')
    const out = noteOf({ identity: 'xiaozhou', identityFrom: 'name', users: [parseTemplate(text)] })
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    expect(out).toContain(
      `- ~/notes/daily-summary.md: read and write ${REVIEW('ask-on-external-path')}.`
    )
    expect(out).toContain(
      'A plain `allow` never overrides an ask, so these rules change nothing above: xiaozhou-access rule #0, ' +
        'xiaozhou-access rule #1 — write `force-allow`.'
    )
    expect(out).toContain('Policies that name it: xiaozhou-access.')
  })
})

describe('AC-9 / AC-10 放得比点名的宽', () => {
  it('AC-9 整个家目录 → also allowed 列出家目录里的读写；elsewhere 只剩家目录外的写', () => {
    const wide = policy('wide', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && inDir(object.path, vars.home)`
      )
    ])
    const out = noteOf({ users: [wide] })
    expect(out).toContain(
      `- elsewhere: write outside the home folder: ${REVIEW('ask-on-external-path')}.`
    )
    expect(out).toContain(
      '- also allowed, beyond the paths its policies name: read a file in the home folder outside its working ' +
        'folder (wide); write there (wide). Narrow the policy unless the user wants that.'
    )
    expect(out).toContain('Policies that name it: wide.')
  })

  it('AC-9 没有客体条件的 force-allow → 三条都在 also allowed、没有 elsewhere；会话也放行', () => {
    const all = policy('all', [rule('force-allow', {}, guard(UUID))])
    const out = noteOf({ users: [all] })
    expect(out).toContain('- read other sessions: allowed (all).')
    expect(out).toContain('- send messages into other sessions: allowed (all).')
    expect(out).not.toContain('- elsewhere:')
    expect(out).toContain(
      '- also allowed, beyond the paths its policies name: read a file in the home folder outside its working ' +
        'folder (all); write there (all); write outside the home folder (all). Narrow the policy unless the user ' +
        'wants that.'
    )
    expect(out).not.toContain(STOP_LINE)
  })

  it('AC-10 startsWith 写法连旁边的 `notes-…` 文件夹都放行 → 报出来；inDir 写法不会', () => {
    const loose = policy('loose', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && object.path.startsWith('/Users/u/notes')`
      )
    ])
    const out = noteOf({ users: [loose], dirs: ['/Users/u/notes'] })
    expect(out).toContain('- files in ~/notes/: read and write allowed (loose).')
    expect(out).toContain(
      '- also allowed, beyond the paths its policies name: read ~/notes-shuvix-access-check/shuvix-access-check.md ' +
        '(loose); write ~/notes-shuvix-access-check/shuvix-access-check.md (loose). Narrow the policy unless the ' +
        'user wants that.'
    )

    const tight = policy('tight', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && inDir(object.path, '/Users/u/notes')`
      )
    ])
    const control = noteOf({ users: [tight] })
    expect(control).toContain('- files in ~/notes/: read and write allowed (tight).')
    expect(control).not.toContain('also allowed')
  })

  it('AC-10 点名一个文件、规则却放行整个文件夹 → 报同一文件夹里旁边的文件', () => {
    const folder = policy('folder', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && (object.path == vars.home + '/notes/a.md' || inDir(object.path, vars.home + '/notes'))`
      )
    ])
    const out = noteOf({ users: [folder] })
    expect(out).toContain('- ~/notes/a.md: read and write allowed (folder).')
    expect(out).toContain('read ~/notes/shuvix-access-check-other.md (folder)')
    expect(out).toContain('write ~/notes/shuvix-access-check-other.md (folder)')
    // 文件夹本身旁边的那个（~/notes-shuvix-access-check/…）不在里面
    expect(out).not.toContain('notes-shuvix-access-check')
  })
})

describe('AC-11 / AC-12 force-ask、deny 与日记 bot', () => {
  it('AC-11 用户的 force-ask 点名路径 → 审查开着也会停；deny → denied', () => {
    const askMe = policy('ask-me', [
      rule(
        'force-ask',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && object.path == '/Users/u/notes/a.md'`
      )
    ])
    const asked = noteOf({ users: [askMe], review: true })
    expect(asked).toContain(`- ~/notes/a.md: read and write ${STOPS('ask-me')}.`)
    expect(asked).toContain(STOP_LINE)

    const never = policy('never', [
      rule(
        'deny',
        { 'object.type': ['path'], action: ['read', 'write'] },
        `${guard(UUID)} && object.path == '/Users/u/notes/a.md'`
      )
    ])
    expect(noteOf({ users: [never] })).toContain('- ~/notes/a.md: read and write denied (never).')
  })

  it('AC-12 日记 bot 与真实的内置 daily-bot-access：会话读放行、发消息会停、日记文件夹读放行写交审查；没有建议', () => {
    const identity = 'bot:builtin:daily'
    const out = noteOf({ identity, botName: 'daily' })
    expect(lines(out)).toEqual([
      HEADER('a temporary folder', 'daily'),
      '- read other sessions: allowed (daily-bot-access).',
      `- send messages into other sessions: ${STOPS('ask-on-session-access')}.`,
      `- files in ~/.shuvix/daily/: read allowed (daily-bot-access); write ${REVIEW('ask-on-external-path')}.`,
      ELSEWHERE_REVIEW,
      "In a policy this bot is `subject.bot == 'bot:builtin:daily'` (its shuvix-id). Policies that name it: " +
        'daily-bot-access.',
      STOP_LINE
    ])
  })
})

describe('AC-13 / AC-14 试探了什么', () => {
  it('AC-13 会话只在此刻试一次：每个位置恰一读一写，客体逐字（lastActiveAt = 这个位置的 vars.now）', () => {
    const loc = engineLocation()
    noteOf({ locations: [loc] })
    const sessions = loc.calls.filter((c) => c.object.type === 'session')
    expect(sessions.map((c) => c.action)).toEqual(['read', 'write'])
    for (const c of sessions) {
      expect(c.object).toEqual({
        type: 'session',
        sessionId: 'shuvix-access-check',
        title: '',
        ownTurn: false,
        lastActiveAt: NOW,
        bot: ''
      })
    }
  })

  it('AC-13 按最近 24 小时放行的规则 → allowed', () => {
    const recent = policy('recent', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        `${guard(UUID)} && timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('24h')`
      )
    ])
    expect(noteOf({ users: [recent] })).toContain('- read other sessions: allowed (recent).')
  })

  it('AC-13 位置的 vars.now 不是字符串 → lastActiveAt 用 input.now', () => {
    const loc = fakeLocation(undefined, { vars: { home: HOME, now: 1234 } })
    noteOf({ locations: [loc], naming: [] })
    const session = loc.calls.find((c) => c.object.type === 'session')!
    expect(session.object).toMatchObject({ lastActiveAt: new Date(NOW).toISOString() })
  })

  it('AC-14 试探的全集、顺序与带的工具（一个点名文件夹、一个点名文件）', () => {
    const loc = fakeLocation()
    noteOf({
      locations: [loc],
      naming: [
        bare('p', ["inDir(object.path, '/Users/u/notes') || object.path == '/Users/u/docs/a.md'"])
      ]
    })
    const read = { name: 'read' }
    const write = { name: 'write' }
    expect(
      loc.calls.map((c) => [
        c.action,
        c.object.type === 'session' ? 'session' : c.object.path,
        c.tool
      ])
    ).toEqual([
      ['read', 'session', { name: 'session', operation: 'read-session' }],
      ['write', 'session', { name: 'session', operation: 'prompt-session' }],
      ['read', '/Users/u/notes/shuvix-access-check.md', read],
      ['write', '/Users/u/notes/shuvix-access-check.md', write],
      ['read', '/Users/u/notes-shuvix-access-check/shuvix-access-check.md', read],
      ['write', '/Users/u/notes-shuvix-access-check/shuvix-access-check.md', write],
      ['read', '/Users/u/docs/a.md', read],
      ['write', '/Users/u/docs/a.md', write],
      ['read', '/Users/u/docs/shuvix-access-check-other.md', read],
      ['write', '/Users/u/docs/shuvix-access-check-other.md', write],
      ['read', '/Users/u/shuvix-access-check/shuvix-access-check.md', read],
      ['write', '/Users/u/shuvix-access-check/shuvix-access-check.md', write],
      ['write', '/shuvix-access-check/shuvix-access-check.md', write]
    ])
    // 路径客体的形状
    expect(loc.calls[2].object).toEqual({
      type: 'path',
      path: '/Users/u/notes/shuvix-access-check.md',
      displayPath: '/Users/u/notes/shuvix-access-check.md'
    })
  })

  it('AC-14 旁边那份停在询问上也不算「会停」（只在被放行时才报）', () => {
    const beside = (o: SecurityObject): boolean =>
      o.type === 'path' &&
      (String(o.path).includes('shuvix-access-check-other') ||
        String(o.path).includes('notes-shuvix-access-check'))
    const loc = fakeLocation((_a, o) =>
      beside(o) ? verdict(false, 'p#0', 'ask', 'force-ask') : ALLOW
    )
    const out = noteOf({
      locations: [loc],
      naming: [
        bare('p', ["inDir(object.path, '/Users/u/notes') || object.path == '/Users/u/docs/a.md'"])
      ]
    })
    expect(loc.calls.some((c) => beside(c.object))).toBe(true)
    expect(out).not.toContain(STOP_LINE)
    expect(out).not.toContain('also allowed')
    expect(out).not.toContain('only the user can answer')
  })
})

describe('AC-15 几个位置', () => {
  it('AC-15 结果相同 → 合成一节；身份、会停、建议各一次', () => {
    const out = noteOf({
      locations: [
        engineLocation({ label: 'project tiny-cli' }),
        engineLocation({ label: 'a temporary folder', workdir: '/Users/u/tmp/ws' })
      ]
    })
    expect(count(out, 'Unattended access check for bot')).toBe(1)
    expect(lines(out)[0]).toBe(HEADER('project tiny-cli or a temporary folder'))
    expect(count(out, 'In a policy this bot is')).toBe(1)
    expect(count(out, STOP_LINE)).toBe(1)
    expect(count(out, 'companion policy')).toBe(1)
  })

  it('AC-15 结果不同 → 两节（按位置的 vars.workspace 算点名路径）；身份与会停只出现一次', () => {
    const out = policy('out', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['write'] },
        `${guard(UUID)} && object.path == vars.workspace + '/out.md'`
      )
    ])
    const a = engineLocation({ label: 'project a', workdir: '/Users/u/work/a', users: [out] })
    const b = engineLocation({ label: 'project b', workdir: '/Users/u/work/b', users: [out] })
    const text = noteOf({ users: [out], locations: [a, b] })
    expect(count(text, 'Unattended access check for bot')).toBe(2)
    expect(text).toContain(HEADER('project a'))
    expect(text).toContain(HEADER('project b'))
    expect(text).toContain('- ~/work/a/out.md: read allowed (nothing asks); write allowed (out).')
    expect(text).toContain('- ~/work/b/out.md: read allowed (nothing asks); write allowed (out).')
    expect(text.indexOf(HEADER('project a'))).toBeLessThan(text.indexOf('~/work/a/out.md'))
    expect(text.indexOf(HEADER('project b'))).toBeLessThan(text.indexOf('~/work/b/out.md'))
    expect(text.indexOf('~/work/a/out.md')).toBeLessThan(text.indexOf(HEADER('project b')))
    // 每个位置只试它自己的那份
    const paths = (t: Trial): string[] => t.calls.map((c) => String(c.object.path ?? ''))
    expect(paths(a)).toContain('/Users/u/work/a/out.md')
    expect(paths(a)).not.toContain('/Users/u/work/b/out.md')
    expect(paths(b)).toContain('/Users/u/work/b/out.md')
    expect(paths(b)).not.toContain('/Users/u/work/a/out.md')
    expect(count(text, 'In a policy this bot is')).toBe(1)
    expect(count(text, STOP_LINE)).toBe(1)
    expect(text).not.toContain('companion policy')
  })

  it('AC-15 没有策略点名、两节不同 → 建议只出现一次，在最后几行', () => {
    const out = noteOf({
      naming: [],
      locations: [
        engineLocation({ label: 'project a' }),
        fakeLocation(undefined, { label: 'project b' })
      ]
    })
    expect(count(out, 'Unattended access check for bot')).toBe(2)
    expect(count(out, 'companion policy')).toBe(1)
    expect(lines(out).at(-1)).toContain('companion policy')
  })
})

describe('AC-16 / AC-20 身份的说法与转义', () => {
  it('AC-16 identityFrom name / untrusted-id', () => {
    expect(noteOf({ identity: 'xiaozhou', identityFrom: 'name' })).toContain(
      "In a policy this bot is `subject.bot == 'xiaozhou'` — it has no shuvix-id, so policies know it by its name " +
        'and renaming the bot breaks them. No policy names it.'
    )
    expect(noteOf({ identity: 'xiaozhou', identityFrom: 'untrusted-id' })).toContain(
      "In a policy this bot is `subject.bot == 'xiaozhou'` — its shuvix-id is a built-in form that only the bot " +
        'file ShuviX wrote may carry, so policies know it by its name and renaming the bot breaks them. No policy ' +
        'names it.'
    )
  })

  it("AC-20 celQuote：`'` 与 `\\` 都转义", () => {
    expect(celQuote('plain')).toBe("'plain'")
    expect(celQuote("o'brien")).toBe("'o\\'brien'")
    expect(celQuote('a\\b')).toBe("'a\\\\b'")
    expect(celQuote("a\\'b")).toBe("'a\\\\\\'b'")
  })

  it('AC-20 身份带引号：身份那一行与建议里的条件都按 CEL 字符串写', () => {
    const out = noteOf({ identity: "o'brien", identityFrom: 'name', botName: "o'brien" })
    expect(out).toContain(
      "In a policy this bot is `subject.bot == 'o\\'brien'` — it has no shuvix-id"
    )
    expect(out).toContain(
      "each matching `has(subject.bot) && subject.bot == 'o\\'brien' && subject.agentKind == 'root'`"
    )
  })
})

describe('AC-17 求值告警', () => {
  const WARN_HEAD =
    'Some rules failed to evaluate (a failing allow or force-allow rule grants nothing; a failing ask or deny rule ' +
    'still applies): '
  const engineWarning = (id: string, err: string, tail = 'treating as not matched'): string =>
    `security rule '${id}': match evaluation failed (${err}), ${tail}`

  it('AC-17 引擎格式 → `<id> (<错误第一行>) — treating as …`；多行 CEL 错误只要第一行；别的告警取第一行', () => {
    const out = noteOf({
      locations: [fakeLocation()],
      naming: [],
      warnings: [
        engineWarning('p#0', 'No such key: typo\n> 1 | vars.typo\n         ^'),
        engineWarning('q#1', 'boom', 'treating as matched (fail-safe)'),
        "security policy 'r': vars.typo is not provided by the host; inDir treats it as no directory\nsecond line"
      ]
    })
    const line = lines(out).find((l) => l.startsWith('Some rules failed'))
    expect(line).toBe(
      `${WARN_HEAD}p#0 (No such key: typo) — treating as not matched; q#1 (boom) — treating as matched (fail-safe); ` +
        "security policy 'r': vars.typo is not provided by the host; inDir treats it as no directory."
    )
    expect(count(out, 'Some rules failed')).toBe(1)
  })

  it('AC-17 去重，至多 3 条', () => {
    const w = engineWarning('p#0', 'x')
    const out = noteOf({
      locations: [fakeLocation()],
      naming: [],
      warnings: [
        w,
        w,
        engineWarning('a#0', '1'),
        engineWarning('b#0', '2'),
        engineWarning('c#0', '3')
      ]
    })
    const line = lines(out).find((l) => l.startsWith('Some rules failed'))!
    expect(line).toBe(
      `${WARN_HEAD}p#0 (x) — treating as not matched; a#0 (1) — treating as not matched; ` +
        'b#0 (2) — treating as not matched.'
    )
  })

  it('AC-17 真实引擎：求值出错的规则照实报', () => {
    const broken = policy('broken', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        `${guard(UUID)} && timestamp('nope') > timestamp(vars.now)`
      )
    ])
    const out = noteOf({ users: [broken] })
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    const line = lines(out).find((l) => l.startsWith('Some rules failed'))
    expect(line).toBeDefined()
    expect(line!.startsWith(`${WARN_HEAD}broken#0 (`)).toBe(true)
    expect(line!.endsWith(') — treating as not matched.')).toBe(true)
    expect(line).not.toContain('\n')
  })

  it('AC-17 没有告警 → 没有那一行', () => {
    expect(noteOf()).not.toContain('Some rules failed')
    expect(noteOf({ locations: [fakeLocation()], naming: [], warnings: [] })).not.toContain(
      'Some rules failed'
    )
  })
})

describe('AC-18 Windows', () => {
  it('AC-18 样例路径用 `\\`、根是 C:\\；说法是 `~\\…`', () => {
    const calls: Probe[] = []
    const loc: BotAccessLocation = {
      label: 'a temporary folder',
      judge: (action, object, tool) => {
        calls.push({ action, object, tool })
        return ALLOW
      }
    }
    const out = botAccessNote({
      botName: 'xiaozhou',
      identity: UUID,
      identityFrom: 'id',
      naming: [
        bare('p', [
          "object.path == 'C:\\\\Users\\\\u\\\\notes\\\\a.md' || inDir(object.path, 'C:\\\\Users\\\\u\\\\x')"
        ])
      ],
      locations: [loc],
      reviewActive: true,
      host: host({ home: 'C:\\Users\\u', root: 'C:\\', sep: '\\', vars: {} }),
      policiesDirLabel: '~\\.shuvix\\policies\\',
      now: new Date(NOW)
    })
    const paths = calls.map((c) => c.object.path).filter(Boolean)
    expect(paths).toContain('C:\\Users\\u\\shuvix-access-check\\shuvix-access-check.md')
    expect(paths).toContain('C:\\shuvix-access-check\\shuvix-access-check.md')
    expect(paths).toContain('C:\\Users\\u\\notes\\shuvix-access-check-other.md')
    expect(paths).toContain('C:\\Users\\u\\x\\shuvix-access-check.md')
    expect(paths).toContain('C:\\Users\\u\\x-shuvix-access-check\\shuvix-access-check.md')
    expect(out).toContain('- ~\\notes\\a.md: read and write allowed (nothing asks).')
    expect(out).toContain('- files in ~\\x\\: read and write allowed (nothing asks).')
  })
})

describe('AC-19 / AC-21', () => {
  it('AC-19 点名路径多于 6 个 → 「1 more path … was not checked」；2 个 → paths / were', () => {
    const seven = bare(
      'p',
      Array.from({ length: 7 }, (_v, i) => `object.path == '/data/f${i}.md'`)
    )
    const one = noteOf({ locations: [fakeLocation()], naming: [seven] })
    expect(one).toContain('- 1 more path named in its policies was not checked.')
    expect(count(one, '- /data/f')).toBe(6)

    const eight = bare(
      'p',
      Array.from({ length: 8 }, (_v, i) => `object.path == '/data/f${i}.md'`)
    )
    expect(noteOf({ locations: [fakeLocation()], naming: [eight] })).toContain(
      '- 2 more paths named in its policies were not checked.'
    )
    expect(
      noteOf({ locations: [fakeLocation()], naming: [bare('p', ["object.path == '/data/a.md'"])] })
    ).not.toContain('not checked')
  })

  it('AC-21 按 `tool.name: [write]` 收窄的 force-allow：核对里写放行、读照问', () => {
    const writeOnly = policy('write-only', [
      rule(
        'force-allow',
        { 'object.type': ['path'], action: ['read', 'write'], 'tool.name': ['write'] },
        `${guard(UUID)} && object.path == '/Users/u/notes/a.md'`
      )
    ])
    expect(noteOf({ users: [writeOnly] })).toContain(
      `- ~/notes/a.md: read ${REVIEW('ask-on-external-path')}; write allowed (write-only).`
    )
  })

  it('AC-22 按 object.sessionId 放行会话（真模型演练里写出过）：照问，并说清为什么盖不住之后的运行', () => {
    const byId = policy('by-id', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        `${guard(UUID)} && object.sessionId in ['01a1951c-d694-760f-976f-4463f1cef665']`
      ),
      // ask / deny 按 id 指名是正常用法（挡住某一场会话），不提
      rule(
        'ask',
        { 'object.type': ['session'], action: ['write'] },
        `${guard(UUID)} && object.sessionId == 's1'`
      )
    ])
    const out = noteOf({ users: [byId] })
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    expect(out).toContain(
      'These rules pick sessions by `object.sessionId`: by-id rule #0. A scheduled run reads sessions that do not ' +
        'exist yet when the policy is written (the check above uses a new one), so a list of ids never covers ' +
        'them — match by age (`object.lastActiveAt`) or leave the session condition out.'
    )
    expect(out).not.toContain('by-id rule #1')
    // 手册的模板不按 id 放行：没有这一句
    expect(
      noteOf({
        identity: 'xiaozhou',
        identityFrom: 'name',
        users: [parseTemplate(manualTemplate())]
      })
    ).not.toContain('object.sessionId')
  })
})
