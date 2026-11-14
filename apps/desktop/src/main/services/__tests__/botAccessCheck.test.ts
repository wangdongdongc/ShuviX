/**
 * bot 定时运行权限核对的宿主一侧（services/botAccessCheck，设计稿 docs/bot-access-check-design.md）—— 认出 bot 在哪些
 * 位置定时跑、此刻生效的策略里哪些点名了它，给每个位置搭一个试算上下文交给 agent-runtime 的 botAccessNote。
 * 文字本身由 agent-runtime 的 accessCheck.test 逐字钉住；这里钉的是宿主的取舍与接线。
 *
 * deps 全是替身，只有 `trial` 搭的是**真实引擎**（createSecurityContext + 内联的内置策略，形状同
 * toolContext.getDesktopBotRunTrial：bot 的根 agent、派生的那几行权限表、按调用方给的用户策略与 logger 判），并且
 * 与 deps.isDisabled 用同一份停用表。
 *
 * 契约（botAccessCheck.ts 文件头 + 2026-10-31 的裁定）：
 *  - 只有真会无人值守地跑的绑定算（埋点在这个版本上存在、且是全局的 —— 今天就是 timer.fired）；
 *  - 位置：没写 project → 临时文件夹（工作目录 = temporaryWorkspace()）；写了 → 恰好对上一个项目才算（说法用项目的
 *    真名），对不上 / 对上几个的那条不跑；同一个项目只算一次；权限表 = aclDir(工作目录)、aclDir(bot 文件)、项目的
 *    再加 aclDir(项目知识库)，aclDir 回 null 的丢掉；
 *  - 身份 = identityForFile(解析出的文件, 绝对路径)；说法：没有 id → name；身份就是 id → id；否则 untrusted-id；
 *  - 点名：内置 + 用户，按名字遮蔽（用户的顶替内置的、同名的几份只算胜出那份），停用的不算（也不放行）；
 *  - forPolicyFile 按「装进策略目录 fileName」算（顶替同文件名那份，别的照旧）；每个被点名的身份一段：不认识的、按
 *    名字写了却有 shuvix-id 的、没有定时的、没有能跑的位置的，各一句；
 *  - forBotName：按名字或身份找（去掉两头空白）；可带一份按装进去之后算的策略；
 *  - reviewActive / userPolicies 每次现读；求值告警（含「vars.x 宿主没给」）照实报给 agent。
 *
 *   BAC-1  forBotFile → null：解析不过、没有绑定 / 空列表、只有惰性埋点、每条绑定的 project 对上 0 / 2 个；trial 一次都不调
 *   BAC-2  位置：临时文件夹、项目（真名、知识库那一行）、aclDir 回 null 丢掉、acme / ACME 同一个项目只算一次、两个位置两次
 *          试算；试算拿到身份与核对自己的 logger
 *   BAC-3  身份：identityForFile 的参数；三种说法
 *   BAC-4  点名：用户的同名文件顶替内置、同名的第二份不算、停用的不算（于是有建议）
 *   BAC-5  forPolicyFile 按装进去之后算；别的文件照旧；非法 / 没有点名 → null
 *   BAC-6  每个身份一段：拼错的、按名字写了却有 id 的、没有定时的、两个身份、两份同 id 的 bot、带引号的身份
 *   BAC-7  点名的 bot 没有能跑的位置 → 「none of its bindings names exactly one project」
 *   BAC-8  forBotName：按名字 / 身份、去空白；不认识 → error；带策略 → 开头一句；非法策略 → error；没有定时 / 没有位置
 *   BAC-9  告警：`vars.typo`（宿主没给）与求值出错的规则都进告警那一行
 *   BAC-10 reviewActive 每次现读
 *   BAC-11 userPolicies 每次现读；试算交回的 vars 决定点名路径（vars.dailyDir）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBuiltinPolicies,
  createSecurityContext,
  parseBotDefinitionFile,
  parsePolicyDefinitionFile,
  type ParsedBotFile,
  type SecurityHostProvider,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import { createBotAccessChecker, type BotAccessDeps } from '../botAccessCheck'

const READ_MD = createInlinePolicyMdReader()
const HOME = '/Users/u'
const BOTS = '/Users/u/.shuvix/bots'
const TEMP = '/Users/u/Library/Application Support/shuvix/temp_workspace/shuvix-access-check'
const KB = (id: string): string => `/Users/u/.shuvix/knowledge-shuvix/projects/${id}`
const NOW = '2026-10-31T10:00:00.000Z'
const DAILY_DIR = '/Users/u/.shuvix/daily'
const UUID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const DAILY_ID = 'bot:builtin:daily'

// ─────────────────────────── 夹具 ───────────────────────────

const state = {
  bots: [] as Array<{ file: ParsedBotFile; basePath: string }>,
  users: [] as UserPolicyFile[],
  disabled: new Set<string>(),
  review: true,
  projects: [] as Array<{ id: string; name: string; path: string }>,
  dirs: new Set<string>(),
  /** 内置 id → ShuviX 写下的那份文件（botService 的认定表） */
  trusted: {} as Record<string, string>,
  /** 试算里额外喊一句的 logger 告警（看 logger 是不是核对自己那份） */
  trialWarning: null as string | null,
  /** bot 名 → 它自己的知识库目录（没写的 bot 没有库） */
  botKnowledgeDirs: new Map<string, string>()
}

type RunArg = Parameters<BotAccessDeps['trial']>[0]
type TrialArg = Parameters<BotAccessDeps['trial']>[1]

/** 一次定时运行的试算：真实引擎，形状同 getDesktopBotRunTrial */
function engineTrial(run: RunArg, trial: TrialArg): ReturnType<BotAccessDeps['trial']> {
  if (state.trialWarning) trial.logger.warn(state.trialWarning)
  const vars = {
    home: HOME,
    workspace: run.workingDirectory,
    toolResultsBase: '/Users/u/Library/Application Support/shuvix/tool_results',
    skillsDirs: [],
    botsDir: BOTS,
    shuvixConfigDirs: [],
    builtinKnowledgeDir: '/Applications/ShuviX.app/Contents/Resources/knowledge',
    sessionArtifactsDir: '',
    systemDirs: [],
    now: NOW,
    dailyDir: DAILY_DIR,
    trackingDir: '/Users/u/.shuvix/tracking',
    aclRead: run.aclRead,
    aclWrite: run.aclWrite,
    aclSessionRead: [],
    aclSessionWrite: [],
    aclWidgetRead: [],
    aclWidgetWrite: []
  }
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => vars,
    readBuiltinPolicyMd: READ_MD,
    getUserPolicies: () => trial.userPolicies,
    isPolicyDisabled: (p) => state.disabled.has(p.name),
    logger: trial.logger
  }
  const context = createSecurityContext(
    {
      kind: 'agent',
      sessionId: '',
      agentKind: 'root',
      profileName: 'bot',
      attrs: { bot: run.bot }
    },
    { host: 'desktop', platform: 'darwin', workspaceDir: run.workingDirectory },
    provider
  )
  return { context, vars }
}

const deps = {
  identityForFile: vi.fn((file: Pick<ParsedBotFile, 'name' | 'objectId'>, basePath: string) => {
    const id = file.objectId ?? file.name
    if (id.startsWith('bot:builtin:') && state.trusted[id] !== basePath) return file.name
    return id
  }),
  projectsNamed: vi.fn((name: string) =>
    state.projects.filter((p) => p.name.toLowerCase() === name.toLowerCase())
  ),
  aclDir: vi.fn((dir: string): string | null => (dir === '/' || dir === HOME ? null : dir)),
  userPolicies: vi.fn(() => state.users),
  reviewActive: vi.fn(() => state.review),
  trial: vi.fn(engineTrial)
}

const checker = createBotAccessChecker({
  home: HOME,
  root: '/',
  sep: '/',
  policiesDirLabel: '~/.shuvix/policies/',
  bots: () => state.bots,
  identityForFile: deps.identityForFile,
  projectsNamed: deps.projectsNamed,
  projectKnowledgeDir: KB,
  botKnowledgeDir: (file) => state.botKnowledgeDirs.get(file.name) ?? null,
  temporaryWorkspace: () => TEMP,
  aclDir: deps.aclDir,
  userPolicies: deps.userPolicies,
  builtinPolicies: () => buildBuiltinPolicies({ language: 'en', readMd: READ_MD }),
  isDisabled: (p) => state.disabled.has(p.name),
  reviewActive: deps.reviewActive,
  isDirectory: (p) => state.dirs.has(p),
  trial: deps.trial
})

beforeEach(() => {
  state.botKnowledgeDirs = new Map()
  state.bots = []
  state.users = []
  state.disabled = new Set()
  state.review = true
  state.projects = []
  state.dirs = new Set()
  state.trusted = {}
  state.trialWarning = null
  for (const fn of Object.values(deps)) fn.mockClear()
})

/** 一条绑定的 YAML 行（缺省 timer.fired 每天 20:00） */
function binding(opts: { trigger?: string; project?: string } = {}): string[] {
  return [
    `  - trigger: ${opts.trigger ?? 'timer.fired'}`,
    `    when: "event.local.time == '20:00'"`,
    '    message: Evening check-in.',
    ...(opts.project === undefined ? [] : [`    project: ${opts.project}`])
  ]
}

/** 一份 bot 文件；bindings = null → 不写 shuvix-bot-on */
function botText(name: string, opts: { id?: string; bindings?: string[][] | null } = {}): string {
  const bindings = opts.bindings === undefined ? [binding()] : opts.bindings
  return [
    '---',
    'shuvix: bot v2',
    ...(opts.id ? [`shuvix-id: ${opts.id}`] : []),
    `name: ${name}`,
    ...(bindings === null
      ? []
      : bindings.length === 0
        ? ['shuvix-bot-on: []']
        : ['shuvix-bot-on:', ...bindings.flat()]),
    '---',
    '',
    'Persona.',
    ''
  ].join('\n')
}

const pathOf = (name: string): string => `${BOTS}/${name}.md`

/** 一份已在注册表里的 bot */
function registerBot(
  name: string,
  opts: Parameters<typeof botText>[1] = {},
  basePath = pathOf(name)
): { file: ParsedBotFile; basePath: string } {
  const file = parseBotDefinitionFile(botText(name, opts), name)
  if (!file) throw new Error(`fixture bot ${name} does not parse`)
  state.bots.push({ file, basePath })
  return { file, basePath }
}

/** 一份策略的 md 原文；rules 是 `- effect …` 起的那几段 YAML 行 */
function policyText(name: string, rules: string[][]): string {
  return [
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
}

function userPolicy(text: string, fileName: string): UserPolicyFile {
  const parsed = parsePolicyDefinitionFile(text, fileName.replace(/\.md$/, ''))
  if (!parsed) throw new Error(`fixture policy ${fileName} does not parse`)
  return { ...parsed, fileName }
}

function rule(effect: string, conditions: Record<string, string[]>, match: string): string[] {
  return [
    `  - effect: ${effect}`,
    ...Object.entries(conditions).map(([k, v]) => `    ${k}: [${v.join(', ')}]`),
    '    match: >-',
    `      ${match}`
  ]
}

const guard = (identity: string): string =>
  `has(subject.bot) && subject.bot == '${identity}' && subject.agentKind == 'root'`
const sessionRead = (identity: string, effect = 'force-allow'): string[] =>
  rule(effect, { 'object.type': ['session'], action: ['read'] }, guard(identity))
const pathRule = (identity: string, path: string, effect = 'force-allow'): string[] =>
  rule(
    effect,
    { 'object.type': ['path'], action: ['read', 'write'] },
    `${guard(identity)} && object.path == '${path}'`
  )

const HEADER = (name: string, where: string): string =>
  `Unattended access check for bot ${name} (scheduled runs have nobody to answer asks; as run in ${where}):`
const STOPS = (by: string): string =>
  `asks (${by}; only the user can answer, so the run would stop)`
const REVIEW = (by: string): string =>
  `asks (${by}; the automatic review answers at run time and may refuse)`
const NO_SCHEDULE = (name: string): string =>
  `Bot ${name} has no schedule (shuvix-bot-on), so nothing of it runs unattended; in its chats asks reach the ` +
  'user as usual.'
const NOWHERE = (name: string): string =>
  `Bot ${name}: none of its bindings names exactly one project, so every run would be skipped and nothing of it ` +
  'runs unattended.'
const count = (text: string, part: string): number => text.split(part).length - 1

// ─────────────────────────── forBotFile ───────────────────────────

describe('BAC-1 forBotFile → null', () => {
  it.each([
    ['解析不过', '---\nname: [unclosed\n---\n'],
    ['没有 shuvix-bot-on', botText('buddy', { bindings: null })],
    ['空列表', botText('buddy', { bindings: [] })],
    [
      '只有惰性埋点（这个版本上不存在）',
      botText('buddy', { bindings: [binding({ trigger: 'no.such.trigger' })] })
    ]
  ])('BAC-1 %s → null，不试算', (_label, text) => {
    expect(checker.forBotFile(text, pathOf('buddy'))).toBeNull()
    expect(deps.trial).not.toHaveBeenCalled()
  })

  it('BAC-1 每条绑定的 project 都对不上恰好一个项目（0 个 / 2 个）→ null，不试算', () => {
    state.projects = [
      { id: 'p1', name: 'Acme', path: '/Users/u/work/acme' },
      { id: 'p2', name: 'acme', path: '/Users/u/work/acme2' }
    ]
    const text = botText('buddy', {
      bindings: [binding({ project: 'ghost' }), binding({ project: 'acme' })]
    })
    expect(checker.forBotFile(text, pathOf('buddy'))).toBeNull()
    expect(deps.projectsNamed.mock.calls).toEqual([['ghost'], ['acme']])
    expect(deps.trial).not.toHaveBeenCalled()
  })
})

describe('BAC-2 位置', () => {
  it('BAC-2 没写 project → 临时文件夹：工作目录与权限表', () => {
    const out = checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))!
    expect(out.split('\n')[0]).toBe(HEADER('buddy', 'a temporary folder'))
    expect(deps.trial).toHaveBeenCalledTimes(1)
    expect(deps.trial.mock.calls[0][0]).toEqual({
      bot: UUID,
      workingDirectory: TEMP,
      aclRead: [TEMP, pathOf('buddy')],
      aclWrite: [TEMP, pathOf('buddy')]
    })
  })

  it('BAC-2 恰好一个项目 → 说法用项目的真名；权限表多一行项目知识库', () => {
    state.projects = [{ id: 'p1', name: 'Acme', path: '/Users/u/work/acme' }]
    const out = checker.forBotFile(
      botText('buddy', { id: UUID, bindings: [binding({ project: 'acme' })] }),
      pathOf('buddy')
    )!
    expect(out.split('\n')[0]).toBe(HEADER('buddy', 'project Acme'))
    const dirs = ['/Users/u/work/acme', pathOf('buddy'), KB('p1')]
    expect(deps.trial.mock.calls[0][0]).toEqual({
      bot: UUID,
      workingDirectory: '/Users/u/work/acme',
      aclRead: dirs,
      aclWrite: dirs
    })
    expect(deps.aclDir.mock.calls.map((c) => c[0])).toEqual(dirs)
  })

  it('BAC-2 aclDir 回 null 的（工作目录就是家目录）丢掉', () => {
    state.projects = [{ id: 'p1', name: 'Acme', path: HOME }]
    checker.forBotFile(
      botText('buddy', { bindings: [binding({ project: 'Acme' })] }),
      pathOf('buddy')
    )
    expect(deps.trial.mock.calls[0][0]).toMatchObject({
      workingDirectory: HOME,
      aclRead: [pathOf('buddy'), KB('p1')],
      aclWrite: [pathOf('buddy'), KB('p1')]
    })
  })

  it('BAC-2 acme / ACME 是同一个项目 → 只算一个位置、只试算一次', () => {
    state.projects = [{ id: 'p1', name: 'Acme', path: '/Users/u/work/acme' }]
    const out = checker.forBotFile(
      botText('buddy', { bindings: [binding({ project: 'acme' }), binding({ project: 'ACME' })] }),
      pathOf('buddy')
    )!
    expect(deps.trial).toHaveBeenCalledTimes(1)
    expect(count(out, 'Unattended access check for bot')).toBe(1)
    expect(out).toContain('as run in project Acme)')
  })

  it('BAC-2 临时文件夹 + 项目 → 两次试算（按绑定的顺序）；结果一样就合成一节', () => {
    state.projects = [{ id: 'p1', name: 'Acme', path: '/Users/u/work/acme' }]
    const out = checker.forBotFile(
      botText('buddy', { bindings: [binding(), binding({ project: 'Acme' })] }),
      pathOf('buddy')
    )!
    expect(deps.trial.mock.calls.map((c) => c[0].workingDirectory)).toEqual([
      TEMP,
      '/Users/u/work/acme'
    ])
    expect(out.split('\n')[0]).toBe(HEADER('buddy', 'a temporary folder or project Acme'))
  })

  it('BAC-2 试算拿到身份与核对自己的 logger（那里的告警进回执）；每个位置同一个 logger', () => {
    state.projects = [{ id: 'p1', name: 'Acme', path: '/Users/u/work/acme' }]
    state.trialWarning = 'trial says hi'
    const out = checker.forBotFile(
      botText('buddy', { id: UUID, bindings: [binding(), binding({ project: 'Acme' })] }),
      pathOf('buddy')
    )!
    const [first, second] = deps.trial.mock.calls
    expect(first[0].bot).toBe(UUID)
    expect(first[1].logger).toBe(second[1].logger)
    expect(typeof first[1].logger.info).toBe('function')
    expect(out).toContain('rule still applies): trial says hi.')
  })
})

describe('BAC-3 身份', () => {
  it('BAC-3 identityForFile 拿到解析出的文件与绝对路径', () => {
    checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))
    expect(deps.identityForFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'buddy', objectId: UUID }),
      pathOf('buddy')
    )
  })

  it('BAC-3 三种说法：没有 id → name；身份就是 id → id；内置形态的 id 不在认定的那份上 → untrusted-id', () => {
    expect(checker.forBotFile(botText('buddy'), pathOf('buddy'))).toContain(
      "In a policy this bot is `subject.bot == 'buddy'` — it has no shuvix-id, so policies know it by its name"
    )
    expect(checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))).toContain(
      `In a policy this bot is \`subject.bot == '${UUID}'\` (its shuvix-id).`
    )
    expect(checker.forBotFile(botText('impostor', { id: DAILY_ID }), pathOf('impostor'))).toContain(
      "In a policy this bot is `subject.bot == 'impostor'` — its shuvix-id is a built-in form that only the bot " +
        'file ShuviX wrote may carry'
    )
    state.trusted[DAILY_ID] = pathOf('daily')
    const daily = checker.forBotFile(botText('daily', { id: DAILY_ID }), pathOf('daily'))!
    expect(daily).toContain(
      `In a policy this bot is \`subject.bot == '${DAILY_ID}'\` (its shuvix-id).`
    )
    // 内置的 daily-bot-access 点名它
    expect(daily).toContain('Policies that name it: daily-bot-access.')
    expect(daily).toContain('- read other sessions: allowed (daily-bot-access).')
  })
})

describe('BAC-4 点名', () => {
  it('BAC-4 用户的同名文件顶替内置：内置那份不再点名日记 bot，用户那份点名谁就是谁', () => {
    state.trusted[DAILY_ID] = pathOf('daily')
    state.users = [
      userPolicy(policyText('daily-bot-access', [sessionRead('buddy')]), 'daily-bot-access.md')
    ]
    const daily = checker.forBotFile(botText('daily', { id: DAILY_ID }), pathOf('daily'))!
    expect(daily).toContain('No policy names it.')
    expect(daily).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)

    const buddy = checker.forBotFile(botText('buddy'), pathOf('buddy'))!
    expect(buddy).toContain('Policies that name it: daily-bot-access.')
    expect(buddy).toContain('- read other sessions: allowed (daily-bot-access).')
  })

  it('BAC-4 同名的第二份（文件名不是名字）不算：只列一次，它独有的路径不出现', () => {
    state.users = [
      userPolicy(policyText('buddy-access', [sessionRead('buddy')]), 'buddy-access.md'),
      userPolicy(
        policyText('buddy-access', [
          sessionRead('buddy'),
          pathRule('buddy', '/Users/u/notes/x.md')
        ]),
        'zz-copy.md'
      )
    ]
    const out = checker.forBotFile(botText('buddy'), pathOf('buddy'))!
    expect(out).toContain('Policies that name it: buddy-access.')
    expect(count(out, 'buddy-access')).toBe(2)
    expect(out).not.toContain('~/notes/x.md')
  })

  it('BAC-4 停用的策略不算点名、也不放行 → 没有策略点名它，于是有建议', () => {
    state.users = [
      userPolicy(policyText('buddy-access', [sessionRead('buddy')]), 'buddy-access.md')
    ]
    state.disabled.add('buddy-access')
    const out = checker.forBotFile(botText('buddy'), pathOf('buddy'))!
    expect(out).toContain('No policy names it.')
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    expect(out).toContain('offer a companion policy')
  })
})

// ─────────────────────────── forPolicyFile ───────────────────────────

describe('BAC-5 forPolicyFile 按装进去之后算', () => {
  it('BAC-5 顶替同文件名那份（allow → force-allow）；别的文件照旧', () => {
    registerBot('buddy')
    state.users = [
      userPolicy(policyText('x-access', [sessionRead('buddy', 'allow')]), 'x-access.md'),
      userPolicy(policyText('y-notes', [pathRule('buddy', '/Users/u/notes/y.md')]), 'y-notes.md')
    ]
    const out = checker.forPolicyFile(
      policyText('x-access', [sessionRead('buddy')]),
      'x-access.md'
    )!
    expect(out.startsWith('Checked with this policy installed as x-access.md.\n\n')).toBe(true)
    expect(out).toContain(HEADER('buddy', 'a temporary folder'))
    expect(out).toContain('- read other sessions: allowed (x-access).')
    expect(out).not.toContain('plain `allow`')
    expect(out).toContain('- ~/notes/y.md: read and write allowed (y-notes).')
    expect(out).toContain('Policies that name it: y-notes, x-access.')
  })

  it('BAC-5 写下的那份还是 allow → 照实说「还是要问」并点出普通 allow', () => {
    registerBot('buddy')
    const out = checker.forPolicyFile(
      policyText('x-access', [sessionRead('buddy', 'allow')]),
      'x-access.md'
    )!
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    expect(out).toContain('these rules change nothing above: x-access rule #0')
  })

  it('BAC-5 非法策略 / 没有点名任何 bot → null，不试算', () => {
    registerBot('buddy')
    expect(checker.forPolicyFile('---\nshuvix: policy v1\nname: [x\n---\n', 'x.md')).toBeNull()
    expect(
      checker.forPolicyFile(
        policyText('x', [
          rule('force-allow', { 'object.type': ['session'], action: ['read'] }, 'has(subject.bot)')
        ]),
        'x.md'
      )
    ).toBeNull()
    expect(deps.trial).not.toHaveBeenCalled()
  })
})

describe('BAC-6 / BAC-7 每个身份一段', () => {
  it('BAC-6 拼错的身份 → 「no bot is known by that」', () => {
    registerBot('xiaozhou')
    const out = checker.forPolicyFile(policyText('p', [sessionRead('xiaozhuo')]), 'p.md')
    expect(out).toBe(
      'Checked with this policy installed as p.md.\n\n' +
        "subject.bot == 'xiaozhuo': no bot is known by that (a bot's identity is its shuvix-id, or its name when " +
        'it has none) — this condition never matches.'
    )
    expect(deps.trial).not.toHaveBeenCalled()
  })

  it('BAC-6 按名字写了、可那个 bot 有 shuvix-id → 说它在策略里叫什么', () => {
    state.trusted[DAILY_ID] = pathOf('daily')
    registerBot('daily', { id: DAILY_ID })
    expect(checker.forPolicyFile(policyText('p', [sessionRead('daily')]), 'p.md')).toBe(
      'Checked with this policy installed as p.md.\n\n' +
        "subject.bot == 'daily': bot daily has a shuvix-id, so policies know it as 'bot:builtin:daily', not by " +
        'its name — this condition never matches.'
    )
  })

  it('BAC-6 点名的 bot 没有定时（含只有惰性埋点的）→ 没有定时那一句', () => {
    registerBot('buddy', { bindings: null })
    registerBot('pal', { bindings: [binding({ trigger: 'no.such.trigger' })] })
    expect(checker.forPolicyFile(policyText('p', [sessionRead('buddy')]), 'p.md')).toBe(
      `Checked with this policy installed as p.md.\n\n${NO_SCHEDULE('buddy')}`
    )
    expect(checker.forPolicyFile(policyText('p', [sessionRead('pal')]), 'p.md')).toBe(
      `Checked with this policy installed as p.md.\n\n${NO_SCHEDULE('pal')}`
    )
    expect(deps.trial).not.toHaveBeenCalled()
  })

  it('BAC-6 两个身份 → 两段，空行隔开，按策略里出现的顺序', () => {
    registerBot('buddy')
    const text = policyText('p', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        "has(subject.bot) && subject.bot in ['xiaozhuo', 'buddy'] && subject.agentKind == 'root'"
      )
    ])
    const parts = checker.forPolicyFile(text, 'p.md')!.split('\n\n')
    expect(parts[0]).toBe('Checked with this policy installed as p.md.')
    expect(parts[1].startsWith("subject.bot == 'xiaozhuo': no bot is known by that")).toBe(true)
    expect(parts[2].startsWith(HEADER('buddy', 'a temporary folder'))).toBe(true)
    expect(parts[2]).toContain('- read other sessions: allowed (p).')
    expect(parts).toHaveLength(3)
  })

  it('BAC-6 两份 bot 文件共用一个 shuvix-id → 两段', () => {
    registerBot('buddy', { id: UUID })
    registerBot('pal', { id: UUID })
    const out = checker.forPolicyFile(policyText('p', [sessionRead(UUID)]), 'p.md')!
    expect(out).toContain(HEADER('buddy', 'a temporary folder'))
    expect(out).toContain(HEADER('pal', 'a temporary folder'))
    expect(count(out, 'Unattended access check for bot')).toBe(2)
    expect(count(out, 'Policies that name it: p.')).toBe(2)
  })

  it('BAC-6 身份带引号 → 那一句里按 CEL 字符串转义（in 列表写法，见 accessCheck.test AC-1 的已知缺陷）', () => {
    const text = policyText('p', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        "has(subject.bot) && subject.bot in ['o\\'brien']"
      )
    ])
    expect(checker.forPolicyFile(text, 'p.md')).toContain(
      "subject.bot == 'o\\'brien': no bot is known by that"
    )
  })

  it('BAC-7 点名的 bot 有定时、可每条绑定都对不上恰好一个项目 → 「none of its bindings …」', () => {
    registerBot('buddy', { bindings: [binding({ project: 'ghost' })] })
    expect(checker.forPolicyFile(policyText('p', [sessionRead('buddy')]), 'p.md')).toBe(
      `Checked with this policy installed as p.md.\n\n${NOWHERE('buddy')}`
    )
  })
})

// ─────────────────────────── forBotName ───────────────────────────

describe('BAC-8 forBotName', () => {
  it('BAC-8 按名字、按身份都找得到；两头的空白去掉；结果与 forBotFile 同一段', () => {
    const { basePath } = registerBot('buddy', { id: UUID })
    const viaFile = checker.forBotFile(botText('buddy', { id: UUID }), basePath)!
    expect(checker.forBotName('buddy')).toEqual({ text: viaFile })
    expect(checker.forBotName(`  ${UUID} `)).toEqual({ text: viaFile })
  })

  it('BAC-8 不认识 → error', () => {
    registerBot('buddy')
    expect(checker.forBotName(' nobody ')).toEqual({ error: 'No bot is named nobody.' })
  })

  it('BAC-8 带一份策略 → 开头一句、按装进去之后算；非法 → error', () => {
    registerBot('buddy')
    const r = checker.forBotName('buddy', {
      text: policyText('buddy-access', [sessionRead('buddy')]),
      fileName: 'buddy-access.md'
    })
    expect('text' in r).toBe(true)
    const text = (r as { text: string }).text
    expect(
      text.startsWith(
        `Checked with buddy-access.md installed.\n${HEADER('buddy', 'a temporary folder')}`
      )
    ).toBe(true)
    expect(text).toContain('- read other sessions: allowed (buddy-access).')
    expect(
      checker.forBotName('buddy', { text: '---\nname: [x\n---\n', fileName: 'bad.md' })
    ).toEqual({
      error: 'bad.md is not a valid policy file.'
    })
  })

  it('BAC-8 没有定时 → 没有定时那一句；带策略时接在开头一句之后', () => {
    registerBot('buddy', { bindings: null })
    expect(checker.forBotName('buddy')).toEqual({ text: NO_SCHEDULE('buddy') })
    expect(
      checker.forBotName('buddy', {
        text: policyText('p', [sessionRead('buddy')]),
        fileName: 'p.md'
      })
    ).toEqual({ text: `Checked with p.md installed.\n${NO_SCHEDULE('buddy')}` })
  })

  it('BAC-8 没有能跑的位置 → none of its bindings 那一句', () => {
    registerBot('buddy', { bindings: [binding({ project: 'ghost' })] })
    expect(checker.forBotName('buddy')).toEqual({ text: NOWHERE('buddy') })
  })
})

// ─────────────────────────── 告警、现读 ───────────────────────────

describe('BAC-9 告警照实报', () => {
  const WARN_HEAD =
    'Some rules failed to evaluate (a failing allow or force-allow rule grants nothing; a failing ask or deny rule still applies): '

  it('BAC-9 拼错的变量名（ask 规则里的 inDir(…, vars.typo)）→ 「is not provided by the host」进告警那一行', () => {
    registerBot('buddy')
    const text = policyText('typo', [
      rule(
        'ask',
        { 'object.type': ['path'], action: ['write'] },
        `${guard('buddy')} && inDir(object.path, vars.typo)`
      )
    ])
    const out = checker.forPolicyFile(text, 'typo.md')!
    const line = out.split('\n').find((l) => l.startsWith('Some rules failed'))
    expect(line).toBe(
      `${WARN_HEAD}security policy 'typo': vars.typo is not provided by the host; inDir treats it as no directory.`
    )
  })

  it("BAC-9 求值出错的配套规则（timestamp('nope')）→ 进告警那一行，放行不成立", () => {
    registerBot('buddy')
    const text = policyText('broken', [
      rule(
        'force-allow',
        { 'object.type': ['session'], action: ['read'] },
        `${guard('buddy')} && timestamp('nope') > timestamp(vars.now)`
      )
    ])
    const out = checker.forPolicyFile(text, 'broken.md')!
    expect(out).toContain(`- read other sessions: ${STOPS('ask-on-session-access')}.`)
    const line = out.split('\n').find((l) => l.startsWith('Some rules failed'))!
    expect(line.startsWith(`${WARN_HEAD}broken#0 (`)).toBe(true)
    expect(line.endsWith(') — treating as not matched.')).toBe(true)
  })

  it('BAC-9 没有出错的规则 → 没有告警那一行（内置策略在这份试算变量下一句都不喊）', () => {
    registerBot('buddy')
    expect(checker.forBotFile(botText('buddy'), pathOf('buddy'))).not.toContain('Some rules failed')
  })
})

describe('BAC-10 / BAC-11 每次现读', () => {
  it('BAC-10 reviewActive 每次现读：开着 → 交审查；关着 → 会停', () => {
    const text = botText('buddy')
    const on = checker.forBotFile(text, pathOf('buddy'))!
    expect(on).toContain(REVIEW('ask-on-external-path'))
    state.review = false
    const off = checker.forBotFile(text, pathOf('buddy'))!
    expect(off).not.toContain('automatic review')
    expect(off).toContain(`write outside the home folder: ${STOPS('ask-on-external-path')}.`)
    expect(deps.reviewActive).toHaveBeenCalledTimes(2)
  })

  it('BAC-11 userPolicies 每次现读：中途写下的配套策略下一次就生效', () => {
    const text = botText('buddy')
    expect(checker.forBotFile(text, pathOf('buddy'))).toContain('No policy names it.')
    state.users = [
      userPolicy(policyText('buddy-access', [sessionRead('buddy')]), 'buddy-access.md')
    ]
    expect(checker.forBotFile(text, pathOf('buddy'))).toContain(
      'Policies that name it: buddy-access.'
    )
    expect(deps.userPolicies).toHaveBeenCalledTimes(2)
  })

  it('BAC-11 点名路径按试算交回的 vars 取（vars.dailyDir）', () => {
    state.users = [
      userPolicy(
        policyText('buddy-diary', [
          rule(
            'force-allow',
            { 'object.type': ['path'], action: ['read'] },
            `${guard('buddy')} && inDir(object.path, vars.dailyDir)`
          )
        ]),
        'buddy-diary.md'
      )
    ]
    const out = checker.forBotFile(botText('buddy'), pathOf('buddy'))!
    expect(out).toContain(
      `- files in ~/.shuvix/daily/: read allowed (buddy-diary); write ${REVIEW('ask-on-external-path')}.`
    )
  })
})

describe('BAC-KB 每个 bot 自己的知识库', () => {
  const BOTKB = '/Users/u/.shuvix/knowledge-shuvix/bots/' + UUID

  it('BAC-KB1 bot 自己的库在每个位置的权限表里都排最后一行（可读写）；aclDir 也问过它', () => {
    state.botKnowledgeDirs.set('buddy', BOTKB)
    state.projects = [{ id: 'p1', name: 'Acme', path: '/Users/u/work/acme' }]
    checker.forBotFile(
      botText('buddy', { id: UUID, bindings: [binding(), binding({ project: 'Acme' })] }),
      pathOf('buddy')
    )
    const [temp, project] = deps.trial.mock.calls.map((c) => c[0])
    expect(temp.aclRead).toEqual([TEMP, pathOf('buddy'), BOTKB])
    expect(temp.aclWrite).toEqual([TEMP, pathOf('buddy'), BOTKB])
    const dirs = ['/Users/u/work/acme', pathOf('buddy'), KB('p1'), BOTKB]
    expect(project.aclRead).toEqual(dirs)
    expect(project.aclWrite).toEqual(dirs)
    expect(deps.aclDir.mock.calls.map((c) => c[0])).toContain(BOTKB)
  })

  it('BAC-KB2 bot 没有库 → 权限表与 BAC-2 一模一样；aclDir 对它回 null → 丢掉', () => {
    checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))
    expect(deps.trial.mock.calls[0][0]).toMatchObject({
      aclRead: [TEMP, pathOf('buddy')],
      aclWrite: [TEMP, pathOf('buddy')]
    })

    deps.trial.mockClear()
    state.botKnowledgeDirs.set('buddy', BOTKB)
    deps.aclDir.mockImplementationOnce((dir: string) => dir)
    deps.aclDir.mockImplementationOnce((dir: string) => dir)
    deps.aclDir.mockImplementationOnce(() => null)
    checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))
    expect(deps.trial.mock.calls[0][0]).toMatchObject({
      aclRead: [TEMP, pathOf('buddy')],
      aclWrite: [TEMP, pathOf('buddy')]
    })
  })

  it('BAC-KB3 配套策略点名 bot 库里的一个文件：回执里那次写入是放行的（不问、不停）；没有库时同一份策略那次写要问', () => {
    const note = `${BOTKB}/notes.md`
    state.users = [
      userPolicy(
        policyText('buddy-access', [sessionRead(UUID), pathRule(UUID, note, 'allow')]),
        'buddy-access.md'
      )
    ]
    const without = checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))!
    state.botKnowledgeDirs.set('buddy', BOTKB)
    const withKb = checker.forBotFile(botText('buddy', { id: UUID }), pathOf('buddy'))!
    const line = '- ~/.shuvix/knowledge-shuvix/bots/' + UUID + '/notes.md: read and write '
    expect(without).toContain(`${line}asks (ask-on-external-path`)
    expect(withKb).toContain(`${line}allowed (buddy-access).`)
    expect(withKb).not.toContain(`${line}asks`)
  })
})
