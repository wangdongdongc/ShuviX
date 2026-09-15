/**
 * Hook 注册表的 IPC 面 + runner 的跳过路径（隔离实例，不接提供商）。
 *
 * 裸实例没有任何模型：hook 能匹配埋点、能解析出 agent，派发在 resolveRunModel 处止步 —— 一条
 * `no-model` 跳过行就是「埋点 → 注册表 → runner」一路走通到派发门口的证据；查无此 agent 则在模型
 * 之前就跳过（`unknown-agent`）。跳过原因只进主进程日志（`app.mainLog()`），行形如
 * `hook "<name>" skipped for session <sid>: <reason> (<detail>)`。跳过行不带埋点 id，所以拿只绑
 * turn-completed 的 echo 当每一轮的同步栅栏。
 *
 * 用例有顺序依赖：HR-4 接着 HR-3 的会话；HR-5 ~ HR-7 在前面留下的文件上继续。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { REGISTRY_NOTE_PROJECT_IDS, openRegistryNote } from '../../harness/seed'

const HOOKS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.hook
const PROMPT_ACCEPTED = 'session.prompt-accepted'
const TURN_COMPLETED = 'session.turn-completed'

interface HookItem {
  name: string
  displayName: string
  description: string
  agent: string
  triggers: string[]
  source: 'builtin' | 'user'
  basePath: string
  overridden?: boolean
  overriddenBy?: string
}

type SourceResult = { text: string } | { error: string }
type WriteResult = { success: boolean; name?: string; error?: string }

interface Binding {
  trigger: string
  when?: string
}

const md = (frontmatter: string[], body = 'Body.'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

const hookMd = (name: string, opts: { agent: string; on: Binding[]; body?: string }): string =>
  md(
    [
      'shuvix: hook v1',
      `name: ${name}`,
      `shuvix-hook-agent: ${opts.agent}`,
      'shuvix-hook-on:',
      ...opts.on.flatMap((b) => [
        `  - trigger: ${b.trigger}`,
        ...(b.when ? [`    when: ${b.when}`] : [])
      ])
    ],
    opts.body
  )

/** 解析不过的六份 → 解析器原因里的特征短语（原因末尾恒有 `the whole file is rejected`） */
const INVALID_REASONS: Record<string, string> = {
  'bad-binding.md': "unknown key 'agent' — a binding has only trigger and when",
  'bad-cel.md': 'invalid when CEL',
  'bad-on.md': "bare 'on' key",
  'base-agent.md': 'names a session base profile',
  'no-marker.md': "missing file marker 'shuvix: hook v1'",
  'unknown-key.md': "unknown key 'shuvix-hook-timeout'"
}

let app: E2EApp
/** HR-3 / HR-4 共用的会话 */
let sid = ''

const hookPath = (fileName: string): string => join(app.hooksDir, fileName)
const dirFiles = (): string[] => readdirSync(app.hooksDir).sort()
const listHooks = (): Promise<HookItem[]> => app.main.eval('window.api.hook.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.hook.listInvalid()')
const getSource = (name: string, source: 'builtin' | 'user'): Promise<SourceResult> =>
  app.main.eval(`window.api.hook.getSource(${JSON.stringify({ name, source })})`)
const createHook = (text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.hook.create(${JSON.stringify({ text })})`)
const deleteHook = (name: string): Promise<WriteResult> =>
  app.main.eval(`window.api.hook.delete(${JSON.stringify({ name })})`)
const deleteHookFile = (fileName: string): Promise<WriteResult> =>
  app.main.eval(`window.api.hook.deleteByFile(${JSON.stringify({ fileName })})`)
const createSession = (): Promise<string> =>
  app.main.eval<string>(`window.api.session.create({}).then((s) => s.id)`)
/** 发 prompt 不等它：隔离实例没有模型，失败照吞；埋点在派发前后照常触发 */
const promptTolerant = (target: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: target, text })}).catch(() => undefined), true)`
  )

const logLines = (): string[] => app.mainLog().split('\n')
const linesWith = (needle: string): string[] => logLines().filter((l) => l.includes(needle))
const skipLine = (hook: string, target: string, reason: string): string =>
  `hook "${hook}" skipped for session ${target}: ${reason}`
/** 等某一行（子串）在日志里出现到 n 次，回命中的行 */
const untilLines = (needle: string, n: number, what: string): Promise<string[]> =>
  until(() => {
    const hits = linesWith(needle)
    return hits.length >= n ? hits : null
  }, what)

beforeAll(async () => {
  app = await launchApp()
  mkdirSync(app.hooksDir, { recursive: true })
  const seeds: Record<string, string> = {
    // 合法：echo 每轮都起（派 explore → 无模型跳过，当栅栏）；ghost 点名一个不存在的 agent；
    // inert 绑了这个版本不认识的埋点 —— 绑定惰性化而不是判非法
    'echo.md': hookMd('echo', { agent: 'explore', on: [{ trigger: TURN_COMPLETED }] }),
    'ghost.md': hookMd('ghost', { agent: 'ghost', on: [{ trigger: PROMPT_ACCEPTED }] }),
    'inert.md': hookMd('inert', { agent: 'explore', on: [{ trigger: 'session.never' }] }),
    // 非法：各撞一条解析纪律
    'bad-on.md': md([
      'shuvix: hook v1',
      'name: bad-on',
      'shuvix-hook-agent: explore',
      'on:',
      `  - trigger: ${TURN_COMPLETED}`
    ]),
    'base-agent.md': hookMd('base-agent', { agent: 'work', on: [{ trigger: TURN_COMPLETED }] }),
    'no-marker.md': md([
      'shuvix: agent v1',
      'name: no-marker',
      'shuvix-hook-agent: explore',
      'shuvix-hook-on:',
      `  - trigger: ${TURN_COMPLETED}`
    ]),
    'bad-cel.md': hookMd('bad-cel', {
      agent: 'explore',
      on: [{ trigger: TURN_COMPLETED, when: 'event.turnCount ==' }]
    }),
    'unknown-key.md': md([
      'shuvix: hook v1',
      'name: unknown-key',
      'shuvix-hook-agent: explore',
      'shuvix-hook-timeout: 5',
      'shuvix-hook-on:',
      `  - trigger: ${TURN_COMPLETED}`
    ]),
    'bad-binding.md': md([
      'shuvix: hook v1',
      'name: bad-binding',
      'shuvix-hook-agent: explore',
      'shuvix-hook-on:',
      `  - trigger: ${TURN_COMPLETED}`,
      '    agent: explore'
    ])
  }
  for (const [fileName, text] of Object.entries(seeds)) writeFileSync(hookPath(fileName), text)
})

afterAll(async () => {
  await app?.stop()
})

describe('hook IPC 面与注册表', () => {
  it('HR-1 preload 的 window.api.hook 恰好八个方法；workflow 命名空间与旧的写路径方法都不在了', async () => {
    const keys = await app.main.eval<string[]>('Object.keys(window.api.hook).sort()')
    expect(keys).toEqual([
      'create',
      'delete',
      'deleteByFile',
      'getSource',
      'list',
      'listInvalid',
      'openFolder',
      'openNote'
    ])
    expect(await app.main.eval<string>('typeof window.api.workflow')).toBe('undefined')
    const retired = await app.main.eval<string[]>(
      `['save', 'saveByFile', 'getSourceByFile', 'update', 'setEnabled'].map((k) => typeof window.api.hook[k])`
    )
    expect(retired).toEqual(Array(5).fill('undefined'))
  })

  it('HR-2 列表：内置 auto-title（titler、两个埋点、无文件）+ 合法用户文件；getSource 只回内置原文；六份非法文件带解析器原因', async () => {
    const hooks = await listHooks()
    const autoTitle = hooks.filter((h) => h.name === 'auto-title')
    expect(autoTitle).toHaveLength(1)
    expect(autoTitle[0]).toMatchObject({
      source: 'builtin',
      agent: 'titler',
      triggers: [PROMPT_ACCEPTED, TURN_COMPLETED],
      basePath: ''
    })
    expect(autoTitle[0].overridden).toBeFalsy()
    expect(autoTitle[0].displayName).not.toBe('')
    expect(autoTitle[0].description).not.toBe('')

    const builtinSource = await getSource('auto-title', 'builtin')
    expect(builtinSource).toHaveProperty('text')
    const text = (builtinSource as { text: string }).text
    for (const needle of [
      'shuvix: hook v1',
      'shuvix-hook-agent: titler',
      'when: event.isDefaultTitle',
      'when: event.titleAutoGenerated && event.turnCount == 2 && event.textMessageCount >= 3'
    ]) {
      expect(text).toContain(needle)
    }
    expect(await getSource('auto-title', 'user')).toHaveProperty('error')
    expect(await getSource('no-such-hook', 'builtin')).toHaveProperty('error')

    for (const name of ['echo', 'ghost', 'inert']) {
      expect(hooks.find((h) => h.name === name)).toMatchObject({
        source: 'user',
        basePath: hookPath(`${name}.md`)
      })
    }
    expect(hooks.find((h) => h.name === 'ghost')?.agent).toBe('ghost')
    expect(hooks.find((h) => h.name === 'inert')?.triggers).toEqual(['session.never'])

    const invalid = await listInvalid()
    expect(invalid.map((f) => f.fileName).sort()).toEqual(Object.keys(INVALID_REASONS).sort())
    for (const f of invalid) {
      expect(f.error).toContain(INVALID_REASONS[f.fileName])
      expect(f.error).toContain('rejected')
    }
    const names = hooks.map((h) => h.name)
    for (const fileName of Object.keys(INVALID_REASONS)) {
      expect(names).not.toContain(fileName.slice(0, -3))
    }
  })
})

describe('runner 的跳过路径（只进主进程日志）', () => {
  it('HR-3 首条 prompt 到达 runner：auto-title 与 echo 因无模型跳过，ghost 因查无 agent 跳过；惰性与非法的从不出现，本会话没有任何 run', async () => {
    sid = await createSession()
    await promptTolerant(sid, 'hello')

    const [quick] = await untilLines(
      skipLine('auto-title', sid, 'no-model'),
      1,
      'auto-title skipped for no model'
    )
    expect(quick).toContain('(no model available for this session)')
    await untilLines(skipLine('echo', sid, 'no-model'), 1, 'turn-1 echo barrier')
    await untilLines(
      `${skipLine('ghost', sid, 'unknown-agent')} (no agent definition named "ghost")`,
      1,
      'ghost skipped for an unknown agent'
    )
    expect(linesWith(`hook "auto-title" skipped for session ${sid}:`)).toHaveLength(1)

    for (const name of ['inert', ...Object.keys(INVALID_REASONS).map((f) => f.slice(0, -3))]) {
      expect(
        logLines().filter(
          (l) => l.includes(`hook "${name}"`) && (l.includes('run=') || l.includes('skipped'))
        )
      ).toEqual([])
    }
    expect(logLines().filter((l) => l.includes('run=') && l.includes(sid))).toEqual([])
    expect(app.mainLog()).toContain('hook runner ready')
  })

  it('HR-4 标题仍是默认值时 quick 每条 prompt 都起；用户改名后不再起', async () => {
    await promptTolerant(sid, 'second')
    await untilLines(skipLine('echo', sid, 'no-model'), 2, 'turn-2 echo barrier')
    await untilLines(
      `hook "auto-title" skipped for session ${sid}:`,
      2,
      'quick reached the runner again'
    )
    expect(linesWith(`hook "auto-title" skipped for session ${sid}:`)).toHaveLength(2)

    await app.main.eval(
      `window.api.session.updateTitle(${JSON.stringify({ id: sid, title: 'Renamed by user' })})`
    )
    await promptTolerant(sid, 'third')
    await untilLines(skipLine('echo', sid, 'no-model'), 3, 'turn-3 echo barrier')
    await sleep(500)
    expect(linesWith(`hook "auto-title" skipped for session ${sid}:`)).toHaveLength(2)
  })
})

describe('写路径', () => {
  it('HR-5 create 写盘前校验、文件名由 name 净化派生；重名拒绝；delete 按名删、查无此名失败', async () => {
    const before = dirFiles()
    const rejected = await createHook(
      md([
        'shuvix: hook v1',
        'name: never-written',
        'shuvix-hook-agent: explore',
        'on:',
        `  - trigger: ${TURN_COMPLETED}`
      ])
    )
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain("bare 'on' key")
    expect(dirFiles()).toEqual(before)

    const text = hookMd('my/hook', { agent: 'explore', on: [{ trigger: TURN_COMPLETED }] })
    expect(await createHook(text)).toEqual({ success: true, name: 'my/hook' })
    expect(readFileSync(hookPath('my-hook.md'), 'utf8')).toBe(text)
    expect((await listHooks()).find((h) => h.name === 'my/hook')).toMatchObject({
      source: 'user',
      basePath: hookPath('my-hook.md')
    })

    expect(await createHook(text)).toEqual({
      success: false,
      error: 'Hook "my/hook" already exists'
    })
    expect(dirFiles()).toEqual([...before, 'my-hook.md'].sort())

    expect(await deleteHook('my/hook')).toEqual({ success: true })
    expect(existsSync(hookPath('my-hook.md'))).toBe(false)
    expect((await deleteHook('nope')).success).toBe(false)
  })

  it('HR-6 同名合法用户文件生效（runtime 跟着列表走）、同名第二份只作展示；删掉之后内置回来', async () => {
    const override = hookMd('auto-title', { agent: 'ghost', on: [{ trigger: PROMPT_ACCEPTED }] })
    expect(await createHook(override)).toEqual({ success: true, name: 'auto-title' })
    let rows = (await listHooks()).filter((h) => h.name === 'auto-title')
    expect(rows.find((h) => h.source === 'builtin')).toMatchObject({
      overridden: true,
      overriddenBy: 'auto-title.md'
    })
    const active = rows.find((h) => h.source === 'user')
    expect(active?.basePath).toBe(hookPath('auto-title.md'))
    expect(active?.overridden).toBeFalsy()

    const first = await createSession()
    await promptTolerant(first, 'override one')
    await untilLines(
      `${skipLine('auto-title', first, 'unknown-agent')} (no agent definition named "ghost")`,
      1,
      'the user copy (agent ghost) is what fires'
    )

    // 同名第二份：文件名不是这个名字，输给 auto-title.md —— 列出来但不生效
    writeFileSync(
      hookPath('zz.md'),
      hookMd('auto-title', { agent: 'explore', on: [{ trigger: PROMPT_ACCEPTED }] })
    )
    rows = (await listHooks()).filter((h) => h.name === 'auto-title')
    expect(rows).toHaveLength(3)
    expect(rows.find((h) => h.basePath === hookPath('zz.md'))).toMatchObject({
      source: 'user',
      agent: 'explore',
      overridden: true,
      overriddenBy: 'auto-title.md'
    })

    const second = await createSession()
    await promptTolerant(second, 'override two')
    await untilLines(
      `${skipLine('auto-title', second, 'unknown-agent')} (no agent definition named "ghost")`,
      1,
      'still the canonical user copy after zz.md appears'
    )
    await untilLines(skipLine('echo', second, 'no-model'), 1, 'turn barrier')
    expect(linesWith(`hook "auto-title" skipped for session ${second}:`)).toHaveLength(1)

    expect(await deleteHookFile('zz.md')).toEqual({ success: true })
    expect(await deleteHook('auto-title')).toEqual({ success: true })
    expect(existsSync(hookPath('auto-title.md'))).toBe(false)
    rows = (await listHooks()).filter((h) => h.name === 'auto-title')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()

    const third = await createSession()
    await promptTolerant(third, 'builtin again')
    await untilLines(
      skipLine('auto-title', third, 'no-model'),
      1,
      'builtin auto-title in effect again'
    )
  })

  it('HR-7 openNote / deleteByFile 只认 hooks 目录下已存在的单个 .md：非法文件照样能打开去修、重复打开同一条会话；穿越 / 子目录 / 隐藏 / 不存在一律拒绝且不动文件', async () => {
    const opened = await openRegistryNote(app.main, 'hook', 'bad-cel.md')
    expect(opened).toMatchObject({
      ok: true,
      projectId: HOOKS_PROJECT,
      notebookPath: 'bad-cel.md',
      workingDirectory: app.hooksDir
    })
    const again = await openRegistryNote(app.main, 'hook', 'bad-cel.md')
    expect(again.ok && opened.ok && again.id === opened.id).toBe(true)

    // 前三个名字背后真有文件 —— 拒绝它们的是白名单，不是「文件不存在」
    const real: Record<string, string> = {
      '../../evil.md': join(app.home, 'evil.md'),
      'sub/x.md': hookPath(join('sub', 'x.md')),
      '.hidden.md': hookPath('.hidden.md')
    }
    mkdirSync(hookPath('sub'), { recursive: true })
    for (const [fileName, filePath] of Object.entries(real))
      writeFileSync(filePath, `KEEP ${fileName}`)

    for (const fileName of [...Object.keys(real), 'nope.md']) {
      const outcome = await openRegistryNote(app.main, 'hook', fileName)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain('Invalid hook file')
      expect((await deleteHookFile(fileName)).success).toBe(false)
    }
    for (const [fileName, filePath] of Object.entries(real)) {
      expect(readFileSync(filePath, 'utf8')).toBe(`KEEP ${fileName}`)
    }
    expect(existsSync(hookPath('nope.md'))).toBe(false)

    expect(await deleteHookFile('unknown-key.md')).toEqual({ success: true })
    expect(existsSync(hookPath('unknown-key.md'))).toBe(false)
    expect((await listInvalid()).map((f) => f.fileName)).not.toContain('unknown-key.md')

    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(HOOKS_PROJECT)
  })
})
