/**
 * WorkflowService —— 注册表（内置 + 用户覆盖，纯 md 驱动）、
 * 脚本语法门与 run journal 的桌面宿主语义。
 *
 * 观测面 = `.runs/<name>/<runId>.jsonl` journal：meta 记录在 fire 的同步段写盘
 * （engine.executeRun 首个 await 之前），所以「fire 后立即断言 journal 有/无」是
 * 确定性的；end 记录异步落盘，用 vi.waitFor 轮询。
 *
 * 上层句柄（agentManager / agentHost / agentService / sessionService）全 mock —— 这里
 * 测的是宿主装配与缺省规则，编排语义归 agent-runtime 的 engine.test.ts。i18next 与
 * workflowScriptEngine 用真件（语法门是本层职责）。mock 手法照 agentService.test.ts：
 * vi.hoisted + vi.mock + 动态 import（userDir 在构造期捕获，路径须先备好）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TriggerPayloadMap } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ dir: '' }))
const mocks = vi.hoisted(() => ({
  runTask: vi.fn(),
  getProfile: vi.fn(),
  resolveRunModelConfig: vi.fn()
}))

vi.mock('../../utils/paths', () => ({ getDefaultWorkflowsDir: () => state.dir }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { runTask: mocks.runTask } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../sessionService', () => ({
  sessionService: { resolveRunModelConfig: mocks.resolveRunModelConfig }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

type WorkflowServiceModule = typeof import('../workflowService')
let workflowService: WorkflowServiceModule['workflowService']

beforeAll(async () => {
  state.dir = join(mkdtempSync(join(tmpdir(), 'shuvix-wfsvc-')), 'workflows')
  ;({ workflowService } = await import('../workflowService'))
})
afterAll(() => {
  rmSync(join(state.dir, '..'), { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
  mkdirSync(state.dir, { recursive: true })
  mocks.runTask.mockReset().mockImplementation(async () => ({
    result: JSON.stringify({ title: 'T' }),
    structured: { title: 'T' }
  }))
  mocks.getProfile.mockReset().mockImplementation((name: string) => ({
    name,
    displayName: name,
    description: '',
    systemPrompt: 'BODY',
    tools: ['session-config'],
    instructionFiles: [],
    projectAwareness: false,
    dispatchOnly: true,
    source: 'builtin' as const,
    basePath: ''
  }))
  mocks.resolveRunModelConfig
    .mockReset()
    .mockResolvedValue({ provider: 'p', model: 'm', capabilities: {} })
})

// ── journal 观测助手 ──
const runsDirOf = (name: string): string => join(state.dir, '.runs', name)
const runFilesOf = (name: string): string[] =>
  existsSync(runsDirOf(name))
    ? readdirSync(runsDirOf(name)).filter((f) => f.endsWith('.jsonl'))
    : []
const readRecords = (name: string): Array<Record<string, unknown>> =>
  runFilesOf(name).flatMap((f) =>
    readFileSync(join(runsDirOf(name), f), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  )
const waitForEnd = (name: string): Promise<void> =>
  vi.waitFor(() => {
    expect(readRecords(name).some((r) => r.type === 'end')).toBe(true)
  })

const firePrompt = (over: Partial<TriggerPayloadMap['session.prompt-accepted']> = {}): void =>
  workflowService.fire('session.prompt-accepted', {
    sessionId: 's1',
    profileName: 'default',
    title: 'New Chat',
    isDefaultTitle: false,
    promptText: 'hello',
    ...over
  })

/** 最小合法用户工作流 md */
const userWf = (
  name: string,
  opts: { fm?: string[]; script?: string; trigger?: string; when?: string } = {}
): string => {
  const lines = [
    '---',
    'shuvix: workflow v1',
    `name: '${name.replace(/'/g, "''")}'`,
    'shuvix-workflow-on:',
    `  - trigger: ${opts.trigger ?? 'session.prompt-accepted'}`,
    ...(opts.when ? [`    when: '${opts.when}'`] : []),
    ...(opts.fm ?? []),
    '---',
    '',
    '```js workflow',
    opts.script ?? 'return event.promptText',
    '```',
    ''
  ]
  return lines.join('\n')
}

describe('workflowService — 初始化与内置工作流', () => {
  it('init 前 fire → 不抛、零副作用；init 幂等', () => {
    // 本用例必须最先跑：单例尚未 init，fire 应静默丢弃
    expect(() => firePrompt({ isDefaultTitle: true })).not.toThrow()
    expect(existsSync(join(state.dir, '.runs'))).toBe(false)

    workflowService.init()
    expect(() => workflowService.init()).not.toThrow()
    // init 后同一 fire 生效（幂等 init 没有把引擎搞丢）
    firePrompt({ isDefaultTitle: true })
    expect(runFilesOf('auto-title')).toHaveLength(1)
  })

  it('内置出厂即生效：fire 后 auto-title journal 出现，meta/end 各就位且每行带 ts 的合法 JSON', async () => {
    workflowService.init()
    firePrompt({ isDefaultTitle: true })
    await waitForEnd('auto-title')

    const records = readRecords('auto-title')
    for (const r of records) expect(typeof r.ts).toBe('number')
    const meta = records.find((r) => r.type === 'meta')!
    expect(meta.trigger).toBe('session.prompt-accepted')
    expect(meta.source).toBe('builtin')
    expect(meta.sessionId).toBe('s1')
    const end = records.find((r) => r.type === 'end')!
    expect(end.ok).toBe(true)
    expect(end.output).toEqual({ title: 'T' })
    // run 文件名即 runId
    expect(runFilesOf('auto-title')[0]).toMatch(/^wfr-.+\.jsonl$/)
  })

  it('.config.json 已退役：目录里放一份旁路配置也不影响触发（纯 md 驱动）', async () => {
    workflowService.init()
    writeFileSync(
      join(state.dir, '.config.json'),
      JSON.stringify({ disabled: ['auto-title'], autorunEnabled: { 'auto-title': false } })
    )
    firePrompt({ isDefaultTitle: true })
    // 文件在、校验通过 → 照跑；「既在目录里又没启用」这种状态不再存在
    expect(runFilesOf('auto-title')).toHaveLength(1)
    await waitForEnd('auto-title')
  })
})

describe('workflowService — 用户工作流（纯 md 驱动）', () => {
  it('放下一份合法用户工作流即生效：无需任何开关', async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'my-echo.md'), userWf('my-echo'))

    firePrompt() // isDefaultTitle:false → auto-title 不掺和
    expect(runFilesOf('my-echo')).toHaveLength(1)
    await waitForEnd('my-echo')
    expect(readRecords('my-echo').find((r) => r.type === 'end')!.output).toBe('hello')
  })

  it('用户覆盖内置：auto-title.md 用户文件 → meta.source=user 且跑的是用户版', async () => {
    workflowService.init()
    writeFileSync(
      join(state.dir, 'auto-title.md'),
      userWf('auto-title', { when: 'event.isDefaultTitle', script: "return 'USER-VERSION'" })
    )
    firePrompt({ isDefaultTitle: true })
    await waitForEnd('auto-title')

    const records = readRecords('auto-title')
    expect(records.find((r) => r.type === 'meta')!.source).toBe('user')
    expect(records.find((r) => r.type === 'end')!.output).toBe('USER-VERSION')
  })

  it('结构非法用户文件（裸 on）→ 扫描跳过不触发', () => {
    workflowService.init()
    writeFileSync(
      join(state.dir, 'bad-wf.md'),
      [
        '---',
        'shuvix: workflow v1',
        'name: bad-wf',
        'on:',
        '  - trigger: session.prompt-accepted',
        '---',
        '',
        '```js workflow',
        'return 1',
        '```',
        ''
      ].join('\n')
    )
    firePrompt()
    expect(existsSync(runsDirOf('bad-wf'))).toBe(false)
  })

  it('脚本语法错整份拒绝：结构合法但 js workflow 块语法错 → compile 门拦下、不触发', () => {
    workflowService.init()
    writeFileSync(
      join(state.dir, 'syntax-err.md'),
      userWf('syntax-err', { script: 'return ((( oops' })
    )
    firePrompt()
    expect(existsSync(runsDirOf('syntax-err'))).toBe(false)
  })

  it('点开头文件 / 非 .md 文件不当工作流扫描', () => {
    workflowService.init()
    writeFileSync(join(state.dir, '.hidden.md'), userWf('hidden-wf'))
    writeFileSync(join(state.dir, 'not-md.txt'), userWf('txt-wf'))
    firePrompt()
    expect(existsSync(runsDirOf('hidden-wf'))).toBe(false)
    expect(existsSync(runsDirOf('txt-wf'))).toBe(false)
  })

  it('同名用户文件重复 → 每次 fire 恰一个 run（保留先扫到的）', async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'dup1.md'), userWf('dup-wf'))
    writeFileSync(join(state.dir, 'dup2.md'), userWf('dup-wf'))
    firePrompt()
    expect(runFilesOf('dup-wf')).toHaveLength(1)
    await waitForEnd('dup-wf')
  })
})

describe('workflowService — journal 目录名净化（裁决增补 4）', () => {
  it("'a/b:c' → .runs/a-b-c/；'..' → 回落 workflow（不逃出 .runs）", async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'slashy.md'), userWf('a/b:c'))
    writeFileSync(join(state.dir, 'dotty.md'), userWf('..'))
    firePrompt()
    expect(runFilesOf('a-b-c')).toHaveLength(1)
    expect(runFilesOf('workflow')).toHaveLength(1)
    await waitForEnd('a-b-c')
    await waitForEnd('workflow')
    // `.runs` 之外零外溢：净化后的两个目录都在 .runs 内
    expect(readdirSync(join(state.dir, '.runs')).sort()).toEqual(['a-b-c', 'workflow'])
  })
})

describe('workflowService — 模型来源', () => {
  it('工作流不参与选模型：基准恒为会话当前模型（agent 档案的 shuvix-model 在创建管线里优先）', async () => {
    workflowService.init()
    writeFileSync(
      join(state.dir, 'model-wf.md'),
      userWf('model-wf', { script: "return await run('titler', 'p')" })
    )
    firePrompt()
    await waitForEnd('model-wf')

    expect(mocks.resolveRunModelConfig).toHaveBeenCalledWith('s1')
    expect(mocks.runTask.mock.calls[0][0].modelConfig).toEqual({
      provider: 'p',
      model: 'm',
      capabilities: {}
    })
  })

  it('语言跟随：非 en 语言下内置回退不炸（zh 无本地化文件 → 整文件回退 en）', async () => {
    const i18next = (await import('i18next')).default
    if (!i18next.isInitialized) await i18next.init({ lng: 'zh', resources: {} })
    else await i18next.changeLanguage('zh')

    workflowService.init()
    firePrompt({ isDefaultTitle: true })
    expect(runFilesOf('auto-title')).toHaveLength(1)
    await waitForEnd('auto-title')

    await i18next.changeLanguage('en')
  })
})
