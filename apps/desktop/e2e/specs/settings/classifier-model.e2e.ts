/**
 * 命令分类模型（设置 → 通用 → 默认模型 →「分类模型」，`general.classifierProvider` / `general.classifierModel`）——
 * 清单是已启用提供商目录里的 classifier 类模型（`provider.listClassifierModels`），选中后每条命令在策略求值前
 * 过一次分类（结果作为 `object.risk`）。
 *
 *   CM-E-1 全新实例：内置提供商都没启用 → 清单为空；设置行写着「Off」，没有清除钮
 *   CM-E-2 启用 openrouter → 清单里有它的 Jev（providerId 是行 id、providerName 是行的显示名），全部挂在
 *          openrouter 行下，且没有一个出现在对话模型清单（listAvailableModels）里；停用 → 清单又空
 *   CM-E-3 重新启用、毁窗重开（清单只在页面挂载时取）→ 在面板里选 Jev → 两个设置键都写下；触发钮显示它、
 *          有标题为「Off」的清除钮；点清除 → 两个键都回到 ''，触发钮回到「Off」
 *   CM-E-4 选回 Jev、真重启（同一个 HOME）→ 两个键还在，设置行仍显示 Jev
 *   CM-E-5 接线（不发任何分类请求）：Jev 配在**没有 key** 的 openrouter 行上、沙箱关着，脚本化的 bash `ls`
 *          照旧问（ask-on-command，installAutoAllow 点允许）并跑完；分类器日志（`classifierLog.list`）里恰一行：
 *          command-risk / 摘要 ls / failed / openrouter / Jev / 这次 bash 调用的 id / 会话标题 / 没有答案 /
 *          错误是「没有 key」；详情的 request 是 state（ls、bash、没圈住）+ 一道 12 选项的单选；主进程日志里
 *          有分类器「没有完成（failed）」的告警（pi 在认证那一步就停下，一次请求都不发）；这条命令的
 *          security_decision 不带 commandRisk —— 证明 index.ts → toolContext → commandClassifier →
 *          classifier_logs 这条注入线是通的
 *   CM-E-6 再来两条 bash：分类器日志多两行（新的在前）；同一个原因主进程日志里只告警过一次
 *
 * **不发真请求**：实例继承 vitest 进程的环境，而桌面模型注册表对内置提供商仍会读 env 里的 key（pi 的
 * envApiKeyAuth，空串 = 没设）—— 所以每次启动都把各家 key 的环境变量置空（harness 的 PROVIDER_KEY_ENV）。
 * 真正打到 System One 的整条路需要 harness 支持 fetch 重定向，这里不做（见设计稿 C 段）。
 * DOM 只经 pages.ts 的 classifierModelPane；界面语言钉成 en。用例按顺序接力。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { listTargets, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import { classifierModelPane } from '../../harness/pages'
import { PROVIDER_KEY_ENV } from '../../harness/providerEnv'
import {
  asksRaisedIn,
  autoAllowed,
  eventRecorder,
  installAutoAllow,
  securityDecisions,
  seedFakeProvider,
  setSandboxEnabled,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const PROVIDER_KEY = 'general.classifierProvider'
const MODEL_KEY = 'general.classifierModel'
const JEV = '~typesafe/jev-latest'
const OFF = en.settings.classifierModelNone
const MODEL = 'e2e-model'
/** 命令风险分类的 12 个类别（agent-runtime 的 COMMAND_RISK_CATEGORIES，顺序即题目里选项的顺序） */
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

interface ClassifierLogRow {
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

const classifierLogs = (sessionId: string): Promise<ClassifierLogRow[]> =>
  live().main.eval<ClassifierLogRow[]>(
    `window.api.classifierLog.list(${JSON.stringify({ sessionId })})`
  )

/** 主进程日志里分类器「没有完成」的告警行数 */
const failureWarnings = (log: string): number =>
  log.split('\n').filter((line) => line.includes('命令分类没有完成')).length

/** 让一条会话跑一个脚本化的 bash 调用（之后一句 done 收尾），等这一轮落定 */
async function runBash(
  events: EventRecorder,
  sid: string,
  callId: string,
  command: string
): Promise<void> {
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
  const since = await events.mark()
  await live().main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: `run ${command}` })}).catch(() => undefined), true)`
  )
  await events.waitFor('agent_end', { sessionId: sid, since })
}

interface ClassifierEntry {
  id: string
  providerId: string
  modelId: string
  isEnabled: number
  providerName?: string
}

interface ProviderRow {
  id: string
  name: string
  displayName?: string
  isBuiltin: number | boolean
  isEnabled: number | boolean
}

let app: E2EApp | undefined
let settings: CdpClient | undefined
let provider: FakeProvider | undefined
/** 内置 openrouter 行的 id（新库可能是 uuid，所以从 listAll 现查） */
let openrouterId = ''
let openrouterLabel = ''
/** CM-E-5 装好的事件记录器（CM-E-6 接着用） */
let cmE5Events: EventRecorder | undefined

const live = (): E2EApp => {
  if (!app) throw new Error('app not running')
  return app
}

const classifierModels = (): Promise<ClassifierEntry[]> =>
  live().main.eval<ClassifierEntry[]>('window.api.provider.listClassifierModels()')

const setting = (key: string): Promise<unknown> =>
  live().main.eval(`window.api.settings.get(${JSON.stringify(key)})`)

const setOpenRouterEnabled = (isEnabled: boolean): Promise<unknown> =>
  live().main.eval(
    `window.api.provider.toggleEnabled(${JSON.stringify({ id: openrouterId, isEnabled })})`
  )

async function boot(home?: string): Promise<void> {
  app = await launchApp({ ...(home ? { home } : {}), env: PROVIDER_KEY_ENV })
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
}

/** 毁掉设置窗口（openSettings 对已存在的窗口只聚焦，清单只在页面挂载时取），等它从 /json 里消失 */
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

async function reopenSettings(): Promise<ReturnType<typeof classifierModelPane>> {
  await closeSettings()
  settings = await live().openSettings('general')
  const pane = classifierModelPane(settings)
  await pane.ready()
  return pane
}

beforeAll(async () => {
  await boot()
  const rows = await live().main.eval<ProviderRow[]>('window.api.provider.listAll()')
  const row = rows.find((r) => r.isBuiltin && r.name === 'openrouter')
  if (!row) throw new Error('builtin provider row openrouter not seeded')
  openrouterId = row.id
  openrouterLabel = row.displayName || row.name
}, 120_000)

afterAll(async () => {
  await closeSettings().catch(() => undefined)
  await app?.stop()
  await provider?.close()
})

describe('命令分类模型：设置行 → 清单 → 设置键 → 注入线', () => {
  it('CM-E-1 全新实例：清单为空，设置行写着 Off、没有清除钮', async () => {
    expect(await classifierModels()).toEqual([])
    expect(await setting(PROVIDER_KEY)).toBeFalsy()
    expect(await setting(MODEL_KEY)).toBeFalsy()

    const pane = await reopenSettings()
    expect(OFF).toBe('Off')
    expect(await pane.triggerText()).toBe(OFF)
    expect(await pane.hasClear()).toBe(false)
  })

  it('CM-E-2 启用 openrouter → 清单里有 Jev（挂在 openrouter 行下，都不在对话模型清单里）；停用 → 清单又空', async () => {
    await setOpenRouterEnabled(true)
    const list = await until(async () => {
      const entries = await classifierModels()
      return entries.length > 0 ? entries : null
    }, 'classifier models listed after enabling openrouter')
    expect(list).toContainEqual(
      expect.objectContaining({
        id: `${openrouterId}:${JEV}`,
        providerId: openrouterId,
        modelId: JEV,
        providerName: openrouterLabel
      })
    )
    expect(new Set(list.map((m) => m.providerId))).toEqual(new Set([openrouterId]))

    const chat = await live().main.eval<Array<{ providerId: string; modelId: string }>>(
      'window.api.provider.listAvailableModels()'
    )
    const chatKeys = new Set(chat.map((m) => `${m.providerId}/${m.modelId}`))
    expect(list.filter((m) => chatKeys.has(`${m.providerId}/${m.modelId}`))).toEqual([])

    await setOpenRouterEnabled(false)
    await until(async () => (await classifierModels()).length === 0, 'classifier list empty again')
  })

  it('CM-E-3 重新启用、毁窗重开 → 选 Jev：两个键写下、触发钮显示它、清除钮标题是 Off；清除 → 两个键回到空', async () => {
    await setOpenRouterEnabled(true)
    const pane = await reopenSettings()
    expect(await pane.triggerText()).toBe(OFF)

    expect(await pane.pick(openrouterId, JEV)).toBe(true)
    await until(
      async () =>
        (await setting(PROVIDER_KEY)) === openrouterId && (await setting(MODEL_KEY)) === JEV,
      'classifier settings stored'
    )
    await until(async () => (await pane.triggerText()).includes(JEV), 'trigger shows Jev')
    expect(await pane.triggerText()).toContain(openrouterLabel)
    expect(await pane.hasClear()).toBe(true)
    expect(await pane.clearTitle()).toBe(OFF)

    await pane.clear()
    await until(
      async () => (await setting(PROVIDER_KEY)) === '' && (await setting(MODEL_KEY)) === '',
      'classifier settings cleared'
    )
    await until(async () => (await pane.triggerText()) === OFF, 'trigger back to Off')
    expect(await pane.hasClear()).toBe(false)
  })

  it('CM-E-4 选回 Jev、真重启（同一个 HOME）→ 两个键还在，设置行仍显示 Jev', async () => {
    const pane = await reopenSettings()
    expect(await pane.pick(openrouterId, JEV)).toBe(true)
    await until(
      async () =>
        (await setting(PROVIDER_KEY)) === openrouterId && (await setting(MODEL_KEY)) === JEV,
      'classifier settings stored before restart'
    )

    await closeSettings()
    const home = live().home
    await live().stop({ keepHome: true })
    app = undefined
    await boot(home)

    expect(await setting(PROVIDER_KEY)).toBe(openrouterId)
    expect(await setting(MODEL_KEY)).toBe(JEV)
    const after = await reopenSettings()
    await until(
      async () => (await after.triggerText()).includes(JEV),
      'trigger shows Jev after restart'
    )
  })

  it('CM-E-5 接线：Jev 配在没有 key 的 openrouter 行上、沙箱关着 → bash ls 照旧问并跑完；日志里有分类器没完成的告警；决策不带 commandRisk', async () => {
    // 分类模型照 CM-E-4 留着；再写一遍，不靠上一条
    for (const [key, value] of [
      [PROVIDER_KEY, openrouterId],
      [MODEL_KEY, JEV]
    ]) {
      await live().main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)
    }
    const rows = await live().main.eval<Array<ProviderRow & { apiKey?: string }>>(
      'window.api.provider.listAll()'
    )
    const row = rows.find((r) => r.id === openrouterId)
    expect(row?.isEnabled).toBeTruthy()
    expect(row?.apiKey ?? '').toBe('')

    provider = await startFakeProvider()
    await seedFakeProvider(live().main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await setSandboxEnabled(live().main, false)
    const events: EventRecorder = eventRecorder(live().main)
    await events.install()
    await installAutoAllow(live().main)

    const sid = await live().main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'CM-E-5 classifier wiring' })}).then((s) => s.id)`
    )
    const callId = 'call_cm_e5_ls'
    const logBefore = live().mainLog().length
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: callId,
            name: 'bash',
            args: JSON.stringify({ command: 'ls', description: 'list the working directory' })
          }
        ],
        usage: { prompt: 90, completion: 6 }
      },
      { text: 'done', usage: { prompt: 120, completion: 4 } }
    )
    await live().main.eval(
      `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text: 'run ls' })}).catch(() => undefined), true)`
    )
    await events.waitFor('agent_end', { sessionId: sid })

    // 照旧问（ask-on-command）、点了允许、跑完
    expect(await asksRaisedIn(events, sid)).toBe(1)
    expect(await autoAllowed(live().main)).toContain('ls')
    const blocks = (
      await live().main.eval<
        Array<{ blocks?: Array<{ type: string; toolCallId?: string; isError?: boolean }> }>
      >(`window.api.message.list(${JSON.stringify(sid)})`)
    ).flatMap((m) => m.blocks ?? [])
    const block = blocks.find((b) => b.type === 'tool' && b.toolCallId === callId)
    expect(block, 'bash tool block').toBeDefined()
    expect(block!.isError).toBeFalsy()

    // 分类器日志：恰一行，配置齐了但没有 key → failed（pi 在认证那一步就停下，一次请求都不发）
    const logRows = await until(async () => {
      const list = await classifierLogs(sid)
      return list.length > 0 ? list : null
    }, 'classifier log row for CM-E-5')
    expect(logRows).toHaveLength(1)
    expect(logRows[0]).toMatchObject({
      scene: 'command-risk',
      sessionId: sid,
      sessionTitle: 'CM-E-5 classifier wiring',
      toolCallId: callId,
      subject: 'ls',
      provider: 'openrouter',
      model: JEV,
      status: 'failed',
      response: ''
    })
    expect(logRows[0].error).toMatch(/No API key|not configured/)

    const detail = await live().main.eval<{ request: string } | undefined>(
      `window.api.classifierLog.get(${JSON.stringify(logRows[0].id)})`
    )
    const request = JSON.parse(detail!.request) as {
      state: Record<string, unknown>
      questions: Record<string, { type: string; criteria: Record<string, string> }>
    }
    expect(request.state).toMatchObject({ command: 'ls', shell: 'bash', sandboxed: false })
    expect(Object.keys(request.questions)).toEqual(['category'])
    expect(request.questions.category.type).toBe('choice')
    expect(Object.keys(request.questions.category.criteria)).toEqual(CATEGORIES)

    // 告警写进主进程日志（按原因只告警一次）
    const log = await until(async () => {
      const text = live().mainLog().slice(logBefore)
      return text.includes('命令分类没有完成') ? text : null
    }, 'classifier warning in the main log')
    expect(log).toMatch(/命令分类没有完成（failed）/)

    // 这条命令的决策：ask-on-command 问、人允许，没有 commandRisk
    const decisions = securityDecisions(live()).filter(
      (d) => d.sessionId === sid && d.objectKind === 'command'
    )
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      winning: 'ask-on-command#0',
      effect: 'ask',
      userResponse: 'allowed'
    })
    expect((decisions[0] as { commandRisk?: unknown }).commandRisk).toBeUndefined()
    cmE5Events = events
  })

  it('CM-E-6 再来两条 bash：分类器日志多两行（新的在前，各自的调用 id）；同一个原因主进程日志里只告警过一次', async () => {
    const events = cmE5Events!
    const sid = await live().main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'CM-E-6 two commands' })}).then((s) => s.id)`
    )
    const logBefore = live().mainLog().length
    provider!.reset()
    await runBash(events, sid, 'call_cm_e6_pwd', 'pwd')
    await runBash(events, sid, 'call_cm_e6_date', 'date')

    const rows = await until(async () => {
      const list = await classifierLogs(sid)
      return list.length >= 2 ? list : null
    }, 'two classifier log rows for CM-E-6')
    expect(rows.map((r) => [r.subject, r.toolCallId, r.status])).toEqual([
      ['date', 'call_cm_e6_date', 'failed'],
      ['pwd', 'call_cm_e6_pwd', 'failed']
    ])
    expect(failureWarnings(live().mainLog().slice(logBefore))).toBeLessThanOrEqual(1)
    // 这个实例（CM-E-4 重启之后）从头到尾：同一个原因只告警了一次
    expect(failureWarnings(live().mainLog())).toBe(1)
  })
})
