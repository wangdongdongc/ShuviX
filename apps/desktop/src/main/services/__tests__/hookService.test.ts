/**
 * HookService —— hook 注册表（内置 + 用户 `~/.shuvix/hooks/*.md`，纯 md 驱动）、runner 装配与
 * 埋点门面的桌面宿主语义。编排语义（去重 / 超时 / 跳过原因的判定）归 agent-runtime 的
 * hookRunner.test.ts；这里测宿主装配、注册表、扫描缓存与设置页 API。
 *
 * 观测面：桌面不给 onRun，只看 mocks.runTask（派发了什么）与 logger 行
 * （`hook "<name>" run=… start`、`… skipped for session …: <reason>`）。
 *
 * fs 是真的（扫描扫真目录），只把 readFileSync 套一层可数的壳（同 botService.test.ts 的手法）：
 * 扫描缓存命中与否数它，「读不出来的文件」也靠它造。上层句柄（agentManager / agentService /
 * sessionService / electron shell / logger）全 mock；i18next 用真件（内置 hook 随界面语言）。
 * userDir 在单例构造期捕获 —— 路径先备好、再动态 import。
 *
 * 单例的 runner 跨用例存活，去重键是「hook × 会话」：挂起的 run 必须在用例内收掉（afterEach 兜底中止）。
 * 扫描缓存按「名字:inode:mtime:size」指纹失效，钉 mtime 的用例各用独有文件名，免得跨用例撞指纹。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import i18next from 'i18next'
import {
  parseHookDefinitionFile,
  toInProcessAgentType,
  type AgentProfile,
  type RunTaskParams,
  type SubAgentModelConfig,
  type TriggerPayloadMap
} from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ dir: '', failReadPath: null as string | null }))
const mocks = vi.hoisted(() => ({
  runTask: vi.fn(),
  getProfile: vi.fn(),
  resolveRunModelConfig: vi.fn(),
  openPath: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openPath: mocks.openPath } }))
vi.mock('../../utils/paths', () => ({ getDefaultHooksDir: () => state.dir }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { runTask: mocks.runTask } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../sessionService', () => ({
  sessionService: { resolveRunModelConfig: mocks.resolveRunModelConfig }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: () => {} })
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, default: actual, readFileSync: vi.fn(actual.readFileSync) }
})

type HookServiceModule = typeof import('../hookService')
let hookService: HookServiceModule['hookService']
let hookTriggers: HookServiceModule['hookTriggers']
let root = ''

const MODEL: SubAgentModelConfig = { provider: 'p', model: 'm', capabilities: {} }
const BUILTIN_TITLE = 'Automatic Session Titles'
const BUILTIN_DESCRIPTION =
  'Names a session on its first prompt and refines the title once after the second turn.'
const BUILTIN_TRIGGERS = ['session.prompt-accepted', 'session.turn-completed']

/** 内置 md 原文：直接读包里的文件，不经被测代码 */
const builtinMd = (file: string): string =>
  readFileSync(
    new URL(
      `../../../../../../packages/agent-runtime/src/hook/builtinHooks/md/${file}`,
      import.meta.url
    ),
    'utf-8'
  )

const profileOf = (name: string): AgentProfile => ({
  name,
  displayName: name,
  description: '',
  systemPrompt: 'BODY',
  tools: ['session'],
  instructionFiles: [],
  projectAwareness: false,
  source: 'builtin',
  basePath: ''
})

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-hooksvc-'))
  state.dir = join(root, 'hooks')
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  // 实现装一次、之后只 mockClear（mockReset 会把实现一起抹掉）
  vi.mocked(readFileSync).mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (state.failReadPath !== null && String(path) === state.failReadPath) {
      throw new Error('EACCES: permission denied')
    }
    return (realFs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as never)
  if (!i18next.isInitialized) await i18next.init({ lng: 'en', resources: {} })
  ;({ hookService, hookTriggers } = await import('../hookService'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  rmSync(state.dir, { recursive: true, force: true })
  state.failReadPath = null
  await i18next.changeLanguage('en')
  mocks.runTask.mockReset().mockResolvedValue({ result: 'ok' })
  mocks.getProfile.mockReset().mockImplementation(profileOf)
  mocks.resolveRunModelConfig.mockReset().mockResolvedValue(MODEL)
  mocks.openPath.mockReset().mockResolvedValue('')
  mocks.info.mockClear()
  mocks.warn.mockClear()
  vi.mocked(readFileSync).mockClear()
})

afterEach(async () => {
  // 兜底：挂起的 run 不许串进下一条用例（去重键是 hook × 会话）
  hookService.abortSessionRuns('s1')
  hookService.abortSessionRuns('s2')
  await settle()
})

// ── 观测与夹具助手 ──

/** 让已排队的微任务链全部落定（mock 全是立即 resolve 的 promise） */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 等到至少 n 次派发，再落定一个宏任务（让刚派发的 run 收尾、释放去重坑位） */
const waitRuns = async (n: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(mocks.runTask.mock.calls.length).toBeGreaterThanOrEqual(n)
  })
  await settle()
}

const runs = (): RunTaskParams[] => mocks.runTask.mock.calls.map((call) => call[0] as RunTaskParams)
const descriptions = (): string[] => runs().map((params) => params.description)
const logLines = (): string[] =>
  [...mocks.info.mock.calls, ...mocks.warn.mock.calls].map((args) => args.map(String).join(' '))
const hasLog = (fragment: string): boolean => logLines().some((line) => line.includes(fragment))
/** 本条用例里 hooks 目录下某个文件被 readFileSync 读过几次 */
const readsOf = (fileName: string): number =>
  vi.mocked(readFileSync).mock.calls.filter((call) => String(call[0]) === join(state.dir, fileName))
    .length

/** 往 hooks 目录写一份文件（目录按需创建），返回完整路径 */
const put = (fileName: string, text: string): string => {
  mkdirSync(state.dir, { recursive: true })
  const path = join(state.dir, fileName)
  writeFileSync(path, text)
  return path
}

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

interface UserHookOptions {
  agent?: string
  trigger?: string
  when?: string
  body?: string
  displayName?: string
  /** 追加在绑定之后的顶层 frontmatter 行 */
  extra?: string[]
}

/** 最小合法用户 hook md；name 传 null = 不写 name（名字取文件 basename） */
const userHook = (name: string | null, opts: UserHookOptions = {}): string =>
  [
    '---',
    'shuvix: hook v1',
    ...(name === null ? [] : [`name: ${quote(name)}`]),
    ...(opts.displayName ? [`shuvix-displayName: ${quote(opts.displayName)}`] : []),
    `shuvix-hook-agent: ${opts.agent ?? 'titler'}`,
    'shuvix-hook-on:',
    `  - trigger: ${opts.trigger ?? 'session.prompt-accepted'}`,
    ...(opts.when ? [`    when: ${quote(opts.when)}`] : []),
    ...(opts.extra ?? []),
    '---',
    '',
    opts.body ?? 'Do the thing.',
    ''
  ].join('\n')

/** 裸 on 键：整份拒绝 */
const bareOn = (name: string): string =>
  [
    '---',
    'shuvix: hook v1',
    `name: ${quote(name)}`,
    'shuvix-hook-agent: titler',
    'on:',
    '  - trigger: session.prompt-accepted',
    '---',
    '',
    'Body.',
    ''
  ].join('\n')

/** 两条诊断的非法文件：先是未知埋点的 inert 告警，再是坏 when 的整份拒绝 */
const twoDiagnostics = (name: string): string =>
  [
    '---',
    'shuvix: hook v1',
    `name: ${quote(name)}`,
    'shuvix-hook-agent: titler',
    'shuvix-hook-on:',
    '  - trigger: file.changed',
    '  - trigger: session.prompt-accepted',
    "    when: 'event.'",
    '---',
    '',
    'Body.',
    ''
  ].join('\n')

const diagnosticsOf = (text: string, defaultName: string): string[] => {
  const messages: string[] = []
  expect(parseHookDefinitionFile(text, defaultName, (m) => messages.push(m))).toBeNull()
  return messages
}

/** isDefaultTitle 缺省 false：内置 auto-title 不掺和 */
const firePrompt = (over: Partial<TriggerPayloadMap['session.prompt-accepted']> = {}): void =>
  hookTriggers.fire('session.prompt-accepted', {
    sessionId: 's1',
    profileName: 'work',
    title: 'New Chat',
    isDefaultTitle: false,
    promptText: 'hello',
    ...over
  })

/** 缺省不满足内置精修条件 */
const fireTurn = (over: Partial<TriggerPayloadMap['session.turn-completed']> = {}): void =>
  hookTriggers.fire('session.turn-completed', {
    sessionId: 's1',
    profileName: 'work',
    title: 'Chat',
    isDefaultTitle: false,
    turnCount: 5,
    textMessageCount: 10,
    titleAutoGenerated: false,
    recentText: 'User: a\nAssistant: b',
    ...over
  })

/** 设置页里这个名字的行：[来源, 文件名（内置为空串）, 是否被覆盖, 被谁覆盖] */
const rowsNamed = (name: string): unknown[][] =>
  hookService
    .listForSettings()
    .filter((item) => item.name === name)
    .map((item) => [item.source, basename(item.basePath), !!item.overridden, item.overriddenBy])

describe('hookService — 初始化', () => {
  it('HS-1 init 之前：fire 不抛、什么都不调用；abortSessionRuns → 0；init 两次后一次 fire 恰一个 run', async () => {
    // 必须是本文件第一条：单例尚未 init
    expect(() =>
      hookService.fire('session.prompt-accepted', {
        sessionId: 's1',
        profileName: 'work',
        title: 'New Chat',
        isDefaultTitle: true,
        promptText: 'hello'
      })
    ).not.toThrow()
    expect(() => firePrompt({ isDefaultTitle: true })).not.toThrow()
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(mocks.resolveRunModelConfig).not.toHaveBeenCalled()
    expect(hookService.abortSessionRuns('s1')).toBe(0)

    hookService.init()
    hookService.init()
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
  })
})

describe('hookService — 内置 hook 与运行时装配', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-2 内置 auto-title 出厂即生效：isDefaultTitle 为真派发 titler，为假不派发', async () => {
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
    const [run] = runs()
    expect(run.agentType.name).toBe('titler')
    expect(run.parentSessionId).toBe('s1')
    expect(run.description).toBe(BUILTIN_TITLE)
    expect(run.prompt).toContain('<hook_event trigger="session.prompt-accepted">')

    firePrompt({ isDefaultTitle: false })
    await settle()
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
  })

  it('HS-2 目录不存在：设置页恰内置一行（无 overridden 键），非法列表为空', () => {
    expect(existsSync(state.dir)).toBe(false)
    expect(hookService.listForSettings()).toStrictEqual([
      {
        name: 'auto-title',
        displayName: BUILTIN_TITLE,
        description: BUILTIN_DESCRIPTION,
        agent: 'titler',
        triggers: BUILTIN_TRIGGERS,
        source: 'builtin',
        basePath: ''
      }
    ])
    expect(hookService.listInvalid()).toEqual([])
  })

  it('HS-3 agent 按名解析：getProfile(titler) 的 toInProcessAgentType 投影原样交给 runTask', async () => {
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(mocks.getProfile).toHaveBeenCalledWith('titler')
    expect(runs()[0].agentType).toStrictEqual(toInProcessAgentType(profileOf('titler')))
  })

  it('HS-3 getProfile 查不到 → 不派发，日志记 unknown-agent', async () => {
    mocks.getProfile.mockReturnValue(undefined)
    firePrompt({ isDefaultTitle: true })
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
    expect(
      hasLog('skipped for session s1: unknown-agent (no agent definition named "titler")')
    ).toBe(true)
  })

  it('HS-4 模型 = 归属会话的当前模型（按 sessionId 解析，原样交给 runTask）', async () => {
    const model: SubAgentModelConfig = {
      provider: 'openai',
      model: 'gpt-x',
      capabilities: {},
      thinkingLevel: 'low'
    }
    mocks.resolveRunModelConfig.mockResolvedValue(model)
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(mocks.resolveRunModelConfig).toHaveBeenCalledWith('s1')
    expect(runs()[0].modelConfig).toEqual(model)
  })

  it('HS-4 会话没有可用模型 → 不派发，日志记 no-model', async () => {
    mocks.resolveRunModelConfig.mockResolvedValue(null)
    firePrompt({ isDefaultTitle: true })
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
    expect(hasLog('skipped for session s1: no-model')).toBe(true)
  })

  it('HS-4 hook 文件不能选模型：带 shuvix-hook-model 的用户文件整份拒绝', async () => {
    put('picky.md', userHook('picky', { extra: ['shuvix-hook-model: gpt-x'] }))
    expect(hookService.listInvalid()).toEqual([
      { fileName: 'picky.md', error: expect.stringContaining("unknown key 'shuvix-hook-model'") }
    ])
    expect(hookService.listForSettings().map((item) => item.name)).toEqual(['auto-title'])
    firePrompt()
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('HS-5 when 的 env：host=desktop、platform=process.platform', async () => {
    put(
      'env-yes.md',
      userHook('env-yes', {
        displayName: 'Env yes',
        when: `env.host == 'desktop' && env.platform == '${process.platform}'`
      })
    )
    put('env-no.md', userHook('env-no', { displayName: 'Env no', when: "env.host == 'extension'" }))
    firePrompt()
    await waitRuns(1)
    expect(descriptions()).toEqual(['Env yes'])
  })
})

describe('hookService — 用户 hook（纯 md 驱动）', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-6 放下一份合法文件即生效；非 .md / 点开头 / 子目录里的 / 名为 y.md 的目录都不扫', async () => {
    put('x.md', userHook('x', { displayName: 'X Hook' }))
    put('.config.json', JSON.stringify({ disabled: ['x'] }))
    put('notes.txt', userHook('notes', { displayName: 'Notes' }))
    put('.hidden.md', userHook('hidden', { displayName: 'Hidden' }))
    mkdirSync(join(state.dir, '.runs'), { recursive: true })
    writeFileSync(join(state.dir, '.runs', 'inner.md'), userHook('inner', { displayName: 'Inner' }))
    mkdirSync(join(state.dir, 'y.md'), { recursive: true })

    firePrompt()
    await waitRuns(1)
    expect(descriptions()).toEqual(['X Hook'])
    expect(hasLog('hook "x" run=')).toBe(true)
    expect(hookService.listForSettings().map((item) => item.name)).toEqual(['auto-title', 'x'])
    expect(hookService.listInvalid()).toEqual([])
  })

  it('HS-6 扩展名大小写不敏感：X.MD 照扫，名字取自文件名', () => {
    put('X.MD', userHook(null, { displayName: 'Upper' }))
    expect(hookService.listForSettings().filter((item) => item.source === 'user')).toEqual([
      expect.objectContaining({
        name: 'X',
        displayName: 'Upper',
        basePath: join(state.dir, 'X.MD')
      })
    ])
  })

  it('HS-7 没写 name：名字取文件 basename', async () => {
    put('no-name.md', userHook(null))
    expect(hookService.listForSettings().find((item) => item.source === 'user')).toMatchObject({
      name: 'no-name',
      displayName: 'no-name',
      basePath: join(state.dir, 'no-name.md')
    })
    firePrompt()
    await waitRuns(1)
    expect(descriptions()).toEqual(['no-name'])
  })

  it('HS-8 结构非法（裸 on）→ 进 listInvalid 带人读原因；不进列表、不触发', async () => {
    put('bad.md', bareOn('bad'))
    const invalid = hookService.listInvalid()
    expect(invalid).toHaveLength(1)
    expect(invalid[0].fileName).toBe('bad.md')
    expect(invalid[0].error).toContain("bare 'on' key")
    expect(invalid[0].error).toContain('the whole file is rejected')
    expect(hookService.listForSettings().map((item) => item.name)).toEqual(['auto-title'])
    firePrompt()
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('HS-8 非法的 auto-title.md（点名基座 work）遮蔽不了内置', async () => {
    put(
      'auto-title.md',
      userHook('auto-title', { agent: 'work', displayName: 'Broken', when: 'event.isDefaultTitle' })
    )
    expect(hookService.listInvalid().map((file) => file.fileName)).toEqual(['auto-title.md'])
    expect(rowsNamed('auto-title')).toEqual([['builtin', '', false, undefined]])
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(descriptions()).toEqual([BUILTIN_TITLE])
  })

  it('HS-8 读不出来的文件 → 非法行，原因是 fs 的错误', () => {
    state.failReadPath = put('locked.md', userHook('locked'))
    expect(hookService.listInvalid()).toEqual([
      { fileName: 'locked.md', error: 'EACCES: permission denied' }
    ])
    expect(hookService.listForSettings().map((item) => item.name)).toEqual(['auto-title'])
  })

  it('HS-8 只绑未知埋点的文件 → 合法、列出 triggers，但永远不跑', async () => {
    put('future.md', userHook('future', { trigger: 'file.changed' }))
    expect(hookService.listInvalid()).toEqual([])
    expect(hookService.listForSettings().find((item) => item.name === 'future')).toMatchObject({
      triggers: ['file.changed'],
      source: 'user'
    })
    firePrompt()
    fireTurn()
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()
  })

  it('HS-8 同一份文件的多条诊断以换行拼接成 error', () => {
    const text = twoDiagnostics('multi')
    put('multi.md', text)
    const messages = diagnosticsOf(text, 'multi')
    expect(messages).toHaveLength(2)
    expect(hookService.listInvalid()).toEqual([
      { fileName: 'multi.md', error: messages.join('\n') }
    ])
  })
})

describe('hookService — 同名覆盖与同名的几份', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-9 用户 auto-title.md 覆盖内置：用户生效在前、内置标 overridden；一次 fire 恰一个 run 且跑用户版；getSource 两边各回各的', async () => {
    const text = userHook('auto-title', { displayName: 'Mine', when: 'event.isDefaultTitle' })
    const path = put('auto-title.md', text)
    expect(hookService.listForSettings()).toStrictEqual([
      {
        name: 'auto-title',
        displayName: 'Mine',
        description: '',
        agent: 'titler',
        triggers: ['session.prompt-accepted'],
        source: 'user',
        basePath: path
      },
      {
        name: 'auto-title',
        displayName: BUILTIN_TITLE,
        description: BUILTIN_DESCRIPTION,
        agent: 'titler',
        triggers: BUILTIN_TRIGGERS,
        source: 'builtin',
        basePath: '',
        overridden: true,
        overriddenBy: 'auto-title.md'
      }
    ])

    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(descriptions()).toEqual(['Mine'])

    expect(hookService.getSource('auto-title', 'user')).toEqual({ text })
    expect(hookService.getSource('auto-title', 'builtin')).toEqual({
      text: builtinMd('auto-title.md')
    })
  })

  it('HS-10 同名三份（at.md / auto-title.md / 非法的 auto-title copy.md）：跑文件名即名字那份；按名删 → at.md 接班；再按文件名删 → 内置恢复', async () => {
    put('at.md', userHook('auto-title', { displayName: 'SHORT', when: 'event.isDefaultTitle' }))
    const canon = put(
      'auto-title.md',
      userHook('auto-title', { displayName: 'CANON', when: 'event.isDefaultTitle' })
    )
    put('auto-title copy.md', bareOn('auto-title'))

    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    expect(descriptions()).toEqual(['CANON'])
    // 排序口径：名字 → 生效在前 → basePath（内置的空串排在输掉的用户文件前）
    expect(rowsNamed('auto-title')).toEqual([
      ['user', 'auto-title.md', false, undefined],
      ['builtin', '', true, 'auto-title.md'],
      ['user', 'at.md', true, 'auto-title.md']
    ])
    expect(hookService.listInvalid().map((file) => file.fileName)).toEqual(['auto-title copy.md'])

    expect(hookService.delete('auto-title')).toEqual({ success: true })
    expect(existsSync(canon)).toBe(false)
    firePrompt({ isDefaultTitle: true })
    await waitRuns(2)
    expect(descriptions()).toEqual(['CANON', 'SHORT'])
    expect(rowsNamed('auto-title')).toEqual([
      ['user', 'at.md', false, undefined],
      ['builtin', '', true, 'at.md']
    ])

    expect(hookService.deleteByFile('at.md')).toEqual({ success: true })
    firePrompt({ isDefaultTitle: true })
    await waitRuns(3)
    expect(descriptions()).toEqual(['CANON', 'SHORT', BUILTIN_TITLE])
    expect(rowsNamed('auto-title')).toEqual([['builtin', '', false, undefined]])
    // 写着同一个名字的非法文件始终只在「无法解析」里，遮蔽不了内置
    expect(hookService.listInvalid().map((file) => file.fileName)).toEqual(['auto-title copy.md'])
  })

  it('HS-11 按文件名删掉输的那份，赢的那份原封不动', () => {
    const canon = put('auto-title.md', userHook('auto-title', { displayName: 'CANON' }))
    put('at.md', userHook('auto-title', { displayName: 'SHORT' }))
    expect(hookService.deleteByFile('at.md')).toEqual({ success: true })
    expect(existsSync(canon)).toBe(true)
    expect(rowsNamed('auto-title')).toEqual([
      ['user', 'auto-title.md', false, undefined],
      ['builtin', '', true, 'auto-title.md']
    ])
  })

  it('HS-11 按名删：只有内置 / 名字不存在 → not found', () => {
    expect(hookService.delete('auto-title')).toEqual({
      success: false,
      error: 'Hook "auto-title" not found'
    })
    expect(hookService.delete('nope')).toEqual({ success: false, error: 'Hook "nope" not found' })
  })

  it.each(['../x.md', 'sub/x.md', '.hidden.md', 'x.txt', 'x.md/', 'missing.md'])(
    'HS-11 deleteByFile 文件名白名单拒绝 %j，什么都不删',
    (fileName) => {
      const decoys = [
        put('x.md', userHook('x')),
        put('.hidden.md', userHook('hidden')),
        put('x.txt', userHook('txt')),
        join(root, 'x.md'),
        join(state.dir, 'sub', 'x.md')
      ]
      writeFileSync(decoys[3], userHook('outside'))
      mkdirSync(join(state.dir, 'sub'), { recursive: true })
      writeFileSync(decoys[4], userHook('nested'))

      try {
        expect(hookService.deleteByFile(fileName)).toEqual({
          success: false,
          error: `Hook file "${fileName}" not found`
        })
        for (const decoy of decoys) expect(existsSync(decoy)).toBe(true)
      } finally {
        // hooks 目录之外的诱饵不会被 beforeEach 清掉，自己收
        rmSync(decoys[3], { force: true })
      }
    }
  )

  it('HS-12 getSource 的错误分支；同名时取生效那份的原文', () => {
    expect(hookService.getSource('x', 'user')).toEqual({ error: 'Hook "x" not found' })
    expect(hookService.getSource('x', 'builtin')).toEqual({ error: 'Builtin hook "x" not found' })

    put('broken.md', bareOn('broken'))
    expect(hookService.getSource('broken', 'user')).toEqual({ error: 'Hook "broken" not found' })

    const canonText = userHook('auto-title', { displayName: 'CANON' })
    put('at.md', userHook('auto-title', { displayName: 'SHORT' }))
    put('auto-title.md', canonText)
    expect(hookService.getSource('auto-title', 'user')).toEqual({ text: canonText })
  })
})

describe('hookService — 新建', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-13 非法文本：写盘前拒绝，原因按行拼接；不落文件、不建目录', () => {
    const text = twoDiagnostics('multi')
    const messages = diagnosticsOf(text, 'hook')
    expect(messages).toHaveLength(2)
    expect(hookService.create(text)).toEqual({ success: false, error: messages.join('\n') })
    expect(existsSync(state.dir)).toBe(false)
  })

  it('HS-13 合法文本：{success, name}；字节一致落盘；目录懒创建', () => {
    expect(existsSync(state.dir)).toBe(false)
    const text = userHook('fresh', { displayName: 'Fresh 🚀', body: 'Line 1\n\n  indented\n' })
    expect(hookService.create(text)).toEqual({ success: true, name: 'fresh' })
    expect(existsSync(state.dir)).toBe(true)
    expect(readdirSync(state.dir)).toEqual(['fresh.md'])
    expect(readFileSync(join(state.dir, 'fresh.md'), 'utf-8')).toBe(text)
  })

  it.each<[string | null, string]>([
    ['a/b', 'a-b.md'],
    ['a:b*?"<>|', 'a-b------.md'],
    ['.hidden', 'hidden.md'],
    ['...', 'hook.md'],
    ['../../evil', '-..-evil.md'],
    [null, 'hook.md']
  ])('HS-14 文件名净化：name %j → %s（落在 hooks 目录内）', (name, fileName) => {
    expect(hookService.create(userHook(name))).toEqual({ success: true, name: name ?? 'hook' })
    expect(readdirSync(state.dir)).toEqual([fileName])
    expect(readFileSync(join(state.dir, fileName), 'utf-8')).toBe(userHook(name))
    // 没有东西逃出 hooks 目录（'../../evil' 是这组里唯一想往外逃的名字）
    expect(existsSync(join(root, 'evil.md'))).toBe(false)
    expect(existsSync(join(root, '..', 'evil.md'))).toBe(false)
  })

  it('HS-14 三个净化后撞名的名字 → a-b.md / a-b-1.md / a-b-2.md', () => {
    for (const name of ['a/b', 'a:b', 'a|b']) {
      expect(hookService.create(userHook(name))).toEqual({ success: true, name })
    }
    expect(readdirSync(state.dir).sort()).toEqual(['a-b-1.md', 'a-b-2.md', 'a-b.md'])
    expect(readFileSync(join(state.dir, 'a-b.md'), 'utf-8')).toBe(userHook('a/b'))
    expect(readFileSync(join(state.dir, 'a-b-1.md'), 'utf-8')).toBe(userHook('a:b'))
    expect(readFileSync(join(state.dir, 'a-b-2.md'), 'utf-8')).toBe(userHook('a|b'))
  })

  it('HS-14 同名的非法文件占着 foo.md → 新建落到 foo-1.md，坏文件原封不动', () => {
    const badText = bareOn('foo')
    put('foo.md', badText)
    expect(hookService.create(userHook('foo'))).toEqual({ success: true, name: 'foo' })
    expect(readdirSync(state.dir).sort()).toEqual(['foo-1.md', 'foo.md'])
    expect(readFileSync(join(state.dir, 'foo.md'), 'utf-8')).toBe(badText)
    expect(readFileSync(join(state.dir, 'foo-1.md'), 'utf-8')).toBe(userHook('foo'))
  })

  it('HS-14 已有同名合法用户 hook → already exists 且不落文件；与内置同名的 auto-title 可以新建', () => {
    put('foo.md', userHook('foo'))
    expect(hookService.create(userHook('foo', { displayName: 'Again' }))).toEqual({
      success: false,
      error: 'Hook "foo" already exists'
    })
    expect(readdirSync(state.dir)).toEqual(['foo.md'])

    expect(hookService.create(userHook('auto-title'))).toEqual({
      success: true,
      name: 'auto-title'
    })
    expect(readdirSync(state.dir).sort()).toEqual(['auto-title.md', 'foo.md'])
  })

  it.each(['create', 'delete', 'deleteByFile'] as const)(
    'HS-15 本进程写路径 %s 之后紧接着的列表与 fire 即生效',
    async (how) => {
      put('seed.md', userHook('seed', { displayName: 'Seed' }))
      // 先把缓存喂上「目录里有 seed 这一份」
      expect(hookService.listForSettings().some((item) => item.name === 'seed')).toBe(true)

      if (how === 'create') {
        expect(hookService.create(userHook('fresh', { displayName: 'Fresh' }))).toEqual({
          success: true,
          name: 'fresh'
        })
        expect(hookService.listForSettings().some((item) => item.name === 'fresh')).toBe(true)
        firePrompt()
        await waitRuns(2)
        expect(descriptions().sort()).toEqual(['Fresh', 'Seed'])
      } else {
        const result =
          how === 'delete' ? hookService.delete('seed') : hookService.deleteByFile('seed.md')
        expect(result).toEqual({ success: true })
        expect(hookService.listForSettings().some((item) => item.name === 'seed')).toBe(false)
        firePrompt()
        await settle()
        expect(mocks.runTask).not.toHaveBeenCalled()
      }
    }
  )
})

describe('hookService — 目录扫描缓存', () => {
  beforeEach(() => {
    hookService.init()
  })

  /**
   * 指纹是「名字:inode:mtimeMs:size」。为了让「同 mtime 同 size 的覆写」断言确定性成立，
   * 写盘后把时间戳钉到同一个整毫秒值 —— 不钉就得依赖文件系统的时间精度。
   */
  const FIXED = new Date(1_700_000_000_000)
  const pin = (fileName: string): void => utimesSync(join(state.dir, fileName), FIXED, FIXED)

  it('HS-16 目录没变：两次 fire 只读一次文件，两次都派发', async () => {
    put('cached.md', userHook('cached', { displayName: 'Cached' }))
    vi.mocked(readFileSync).mockClear()

    firePrompt()
    await waitRuns(1)
    expect(readsOf('cached.md')).toBe(1)

    firePrompt()
    await waitRuns(2)
    expect(readsOf('cached.md')).toBe(1)
    expect(descriptions()).toEqual(['Cached', 'Cached'])
  })

  it('HS-16 内容与 size 都变的外部编辑 → 重读，下一次 fire 用新内容', async () => {
    const path = put('edited.md', userHook('edited', { displayName: 'V1' }))
    firePrompt()
    await waitRuns(1)
    expect(readsOf('edited.md')).toBe(1)

    writeFileSync(path, userHook('edited', { displayName: 'V2-much-longer-name' }))
    firePrompt()
    await waitRuns(2)
    expect(readsOf('edited.md')).toBe(2)
    expect(descriptions()).toEqual(['V1', 'V2-much-longer-name'])
  })

  it('HS-16 新增 / 删除文件立即生效', async () => {
    // 目录里先有一份不在 prompt 上触发的文件，缓存先喂上
    put('anchor.md', userHook('anchor', { trigger: 'session.turn-completed' }))
    firePrompt()
    await settle()
    expect(mocks.runTask).not.toHaveBeenCalled()

    const path = put('late.md', userHook('late', { displayName: 'Late' }))
    firePrompt()
    await waitRuns(1)
    expect(descriptions()).toEqual(['Late'])

    rmSync(path)
    firePrompt()
    await settle()
    expect(descriptions()).toEqual(['Late'])
  })

  it('HS-16 【钉现状 + 风险】钉住 mtime 的等长原地覆写骗得过指纹 → 仍跑旧内容', async () => {
    const path = put('stale.md', userHook('stale', { displayName: 'AAA' }))
    pin('stale.md')
    firePrompt()
    await waitRuns(1)

    writeFileSync(path, userHook('stale', { displayName: 'BBB' }))
    pin('stale.md')
    firePrompt()
    await waitRuns(2)
    expect(descriptions()).toEqual(['AAA', 'AAA'])
  })

  it('HS-16 临时文件 + rename（换 inode）→ 同 mtime 同 size 也立即生效（上一条的对照）', async () => {
    const path = put('atomic.md', userHook('atomic', { displayName: 'AAA' }))
    pin('atomic.md')
    firePrompt()
    await waitRuns(1)

    const tmpPath = join(state.dir, `.atomic.md.${process.pid}.tmp`)
    writeFileSync(tmpPath, userHook('atomic', { displayName: 'BBB' }))
    renameSync(tmpPath, path)
    pin('atomic.md')
    firePrompt()
    await waitRuns(2)
    expect(descriptions()).toEqual(['AAA', 'BBB'])
  })

  it('HS-16 listInvalid 不受缓存拖累：修好之后立刻消失', () => {
    const path = put('broken.md', bareOn('broken'))
    expect(hookService.listInvalid().map((file) => file.fileName)).toEqual(['broken.md'])

    writeFileSync(path, userHook('broken'))
    expect(hookService.listInvalid()).toEqual([])
    expect(hookService.listForSettings().some((item) => item.name === 'broken')).toBe(true)
  })
})

describe('hookService — 界面语言', () => {
  beforeEach(() => {
    hookService.init()
  })

  it.each<[string, string, string]>([
    ['zh', '自动生成会话标题', 'auto-title.zh.md'],
    ['ja', 'セッション名の自動生成', 'auto-title.ja.md'],
    ['fr', BUILTIN_TITLE, 'auto-title.md']
  ])(
    'HS-17 language %s → 内置显示名 %s；getSource 取该语言原文；run 描述跟随；用户行不受影响',
    async (language, displayName, mdFile) => {
      put('mine.md', userHook('mine', { displayName: 'Mine', trigger: 'session.turn-completed' }))
      await i18next.changeLanguage(language)

      const rows = hookService.listForSettings()
      expect(rows.find((item) => item.source === 'builtin')?.displayName).toBe(displayName)
      expect(rows.find((item) => item.source === 'user')?.displayName).toBe('Mine')
      expect(hookService.getSource('auto-title', 'builtin')).toEqual({ text: builtinMd(mdFile) })

      firePrompt({ isDefaultTitle: true })
      await waitRuns(1)
      expect(descriptions()).toEqual([displayName])
    }
  )
})

describe('hookService — 去重、分会话与中止', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-18 同一会话在跑 → 第二次 fire 记 busy 不派发；另一个会话照跑；放行后同会话再 fire 又能跑', async () => {
    const releases: Array<() => void> = []
    mocks.runTask.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve({ result: 'ok' })))
    )

    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    firePrompt({ isDefaultTitle: true })
    await settle()
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
    expect(hasLog('skipped for session s1: busy (previous run still going)')).toBe(true)

    firePrompt({ sessionId: 's2', isDefaultTitle: true })
    await waitRuns(2)
    expect(runs().map((params) => params.parentSessionId)).toEqual(['s1', 's2'])

    for (const release of releases.splice(0)) release()
    await settle()
    firePrompt({ isDefaultTitle: true })
    await waitRuns(3)
    expect(runs()[2].parentSessionId).toBe('s1')
    for (const release of releases.splice(0)) release()
    await settle()
  })

  it('HS-19 abortSessionRuns：中止该会话名下在跑的 run，signal 落下、日志记 aborted；未知会话 → 0', async () => {
    mocks.runTask.mockImplementation(
      (params: RunTaskParams) =>
        new Promise((resolve) => {
          params.parentAbortSignal?.addEventListener(
            'abort',
            () => resolve({ result: 'partial' }),
            { once: true }
          )
        })
    )
    firePrompt({ isDefaultTitle: true })
    await waitRuns(1)
    const signal = runs()[0].parentAbortSignal!
    expect(signal.aborted).toBe(false)

    expect(hookService.abortSessionRuns('nope')).toBe(0)
    expect(hookService.abortSessionRuns('s1')).toBe(1)
    expect(signal.aborted).toBe(true)
    await vi.waitFor(() => {
      expect(logLines().some((line) => /hook "auto-title" run=hkr-\S+ aborted/.test(line))).toBe(
        true
      )
    })
    expect(hookService.abortSessionRuns('s1')).toBe(0)
  })
})

describe('hookService — 设置页列表与目录入口', () => {
  beforeEach(() => {
    hookService.init()
  })

  it('HS-20 列表项只有七个键（被遮蔽的多两个）、不外传正文与绑定；按名字排、同名生效在前', () => {
    put('b.md', userHook('b'))
    put('A.md', userHook('A'))
    put('c.md', userHook('c', { body: 'SECRET BODY TEXT' }))
    put('auto-title.md', userHook('auto-title', { displayName: 'Mine' }))

    const rows = hookService.listForSettings()
    expect(rows.map((item) => [item.name, item.source])).toEqual([
      ['A', 'user'],
      ['auto-title', 'user'],
      ['auto-title', 'builtin'],
      ['b', 'user'],
      ['c', 'user']
    ])
    const baseKeys = [
      'agent',
      'basePath',
      'description',
      'displayName',
      'name',
      'source',
      'triggers'
    ]
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        row.overridden ? [...baseKeys, 'overridden', 'overriddenBy'].sort() : baseKeys
      )
    }
    expect(JSON.stringify(rows)).not.toContain('SECRET BODY TEXT')
  })

  it('HS-21 getUserDir 返回 hooks 目录；openUserFolder 缺目录先建、再交给 shell.openPath', async () => {
    expect(hookService.getUserDir()).toBe(state.dir)
    expect(existsSync(state.dir)).toBe(false)
    await hookService.openUserFolder()
    expect(existsSync(state.dir)).toBe(true)
    expect(mocks.openPath).toHaveBeenCalledTimes(1)
    expect(mocks.openPath).toHaveBeenCalledWith(state.dir)
  })
})
