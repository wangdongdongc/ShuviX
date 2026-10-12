/**
 * 分类器日志（classifier_logs，迁移 v32；设置 → 监控 → 分类器）—— 每次调用分类模型一行，与场景无关；
 * 今天只有命令风险分类（scene `command-risk`）。IPC 是 `window.api.classifierLog.{list,get,scenes,clear}`。
 *
 *   CL-E-1 全新实例：list / scenes 都空；`monitor/classifierLogs` 停在第二个子 tab，页上是工具栏 + 空态，
 *          清空钮禁用，提示行带上限 5000
 *   CL-E-2 不发任何网络请求地造出日志：分类模型指向**停用着**的内置 openrouter 行（新库的缺省）+ Jev →
 *          两条脚本化的 bash（ls、pwd）→ 两行 misconfigured（provider = 行名、ms 0、错误说停用了）；
 *          启用 openrouter（没有 key）→ 第二个会话里第三条命令 → 一行 failed（没有 key）；scenes = [command-risk]
 *   CL-E-3 页上三行、新的在前、与 list() 同序；场景标签、对象摘要、状态标签、data-status
 *   CL-E-4 展开 ls 那行：状态 + 错误框、12 个选项按类别顺序且一个都没选中、发送内容里有 "command": "ls"、
 *          没有原始答案；再点收起；换一行展开时只开着一行
 *   CL-E-5 经界面筛选（状态、会话）：行与 IPC 带同样参数查出来的一致
 *   CL-E-6 清空：取消 → 还在；确认 → 空（IPC 与页面都空）
 *   CL-E-7 停机、往库里直接插一行 ok 的和一行不认识场景的、再起：ok 行的摘要是 `read_only 93%`，展开后
 *          read_only 选中且带 93%；不认识的场景显示原名，也出现在场景筛选里
 *   CL-E-8 沙箱可用时：圈在沙箱里的 `ls`（不问）照样记一行（state.sandboxed = true）
 *
 * **不发真请求**：每次启动都把各家内置提供商的 key 环境变量置空（harness 的 PROVIDER_KEY_ENV）；
 * openrouter 行上从来没有 key —— 分类要么在「行停用了」那一步停下（misconfigured），要么 pi 在认证那一步
 * 停下（failed），都到不了网络。对话走 fakeProvider。DOM 只经 pages.ts 的 monitorSettingsPane /
 * classifierLogPane；界面语言钉成 en。用例按顺序接力。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { listTargets, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  classifierLogPane,
  confirmPane,
  monitorSettingsPane,
  type ClassifierLogPane
} from '../../harness/pages'
import { PROVIDER_KEY_ENV } from '../../harness/providerEnv'
import {
  autoAllowed,
  eventRecorder,
  installAutoAllow,
  sandboxAvailable,
  seedFakeProvider,
  setSandboxEnabled,
  sqlite,
  sqlLit,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const PROVIDER_KEY = 'general.classifierProvider'
const MODEL_KEY = 'general.classifierModel'
const JEV = '~typesafe/jev-latest'
const MODEL = 'e2e-model'
const T = en.settings.classifierLog

/** 命令风险分类的 12 个类别（agent-runtime 的 COMMAND_RISK_CATEGORIES，题目里选项的顺序） */
const CATEGORIES = [
  'read_only',
  'personal_data',
  'runs_project_code',
  'local_change',
  'outside_change',
  'install',
  'remote_change',
  'data_out',
  'secrets',
  'destructive',
  'privilege',
  'persistence'
]

interface LogRow {
  id: string
  createdAt: number
  scene: string
  sessionId: string
  sessionTitle: string
  toolCallId: string
  subject: string
  provider: string
  model: string
  response: string
  status: string
  error: string
  ms: number
}

interface ProviderRow {
  id: string
  name: string
  isBuiltin: number | boolean
  isEnabled: number | boolean
}

let app: E2EApp | undefined
let settings: CdpClient | undefined
let provider: FakeProvider | undefined
let events: EventRecorder | undefined
let openrouterId = ''
/** CL-E-2 的两条会话 */
const sids = { first: '', second: '' }

const live = (): E2EApp => {
  if (!app) throw new Error('app not running')
  return app
}

const list = (params: Record<string, unknown> = {}): Promise<LogRow[]> =>
  live().main.eval<LogRow[]>(`window.api.classifierLog.list(${JSON.stringify(params)})`)
const scenes = (): Promise<string[]> =>
  live().main.eval<string[]>('window.api.classifierLog.scenes()')

async function boot(home?: string): Promise<void> {
  app = await launchApp({ ...(home ? { home } : {}), env: PROVIDER_KEY_ENV })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  events = eventRecorder(app.main)
  await events.install()
  await installAutoAllow(app.main)
}

/** 毁掉设置窗口（openSettings 对已存在的窗口只聚焦），等它从 /json 里消失 */
async function closeSettings(): Promise<void> {
  if (!settings) return
  await settings.eval('window.close()').catch(() => undefined)
  settings.close()
  settings = undefined
  await until(
    async () =>
      !(await listTargets(live().port)).some(
        (t) => t.type === 'page' && t.url.includes('#settings')
      ) || null,
    'settings window target gone from /json'
  )
}

async function openClassifierPage(): Promise<ClassifierLogPane> {
  await closeSettings()
  settings = await live().openSettings('monitor/classifierLogs')
  const pane = classifierLogPane(settings)
  await pane.ready()
  return pane
}

const createSession = (title: string): Promise<string> =>
  live().main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )

/** 让一条会话跑一个脚本化的 bash 调用（之后一句 done 收尾），等这一轮落定 */
async function runBash(sid: string, callId: string, command: string): Promise<void> {
  provider!.script(
    {
      toolCalls: [
        {
          id: callId,
          name: 'bash',
          args: JSON.stringify({ command, description: `run ${command}` })
        }
      ],
      usage: { prompt: 90, completion: 6 }
    },
    { text: 'done', usage: { prompt: 120, completion: 4 } }
  )
  const since = await events!.mark()
  await live().main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: `run ${command}` })}).catch(() => undefined), true)`
  )
  await events!.waitFor('agent_end', { sessionId: sid, since })
}

beforeAll(async () => {
  await boot()
  const rows = await live().main.eval<ProviderRow[]>('window.api.provider.listAll()')
  const row = rows.find((r) => r.isBuiltin && r.name === 'openrouter')
  if (!row) throw new Error('builtin provider row openrouter not seeded')
  openrouterId = row.id
}, 120_000)

afterAll(async () => {
  await closeSettings().catch(() => undefined)
  await app?.stop()
  await provider?.close()
})

describe('分类器日志：IPC → 页面 → 清空 → 重启', () => {
  it('CL-E-1 全新实例：list / scenes 都空；monitor/classifierLogs 停在第二个子 tab，空态、清空禁用、提示带 5000', async () => {
    expect(await list()).toEqual([])
    expect(await scenes()).toEqual([])

    const pane = await openClassifierPage()
    const ms = await monitorSettingsPane(settings!)
    expect(await ms.subTabCount()).toBe(2)
    expect(await ms.activeSubTab()).toBe(1)
    expect(await ms.page()).toBe('classifierLogs')

    expect(await pane.rows()).toEqual([])
    await until(async () => (await pane.listText()) === T.empty || null, 'empty state shown')
    expect(await pane.clearDisabled()).toBe(true)
    expect(await pane.hint()).toBe(T.hint.replace('{{max}}', '5000'))
  })

  it('CL-E-2 造日志（不发网络请求）：openrouter 停用着 → 两行 misconfigured；启用（没有 key）→ 一行 failed；scenes = [command-risk]', async () => {
    const rows = await live().main.eval<Array<ProviderRow & { apiKey?: string }>>(
      'window.api.provider.listAll()'
    )
    const row = rows.find((r) => r.id === openrouterId)!
    expect(row.isEnabled).toBeFalsy()
    expect(row.apiKey ?? '').toBe('')
    for (const [key, value] of [
      [PROVIDER_KEY, openrouterId],
      [MODEL_KEY, JEV]
    ]) {
      await live().main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)
    }

    provider = await startFakeProvider()
    await seedFakeProvider(live().main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await setSandboxEnabled(live().main, false)

    sids.first = await createSession('CL-E-2 disabled provider')
    await runBash(sids.first, 'call_cle2_ls', 'ls')
    await runBash(sids.first, 'call_cle2_pwd', 'pwd')

    const misconfigured = await until(async () => {
      const found = await list({ sessionId: sids.first })
      return found.length >= 2 ? found : null
    }, 'two misconfigured rows')
    expect(misconfigured).toHaveLength(2)
    expect(misconfigured.map((r) => [r.subject, r.toolCallId])).toEqual([
      ['pwd', 'call_cle2_pwd'],
      ['ls', 'call_cle2_ls']
    ])
    for (const r of misconfigured) {
      expect(r).toMatchObject({
        scene: 'command-risk',
        status: 'misconfigured',
        provider: 'openrouter',
        model: JEV,
        ms: 0,
        response: '',
        sessionTitle: 'CL-E-2 disabled provider'
      })
      expect(r.error).toMatch(/disabled/)
    }
    // 两条命令都问了、都放行了（没圈住、没分类 → ask-on-command）
    expect(await autoAllowed(live().main)).toEqual(expect.arrayContaining(['ls', 'pwd']))

    // 启用 openrouter（还是没有 key）：配置齐了，pi 在认证那一步停下 → failed
    await live().main.eval(
      `window.api.provider.toggleEnabled(${JSON.stringify({ id: openrouterId, isEnabled: true })})`
    )
    sids.second = await createSession('CL-E-2 no key')
    await runBash(sids.second, 'call_cle2_third', 'echo third')
    const failed = await until(async () => {
      const found = await list({ sessionId: sids.second })
      return found.length >= 1 ? found : null
    }, 'one failed row')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      scene: 'command-risk',
      status: 'failed',
      provider: 'openrouter',
      model: JEV,
      subject: 'echo third',
      toolCallId: 'call_cle2_third',
      response: ''
    })
    expect(failed[0].error).toMatch(/No API key|not configured/)

    expect(await list()).toHaveLength(3)
    expect(await scenes()).toEqual(['command-risk'])
  })

  it('CL-E-3 页上三行、新的在前、与 list() 同序；场景标签、对象摘要、状态标签、data-status', async () => {
    const pane = classifierLogPane(settings!)
    await pane.refresh()
    const shown = await pane.waitRowCount(3)
    const ipc = await list()
    expect(shown.map((r) => r.id)).toEqual(ipc.map((r) => r.id))
    expect(shown.map((r) => [r.subject, r.status, r.result])).toEqual([
      ['echo third', 'failed', T.status.failed],
      ['pwd', 'misconfigured', T.status.misconfigured],
      ['ls', 'misconfigured', T.status.misconfigured]
    ])
    for (const r of shown) {
      expect(r.scene).toBe(T.scenes['command-risk'])
      expect(r.ms).toMatch(/^\d+ ms$/)
    }
    expect(shown[1].ms).toBe('0 ms')
    expect(await pane.clearDisabled()).toBe(false)
  })

  it('CL-E-4 展开 ls 那行：状态 + 错误框、12 个选项一个都没选中、发送内容有 "command": "ls"、没有原始答案；收起；换行时只开一行', async () => {
    const pane = classifierLogPane(settings!)
    const [third, pwd, ls] = await pane.rows()
    await pane.toggle(ls.id)
    const detail = await pane.detail(ls.id, [T.sent, T.rawAnswers, T.subject])
    expect(detail.status).toBe(T.status.misconfigured)
    expect(detail.statusTone).toBe('warn')
    expect(detail.error).toMatch(/disabled/)
    expect(detail.meta).toContain(`openrouter/${JEV}`)
    expect(detail.meta).toContain('CL-E-2 disabled provider')
    expect(detail.meta).toContain('call_cle2_ls')
    const options = detail.questions.category
    expect(options.map((o) => o.label)).toEqual(CATEGORIES)
    expect(options.some((o) => o.chosen)).toBe(false)
    expect(detail.sections[T.sent]).toContain('"command": "ls"')
    expect(detail.sections[T.subject]).toBe('ls')
    expect(detail.sections[T.rawAnswers]).toBeUndefined()
    expect(await pane.expandedIds()).toEqual([ls.id])

    await pane.toggle(ls.id)
    await until(async () => (await pane.expandedIds()).length === 0 || null, 'row collapsed')

    await pane.toggle(third.id)
    await pane.detail(third.id, [])
    await pane.toggle(pwd.id)
    await pane.detail(pwd.id, [])
    expect(await pane.expandedIds()).toEqual([pwd.id])
    const failedDetail = await (async () => {
      await pane.toggle(third.id)
      return pane.detail(third.id, [])
    })()
    expect(failedDetail.status).toBe(T.status.failed)
    expect(failedDetail.error).toMatch(/No API key|not configured/)
    expect(await pane.expandedIds()).toEqual([third.id])
    await pane.toggle(third.id)
  })

  it('CL-E-5 经界面筛选：状态 failed、会话各自与 IPC 同参数查出来的一致；回到「全部」又是三行', async () => {
    const pane = classifierLogPane(settings!)
    const statusOptions = await pane.filterOptions(2)
    expect(statusOptions).toEqual([
      T.allStatuses,
      ...['ok', 'incomplete', 'failed', 'timeout', 'aborted', 'misconfigured'].map(
        (s) => T.status[s as keyof typeof T.status]
      )
    ])

    await pane.pickFilter(2, T.status.failed)
    const failedIpc = await list({ status: 'failed' })
    expect(failedIpc).toHaveLength(1)
    await until(
      async () =>
        JSON.stringify((await pane.rows()).map((r) => r.id)) ===
          JSON.stringify(failedIpc.map((r) => r.id)) || null,
      'status filter applied'
    )
    await pane.pickFilter(2, T.allStatuses)
    await pane.waitRowCount(3)

    await pane.pickFilter(0, 'CL-E-2 disabled provider')
    const firstIpc = await list({ sessionId: sids.first })
    expect(firstIpc).toHaveLength(2)
    await until(
      async () =>
        JSON.stringify((await pane.rows()).map((r) => r.id)) ===
          JSON.stringify(firstIpc.map((r) => r.id)) || null,
      'session filter applied'
    )
    await pane.pickFilter(0, en.settings.allSessions)
    await pane.waitRowCount(3)

    const sceneOptions = await pane.filterOptions(1)
    expect(sceneOptions).toEqual([T.allScenes, T.scenes['command-risk']])
  })

  it('CL-E-6 清空：取消 → 还在；确认 → IPC 与页面都空', async () => {
    const pane = classifierLogPane(settings!)
    const confirm = confirmPane(settings!)
    await pane.clickClear()
    await confirm.waitOpen()
    expect((await confirm.snapshot()).title).toBe(T.clearConfirm)
    await confirm.cancel()
    await confirm.waitClosed()
    expect(await list()).toHaveLength(3)
    expect(await pane.rows()).toHaveLength(3)

    await pane.clickClear()
    await confirm.waitOpen()
    await confirm.confirm()
    await confirm.waitClosed()
    await pane.waitRowCount(0)
    expect(await list()).toEqual([])
    expect(await scenes()).toEqual([])
    await until(async () => (await pane.listText()) === T.empty || null, 'empty state after clear')
    expect(await pane.clearDisabled()).toBe(true)
  })

  it('CL-E-7 停机插一行 ok 的与一行不认识场景的，再起：ok 摘要 read_only 93%、展开 read_only 选中带 93%；不认识的场景显示原名、也在场景筛选里', async () => {
    await closeSettings()
    const home = live().home
    await live().stop({ keepHome: true })
    app = undefined

    const now = Date.now()
    const probabilities = Object.fromEntries(
      CATEGORIES.map((c) => [c, c === 'read_only' ? 0.93 : c === 'local_change' ? 0.07 : 0])
    )
    const request = JSON.stringify({
      state: { command: 'git status', shell: 'bash', platform: 'darwin', sandboxed: false },
      questions: {
        category: {
          type: 'choice',
          instructions: 'Which one best describes what this shell command does?',
          criteria: Object.fromEntries(CATEGORIES.map((c) => [c, `about ${c}`]))
        }
      }
    })
    const response = JSON.stringify({
      category: { type: 'choice', choice: 'read_only', probabilities, confidence: 0.93 }
    })
    const insert = (row: Record<string, string | number>): void => {
      const keys = Object.keys(row)
      const values = Object.values(row).map((v) => (typeof v === 'number' ? String(v) : sqlLit(v)))
      sqlite(home, `INSERT INTO classifier_logs (${keys.join(', ')}) VALUES (${values.join(', ')})`)
    }
    insert({
      id: '01990000-0000-7000-8000-00000000c1e7',
      createdAt: now,
      scene: 'command-risk',
      sessionId: '',
      toolCallId: 'call_seeded_ok',
      subject: 'git status',
      provider: 'openrouter',
      model: JEV,
      request,
      response,
      status: 'ok',
      ms: 210,
      inputTokens: 57,
      cost: 0.00002
    })
    insert({
      id: '01990000-0000-7000-8000-00000000c1e8',
      createdAt: now - 1000,
      scene: 'mystery-scene',
      subject: 'something else',
      provider: 'openrouter',
      model: JEV,
      request: JSON.stringify({ state: { x: 1 }, questions: {} }),
      status: 'failed',
      error: 'error: boom',
      ms: 5
    })

    await boot(home)
    const ipc = await list()
    expect(ipc.map((r) => r.scene)).toEqual(['command-risk', 'mystery-scene'])
    expect(await scenes()).toEqual(['command-risk', 'mystery-scene'])

    const pane = await openClassifierPage()
    const shown = await pane.waitRowCount(2)
    expect(shown.map((r) => [r.scene, r.subject, r.result])).toEqual([
      [T.scenes['command-risk'], 'git status', 'read_only 93%'],
      ['mystery-scene', 'something else', T.status.failed]
    ])

    await pane.toggle(shown[0].id)
    const detail = await pane.detail(shown[0].id, [T.rawAnswers])
    expect(detail.status).toBe(T.status.ok)
    expect(detail.statusTone).toBe('ok')
    expect(detail.error).toBe('')
    const chosen = detail.questions.category.filter((o) => o.chosen)
    expect(chosen.map((o) => o.label)).toEqual(['read_only'])
    expect(chosen[0].text).toContain('93%')
    expect(detail.sections[T.rawAnswers]).toContain('"choice": "read_only"')
    await pane.toggle(shown[0].id)

    expect(await pane.filterOptions(1)).toEqual([
      T.allScenes,
      T.scenes['command-risk'],
      'mystery-scene'
    ])
  })

  it('CL-E-8 沙箱可用时：圈在沙箱里的 ls 不问，照样记一行（state.sandboxed = true）', async (ctx) => {
    if (!(await sandboxAvailable(live().main))) {
      ctx.skip()
      return
    }
    await setSandboxEnabled(live().main, true)
    const asksBefore = (await autoAllowed(live().main)).length
    const sid = await createSession('CL-E-8 confined')
    provider!.reset()
    await runBash(sid, 'call_cle8_ls', 'ls')

    const rows = await until(async () => {
      const found = await list({ sessionId: sid })
      return found.length >= 1 ? found : null
    }, 'classifier log row for the confined command')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ subject: 'ls', toolCallId: 'call_cle8_ls', status: 'failed' })
    const detail = await live().main.eval<{ request: string }>(
      `window.api.classifierLog.get(${JSON.stringify(rows[0].id)})`
    )
    expect(JSON.parse(detail.request).state).toMatchObject({ command: 'ls', sandboxed: true })
    // 圈住了：没有卡片
    expect((await autoAllowed(live().main)).length).toBe(asksBefore)
  })
})
