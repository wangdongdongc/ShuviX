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
  utimesSync,
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
/** scanDir 的重扫计数（真解析一次 = compile 一次） */
const counters = vi.hoisted(() => ({ compile: 0 }))

vi.mock('../../utils/paths', () => ({ getDefaultWorkflowsDir: () => state.dir }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: { runTask: mocks.runTask } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../sessionService', () => ({
  sessionService: { resolveRunModelConfig: mocks.resolveRunModelConfig }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
/**
 * 脚本引擎用真件（语法门是本层职责），只在外面套一个计数器 —— scanDir 每解析一份
 * 合法用户文件就 compile 一次，所以 compile 次数就是「这一轮真的重扫了吗」的观测面。
 */
vi.mock('../workflowScriptEngine', async () => {
  const actual =
    await vi.importActual<typeof import('../workflowScriptEngine')>('../workflowScriptEngine')
  return {
    nodeVmScriptEngine: {
      compile: (source: string) => {
        counters.compile++
        return actual.nodeVmScriptEngine.compile(source)
      },
      execute: actual.nodeVmScriptEngine.execute
    }
  }
})

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
  counters.compile = 0
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
/** 至少 n 条 end（多 run 场景） */
const waitForEnds = (name: string, n: number): Promise<void> =>
  vi.waitFor(() => {
    expect(readRecords(name).filter((r) => r.type === 'end').length).toBeGreaterThanOrEqual(n)
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
    // run 的身份是 runId 不是文件名 —— 调用路径进 invocation，分道键进 lane
    expect(meta.invocation).toEqual({ kind: 'trigger', trigger: 'session.prompt-accepted' })
    expect(meta.source).toBe('builtin')
    expect(meta.sessionId).toBe('s1')
    expect(meta.lane).toBe('auto-title\u0000s1')
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

describe('workflowService — 目录扫描缓存', () => {
  /**
   * 缓存指纹是「每份文件的 名字:mtimeMs:size」。为了让「同 mtime 同 size 的覆写」
   * 这一类断言**确定性**成立，两次写盘后都把时间戳钉到同一个整毫秒值上 ——
   * 不这么做就得依赖文件系统的时间精度，写出一条随机器抽风的断言。
   */
  const FIXED = new Date(1_700_000_000_000)
  const pin = (fileName: string): void => utimesSync(join(state.dir, fileName), FIXED, FIXED)

  /** 长度相同的两份脚本 —— size 不变，指纹才可能撞上 */
  const echoWf = (name: string, token: string): string =>
    userWf(name, { script: `return '${token}'` })

  const outputsOf = (name: string): unknown[] =>
    readRecords(name)
      .filter((r) => r.type === 'end')
      .map((r) => r.output)

  it('缓存命中：目录未变时连续两次 fire 只解析一次，且两次都照常起 run', async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'cached.md'), userWf('cached'))

    counters.compile = 0
    firePrompt()
    await waitForEnds('cached', 1)
    expect(counters.compile).toBe(1)

    firePrompt()
    await waitForEnds('cached', 2)
    // 第二次 fire 复用了上次的解析结果，但 run 照起
    expect(counters.compile).toBe(1)
    expect(runFilesOf('cached')).toHaveLength(2)
  })

  it('外部编辑（内容与 size 都变）→ 下一次 fire 立即生效（「文件改动即时生效」的承诺不变）', async () => {
    workflowService.init()
    const path = join(state.dir, 'edited.md')
    writeFileSync(path, userWf('edited', { script: "return 'V1'" }))
    firePrompt()
    await waitForEnds('edited', 1)

    writeFileSync(path, userWf('edited', { script: "return 'V2-much-longer-output'" }))
    firePrompt()
    await waitForEnds('edited', 2)
    expect(outputsOf('edited').sort()).toEqual(['V1', 'V2-much-longer-output'])
  })

  it('新增 / 删除文件（names 变化）→ 立即生效', async () => {
    workflowService.init()
    firePrompt()
    expect(existsSync(runsDirOf('late'))).toBe(false)

    const path = join(state.dir, 'late.md')
    writeFileSync(path, userWf('late'))
    firePrompt()
    await waitForEnds('late', 1)

    rmSync(path)
    firePrompt()
    expect(runFilesOf('late')).toHaveLength(1)
  })

  it.each(['save', 'saveByFile'] as const)(
    '本进程覆写路径 %s 显式失效：同 mtime 同 size 的覆写照样立刻生效',
    async (how) => {
      workflowService.init()
      writeFileSync(join(state.dir, 'rewritten.md'), echoWf('rewritten', 'AAA'))
      pin('rewritten.md')
      // 先把缓存喂上旧内容
      expect(workflowService.listForSettings().some((w) => w.name === 'rewritten')).toBe(true)

      const next = echoWf('rewritten', 'BBB')
      const res =
        how === 'save'
          ? workflowService.save('rewritten', next)
          : workflowService.saveByFile('rewritten.md', next)
      expect(res).toEqual({ success: true })
      // 秒级精度的文件系统上，同一秒内同样大小的覆写骗得过指纹 —— 这里把它做成必然
      pin('rewritten.md')

      firePrompt()
      await waitForEnds('rewritten', 1)
      expect(outputsOf('rewritten')).toEqual(['BBB'])
    }
  )

  it.each(['create', 'delete', 'deleteByFile'] as const)(
    '本进程增删路径 %s 显式失效：写盘后紧接着 fire 即生效',
    async (how) => {
      workflowService.init()
      // 先把缓存喂上「目录里有 seed 这一份」
      writeFileSync(join(state.dir, 'seed.md'), userWf('seed'))
      expect(workflowService.listForSettings().some((w) => w.name === 'seed')).toBe(true)

      if (how === 'create') {
        expect(workflowService.create(userWf('fresh'))).toEqual({ success: true, name: 'fresh' })
        firePrompt()
        expect(runFilesOf('fresh')).toHaveLength(1)
        await waitForEnds('fresh', 1)
      } else {
        const res =
          how === 'delete'
            ? workflowService.delete('seed')
            : workflowService.deleteByFile('seed.md')
        expect(res).toEqual({ success: true })
        firePrompt()
        expect(existsSync(runsDirOf('seed'))).toBe(false)
      }
    }
  )

  it('【钉现状 + 风险】外部同 mtime 同 size 的覆写骗得过指纹 → 仍跑旧内容', async () => {
    // 诚实记账缓存的边界：注释只承认了「本进程同秒覆写」，但外部编辑器在 1s 精度的
    // 文件系统（部分容器卷 / 网络盘）上做等长改写同样骗得过它。宿主目前接受这个缺口
    workflowService.init()
    const path = join(state.dir, 'stale.md')
    writeFileSync(path, echoWf('stale', 'AAA'))
    pin('stale.md')
    firePrompt()
    await waitForEnds('stale', 1)

    writeFileSync(path, echoWf('stale', 'BBB'))
    pin('stale.md')
    firePrompt()
    await waitForEnds('stale', 2)
    expect(outputsOf('stale')).toEqual(['AAA', 'AAA'])
  })

  it('缓存不影响设置页视图：非法文件立刻出现在 listInvalid，修好后立刻消失', async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'broken.md'), userWf('broken', { script: 'return ((( oops' }))
    expect(workflowService.listInvalid().map((f) => f.fileName)).toEqual(['broken.md'])

    expect(workflowService.saveByFile('broken.md', userWf('broken'))).toEqual({ success: true })
    expect(workflowService.listInvalid()).toEqual([])
  })

  it('journal 写入（.runs/）不使缓存失效：目录扫描过滤了子目录与点开头文件', async () => {
    workflowService.init()
    writeFileSync(join(state.dir, 'journaled.md'), userWf('journaled'))

    counters.compile = 0
    for (let i = 1; i <= 3; i++) {
      firePrompt()
      await waitForEnds('journaled', i)
    }
    expect(existsSync(join(state.dir, '.runs'))).toBe(true)
    expect(counters.compile).toBe(1)
  })
})

describe('workflowService — run journal 保留策略', () => {
  it('超出上限时按 mtime 剪掉最旧的，最近的一批留下', async () => {
    // 无保留策略不可上线：auto-title 是「每会话每轮一个」，bot 管线会是「每条消息 ×
    // 每个成员一个」—— 一个长期使用的目录会攒出十万级小文件
    writeFileSync(join(state.dir, 'keeper.md'), userWf('keeper', { script: 'return 1' }))
    const dir = runsDirOf('keeper')

    // 先塞满：mtime 递增，名字刻意与时间顺序相反（runId 是 uuid，名字里没有时间）
    mkdirSync(dir, { recursive: true })
    const stale: string[] = []
    for (let i = 0; i < 260; i++) {
      const name = `wfr-${String(260 - i).padStart(4, '0')}.jsonl`
      const path = join(dir, name)
      writeFileSync(path, '{"type":"meta"}\n')
      utimesSync(path, new Date(1_700_000_000_000 + i), new Date(1_700_000_000_000 + i))
      stale.push(name)
    }
    expect(runFilesOf('keeper')).toHaveLength(260)

    // 一次真实 fire：meta 是每个 run 的第一条记录，剪枝挂在它上面
    firePrompt()
    await waitForEnd('keeper')

    const left = runFilesOf('keeper')
    expect(left).toHaveLength(200)
    // 留下的是 mtime 最新的一批（含刚写的这个 run），最旧的那些没了
    expect(left).not.toContain(stale[0])
    expect(left).toContain(stale[stale.length - 1])
  })

  it('未超上限时一个都不删', async () => {
    writeFileSync(join(state.dir, 'small.md'), userWf('small', { script: 'return 1' }))
    firePrompt()
    await waitForEnd('small')
    firePrompt()
    await waitForEnds('small', 2)
    expect(runFilesOf('small')).toHaveLength(2)
  })
})

describe('workflowService — auto-title 双会话回归（宿主端）', () => {
  it('两个会话各 fire 一次 → .runs/auto-title/ 下出现两个 runId 文件', async () => {
    // 分道之前第二个会话会被静默 skip（键是文件名）——那正是 refine 相位永久丢标题的成因
    workflowService.init()
    firePrompt({ sessionId: 's1', isDefaultTitle: true })
    firePrompt({ sessionId: 's2', isDefaultTitle: true })

    expect(runFilesOf('auto-title')).toHaveLength(2)
    await waitForEnds('auto-title', 2)
    const lanes = readRecords('auto-title')
      .filter((r) => r.type === 'meta')
      .map((r) => r.lane)
      .sort()
    expect(lanes).toEqual(['auto-title\u0000s1', 'auto-title\u0000s2'])
  })
})
