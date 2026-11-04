/**
 * 组件当 MCP 服务器之后，模型用不用得起来 —— 真模型探针。
 *
 * 起因（2026-11-04）：`widget` 工具不再有 list / describe / call，用组件要先经 `tool_search` 开启，或由用户勾上。用户直接
 * 定了这个方向，没有先比较，所以这里量改完之后的样子：请求里不点名组件时，模型找不找得到它，几步调用对。
 *
 * 三种做法（`CONDITIONS`）：
 *   - search：没勾选，靠提示词里的扩展清单和 `tool_search`，卡片由 `settle` 代答允许；
 *   - ticked：一开始就勾上（用户在选择器里勾，或项目保存的扩展）；
 *   - old-snapshot：勾上，但组件的 API 快照里混进一个带 `$ref` 的操作（老版本构建的）：它不该被声明，请求也不该失败。
 *
 * 两个任务（`SCENARIOS`），都不说「组件」：
 *   - record：「帮我记一笔」，要写，第一次写还会问一张卡；
 *   - total：「午饭一共花了多少」，只读，勾选之后不该有卡。
 *
 * 全是真的：隔离实例、真 `chat` 基座、真 `tool_search`、真组件（先用假 provider 走一遍 create / write / build / sql 造出来，再
 * 换成真模型）。成败从组件自己的 SQLite 文件读，不信模型的话。每个试次一个新实例。不断言（真模型不确定），只写报告：
 * `<PROBE_OUT>/report.md`、`results.jsonl`、`transcripts/<试次>.txt`。
 *
 * 模型：`PROBE_MODELS`（逗号分隔，缺省 deepseek,kimi），key 只从 `~/.shuvix-probe.env` 或环境变量来。
 * 其余旋钮：`PROBE_SCENARIOS`、`PROBE_CONDITIONS`（子集）、`PROBE_REPEAT`（缺省 3）、`PROBE_WORKERS`（缺省 2）。
 *
 * 权限询问只放行不碰真实主目录的（`settle`），沙箱外的命令一律拒绝（同 toolDiscovery.probe.ts 的教训）。
 *
 *   npx electron-vite build
 *   npx vitest run --config vitest.config.probe.ts e2e/live/widgetUse.probe.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { startFakeProvider, type FakeTurn } from '../harness/fakeProvider'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady
} from '../harness/seed'
import { syncProbe } from '../harness/sync'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installPolicy,
  installRealHomeGuard,
  makeDebug,
  sendPrompt,
  settle
} from './redactionProbeShared'

const REPO_ROOT = resolve(process.cwd(), '../..')
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-widget-use-${Date.now()}`)
const REPEAT = Math.max(1, Number(process.env.PROBE_REPEAT ?? '3') || 3)
const WORKERS = Math.max(1, Number(process.env.PROBE_WORKERS ?? '2') || 2)
const TURN_TIMEOUT_MS = 4 * 60 * 1000

const WIDGET = 'expense-log'
const DECOY = 'reading-list'
const SERVER = `widget-${WIDGET}`
const SELECTION = `mcp:${SERVER}`

const NO_UNCONFINED_POLICY = [
  '---',
  'shuvix: policy v1',
  'name: probe-no-unconfined',
  'description: A live probe never runs a command outside the sandbox.',
  'shuvix-policy-scope:',
  '  subject.kind: [agent]',
  '  object.type: [command]',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    action: [execute]',
  '    match: "!has(object.sandboxed) || !object.sandboxed"',
  '    prompt: Commands cannot run outside the sandbox in this environment.',
  '---',
  ''
].join('\n')

interface ModelSpec {
  keyEnv: string
  modelEnv: string
  fallbackModel?: string
  providerId: string
  providerName: string
  apiProtocol: string
}

const MODELS: Record<string, ModelSpec> = {
  deepseek: {
    keyEnv: 'SHUVIX_PROBE_COMPLETIONS_KEY',
    modelEnv: 'SHUVIX_PROBE_COMPLETIONS_MODEL',
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiProtocol: 'openai-completions'
  },
  kimi: {
    keyEnv: 'SHUVIX_PROBE_KIMI_KEY',
    modelEnv: 'SHUVIX_PROBE_KIMI_MODEL',
    fallbackModel: 'kimi-for-coding',
    providerId: 'kimi-coding',
    providerName: 'kimi',
    apiProtocol: 'anthropic-messages'
  }
}

const CONDITIONS = {
  search: { ticked: false, oldSnapshot: false },
  ticked: { ticked: true, oldSnapshot: false },
  'old-snapshot': { ticked: true, oldSnapshot: true }
} as const
type ConditionId = keyof typeof CONDITIONS

const SCENARIOS = {
  record: { prompt: '帮我记一笔：今天午饭花了 38 元。', writes: true },
  total: { prompt: '我的开销记录里，午饭一共花了多少钱？', writes: false }
} as const
type ScenarioId = keyof typeof SCENARIOS

// ─────────────────────────── 组件 ───────────────────────────

const EXPENSE_API = `import { defineApi, op, z } from 'shuvix/widget-api'

const Expense = z.object({ id: z.number(), item: z.string(), amount: z.number(), spentOn: z.string() })

export default defineApi({
  listExpenses: op.read({
    description: 'List recorded expenses, newest first. Pass item to keep only those whose item contains it.',
    input: z.object({ item: z.string().optional() }),
    output: z.array(Expense),
    handler: ({ item }, ctx) =>
      ctx.db.sql\`SELECT id, item, amount, spent_on AS spentOn FROM expenses
        WHERE \${item ?? ''} = '' OR item LIKE '%' || \${item ?? ''} || '%' ORDER BY id DESC\`
  }),
  totalSpent: op.read({
    description: 'The total amount spent. Pass item to count only expenses whose item contains it.',
    input: z.object({ item: z.string().optional() }),
    output: z.object({ total: z.number() }),
    async handler({ item }, ctx) {
      const [row] = await ctx.db.sql\`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
        WHERE \${item ?? ''} = '' OR item LIKE '%' || \${item ?? ''} || '%'\`
      return row
    }
  }),
  addExpense: op.write({
    description: 'Record one expense. Returns it. Calling it twice records it twice.',
    input: z.object({
      item: z.string().min(1).describe('What the money was spent on'),
      amount: z.number().positive(),
      spentOn: z.string().optional().describe('YYYY-MM-DD; today if omitted')
    }),
    output: Expense,
    async handler({ item, amount, spentOn }, ctx) {
      const [row] = await ctx.db.sql\`INSERT INTO expenses (item, amount, spent_on, added_by)
        VALUES (\${item}, \${amount}, \${spentOn ?? ctx.now().slice(0, 10)}, \${ctx.caller.label})
        RETURNING id, item, amount, spent_on AS spentOn\`
      return row
    }
  })
})
`

const EXPENSE_SCHEMA = `CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  item TEXT NOT NULL,
  amount REAL NOT NULL,
  spent_on TEXT NOT NULL,
  added_by TEXT NOT NULL
);
INSERT INTO expenses (item, amount, spent_on, added_by) VALUES
  ('午饭', 30, date('now'), 'seed'),
  ('午饭', 45, date('now'), 'seed'),
  ('午饭', 25, date('now'), 'seed'),
  ('打车', 60, date('now'), 'seed');
`

/** 午饭的种子数据之和：total 任务的正确答案 */
const LUNCH_TOTAL = '100'

const DECOY_API = `import { defineApi, op, z } from 'shuvix/widget-api'

export default defineApi({
  listBooks: op.read({
    description: 'List the books on the reading list.',
    input: z.object({}),
    handler: (_args, ctx) => ctx.db.sql\`SELECT id, title FROM books ORDER BY id\`
  }),
  addBook: op.write({
    description: 'Add a book to the reading list.',
    input: z.object({ title: z.string().min(1) }),
    handler: ({ title }, ctx) => ctx.db.run\`INSERT INTO books (title) VALUES (\${title})\`
  })
})
`

const DECOY_SCHEMA = `CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n`

const SCREEN = `import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (root) createRoot(root).render(<div>probe</div>)
`

const widgetTurns = (
  home: string,
  id: string,
  name: string,
  api: string,
  schema: string
): FakeTurn[] => {
  const dir = join(home, '.shuvix', 'widgets', id)
  const call = (toolName: string, args: Record<string, unknown>): FakeTurn => ({
    toolCalls: [
      {
        id: `seed-${id}-${String(args.action ?? args.path)}`,
        name: toolName,
        args: JSON.stringify(args)
      }
    ]
  })
  const write = (file: string, content: string): FakeTurn =>
    call('write', { path: join(dir, file), content })
  return [
    call('widget', { action: 'create', widget: id, name, description: name }),
    write('api.ts', api),
    write('schema.sql', schema),
    write('index.tsx', SCREEN),
    call('widget', { action: 'build', widget: id, message: 'probe' }),
    call('widget', { action: 'sql', widget: id, sql: schema })
  ]
}

/** 用假 provider 走一遍真正的造组件流程：之后组件和用户造的没有区别 */
async function seedWidgets(app: E2EApp): Promise<void> {
  const provider = await startFakeProvider()
  try {
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: 'probe-seed' })
    const sid = await app.main.eval<string>(
      `window.api.session.create({ title: 'seed widgets' }).then((s) => s.id)`
    )
    provider.script(
      ...widgetTurns(app.home, WIDGET, '开销记录', EXPENSE_API, EXPENSE_SCHEMA),
      ...widgetTurns(app.home, DECOY, '读书清单', DECOY_API, DECOY_SCHEMA),
      { text: 'SEEDED' }
    )
    const probe = syncProbe(app.main)
    await probe.install()
    await sendPrompt(app, sid, 'seed')
    await probe.waitView(
      sid,
      (v) =>
        v.run.state !== 'busy' &&
        v.messages.some((m) => m.role === 'assistant' && m.content.includes('SEEDED')),
      120_000,
      'widgets seeded'
    )
    const rows = dataRows(app, `SELECT COUNT(*) AS n FROM expenses`)
    if (rows[0]?.n !== 4) throw new Error(`seeding left ${JSON.stringify(rows)} expense rows`)
  } finally {
    await provider.close()
  }
}

const dataFile = (app: E2EApp): string =>
  join(app.home, '.shuvix', 'widgets-data', WIDGET, 'data.sqlite')

function dataRows(app: E2EApp, sql: string): Array<Record<string, unknown>> {
  const out = execFileSync('sqlite3', ['-json', dataFile(app), sql], { encoding: 'utf8' })
  return out.trim() ? (JSON.parse(out) as Array<Record<string, unknown>>) : []
}

/** 老版本构建的快照：混进一个带引用的操作。它不该被声明，也不该让请求失败 */
function addOldOperation(app: E2EApp): void {
  const file = join(app.home, '.shuvix', 'widgets-data', WIDGET, 'api.json')
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { ops: unknown[] }
  snapshot.ops.push({
    name: 'oldRecursiveOp',
    mode: 'read',
    description: 'Written by an older build.',
    input: {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } }
    }
  })
  writeFileSync(file, JSON.stringify(snapshot))
}

// ─────────────────────────── 试次 ───────────────────────────

interface Usage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
}

interface SnapshotMessage {
  role: string
  content: string
  usage?: Usage
  blocks: Array<{
    type: string
    text?: string
    toolName?: string
    args?: unknown
    result?: string
    isError?: boolean
  }>
}

interface Plan {
  model: string
  scenario: ScenarioId
  condition: ConditionId
  rep: number
}

interface TrialResult extends Plan {
  id: string
  /** 工具调用的序列（组件的操作写短名） */
  sequence: string
  queries: string[]
  searched: boolean
  loaded: boolean
  /** 第一个不是 tool_search 的工具调用，是不是这个组件的操作 */
  firstIsWidget: boolean
  /** 到第一次调对组件的操作之前有几个别的工具调用 */
  stepsBeforeWidget: number | null
  /** 组件操作的调用失败了几次（参数不对之类） */
  widgetErrors: number
  /** 这次任务真的做成了：record 看数据库里有没有那一行，total 看回答里有没有正确的和 */
  completed: boolean
  cards: { extension: number; widgetRead: number; widgetWrite: number }
  /** 老快照里那个操作有没有被声明（只有 old-snapshot 有意义） */
  oldOpDeclared: boolean | null
  /** 第一次调组件操作的那个请求的缓存命中 */
  cacheHit: number | null
  ms: number
  error?: string
}

const readMessages = (app: E2EApp, sid: string): Promise<SnapshotMessage[]> =>
  app.main.eval<SnapshotMessage[]>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => msgs.map((m) => ({
      role: m.role,
      content: String(m.content ?? ''),
      usage: m.metadata ? m.metadata.usage : undefined,
      blocks: (m.blocks ?? []).map((b) => b.type === 'tool'
        ? { type: 'tool', toolName: b.toolName, args: b.args, result: String(b.result ?? '').slice(0, 1500), isError: b.isError === true }
        : { type: b.type, text: b.text })
    })))
  `)

function transcript(messages: SnapshotMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.content) lines.push(`[${message.role}] ${message.content}`)
    for (const block of message.blocks) {
      if (block.type !== 'tool') continue
      lines.push(`  → ${block.toolName} ${JSON.stringify(block.args ?? {})}`)
      lines.push(`  ← ${block.isError ? '(error) ' : ''}${block.result ?? ''}`)
    }
  }
  return lines.join('\n')
}

const WIDGET_TOOL_PREFIX = `mcp__${SERVER}__`

async function runTrial(
  plan: Plan,
  spec: ModelSpec,
  key: string,
  modelId: string,
  debug: (line: string) => void
): Promise<{ result: TrialResult; text: string }> {
  const id = `${plan.model}-${plan.scenario}-${plan.condition}-${plan.rep}`
  const started = Date.now()
  const condition = CONDITIONS[plan.condition]
  const scenario = SCENARIOS[plan.scenario]
  const result: TrialResult = {
    ...plan,
    id,
    sequence: '',
    queries: [],
    searched: false,
    loaded: false,
    firstIsWidget: false,
    stepsBeforeWidget: null,
    widgetErrors: 0,
    completed: false,
    cards: { extension: 0, widgetRead: 0, widgetWrite: 0 },
    oldOpDeclared: null,
    cacheHit: null,
    ms: 0
  }
  let app: E2EApp | undefined
  let messages: SnapshotMessage[] = []
  let sid = ''
  try {
    app = await launchApp()
    const live = app
    await waitRendererReady(live.main)
    await live.main.eval(`window.api.settings.set({ key: 'general.language', value: 'zh' })`)
    await installRealHomeGuard(live, REPO_ROOT)
    await installPolicy(live, 'probe-no-unconfined', NO_UNCONFINED_POLICY)
    await seedWidgets(live)
    if (condition.oldSnapshot) {
      addOldOperation(live)
      // 组件行有一个短 TTL，等它过期
      await new Promise((done) => setTimeout(done, 5500))
    }
    await seedRealModel(live.main, {
      providerId: spec.providerId,
      providerName: spec.providerName,
      apiKey: key,
      apiProtocol: spec.apiProtocol,
      modelId
    })

    sid = await live.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: `probe ${id}` })}).then((s) => s.id)`
    )
    if (condition.ticked) {
      await live.main.eval(
        `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: [SELECTION] })})`
      )
    }
    const events = eventRecorder(live.main)
    await events.install()
    await sendPrompt(live, sid, scenario.prompt)
    await settle({
      app: live,
      events,
      sid,
      label: id,
      answer: () => '你自己判断，直接做。',
      debug,
      quietMs: 6000,
      timeoutMs: TURN_TIMEOUT_MS
    })
    messages = await readMessages(live, sid)

    const calls = messages.flatMap((message, index) =>
      message.blocks
        .filter((block) => block.type === 'tool' && block.toolName)
        .map((block) => ({ ...block, name: block.toolName as string, message: index }))
    )
    result.sequence = calls
      .map((call) => call.name.replace(WIDGET_TOOL_PREFIX, 'op:').replace(/^mcp__/, ''))
      .join(' ')
    const searches = calls.filter((call) => call.name === 'tool_search')
    result.searched = searches.length > 0
    result.queries = searches.map((call) =>
      String((call.args as { query?: unknown } | undefined)?.query ?? '')
    )
    result.loaded = searches.some((call) => (call.result ?? '').startsWith('Loaded'))
    const others = calls.filter((call) => call.name !== 'tool_search')
    result.firstIsWidget = others[0]?.name.startsWith(WIDGET_TOOL_PREFIX) === true
    const firstWidget = others.findIndex((call) => call.name.startsWith(WIDGET_TOOL_PREFIX))
    result.stepsBeforeWidget = firstWidget < 0 ? null : firstWidget
    result.widgetErrors = others.filter(
      (call) => call.name.startsWith(WIDGET_TOOL_PREFIX) && call.isError === true
    ).length
    const measured = firstWidget < 0 ? undefined : messages[others[firstWidget].message]?.usage
    if (measured) {
      const { input = 0, cacheRead = 0, cacheWrite = 0 } = measured
      const total = input + cacheRead + cacheWrite
      result.cacheHit = total > 0 ? cacheRead / total : null
    }
    for (const decision of securityDecisions(live)) {
      if (decision.sessionId !== sid || decision.effect !== 'ask') continue
      if (decision.objectKind === 'extension') result.cards.extension++
      else if (decision.objectKind === 'widget' && decision.action === 'read') {
        result.cards.widgetRead++
      } else if (decision.objectKind === 'widget') result.cards.widgetWrite++
    }
    if (scenario.writes) {
      result.completed =
        dataRows(
          live,
          `SELECT COUNT(*) AS n FROM expenses WHERE amount = 38 AND added_by != 'seed'`
        )[0]?.n === 1
    } else {
      result.completed = messages
        .filter((message) => message.role === 'assistant')
        .some((message) => message.content.includes(LUNCH_TOTAL))
    }
    if (condition.oldSnapshot) {
      const info = await live.main.eval<{ tools?: Array<string | { name?: string }> }>(
        `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
      )
      result.oldOpDeclared = JSON.stringify(info.tools ?? []).includes('oldRecursiveOp')
    }
  } catch (error) {
    result.error = String(error instanceof Error ? error.message : error).slice(0, 400)
    if (app && sid) messages = await readMessages(app, sid).catch(() => messages)
  } finally {
    await app?.stop().catch((error: unknown) => debug(`${id}: stop failed: ${String(error)}`))
  }
  result.ms = Date.now() - started
  const text = [`# ${id}（${modelId}）`, '', transcript(messages)].join('\n')
  return { result, text: key ? text.split(key).join('<redacted>') : text }
}

// ─────────────────────────── 报告 ───────────────────────────

const ratio = (count: number, total: number): string => (total === 0 ? '–' : `${count}/${total}`)

function renderReport(results: TrialResult[], meta: Record<string, string>): string {
  const lines = ['# 组件当 MCP 服务器：真模型探针', '']
  for (const [key, value] of Object.entries(meta)) lines.push(`- ${key}：${value}`)
  lines.push(
    '',
    '| 模型 | 任务 | 做法 | 次数 | 做成 | 搜了 | 开启 | 第一个就调对 | 参数错 | 扩展卡 | 读卡 | 写卡 | 缓存命中 | 出错 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  const groups = new Map<string, TrialResult[]>()
  for (const result of results) {
    const key = `${result.model}|${result.scenario}|${result.condition}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [model, scenario, condition] = key.split('|')
    const n = group.length
    const count = (test: (r: TrialResult) => boolean): string => ratio(group.filter(test).length, n)
    const sum = (pick: (r: TrialResult) => number): number =>
      group.reduce((total, r) => total + pick(r), 0)
    const hits = group.flatMap((r) => (r.cacheHit === null ? [] : [r.cacheHit]))
    const cache = hits.length
      ? `${Math.round((hits.reduce((a, b) => a + b, 0) / hits.length) * 100)}%`
      : '–'
    lines.push(
      `| ${model} | ${scenario} | ${condition} | ${n} | ${count((r) => r.completed)} | ${count((r) => r.searched)} | ${count((r) => r.loaded)} | ${count((r) => r.firstIsWidget)} | ${sum((r) => r.widgetErrors)} | ${sum((r) => r.cards.extension)} | ${sum((r) => r.cards.widgetRead)} | ${sum((r) => r.cards.widgetWrite)} | ${cache} | ${count((r) => r.error !== undefined)} |`
    )
  }
  lines.push('', '## 每次的调用序列', '')
  for (const result of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    const old = result.oldOpDeclared === null ? '' : ` 老操作声明了=${result.oldOpDeclared}`
    lines.push(
      `- ${result.id}${result.completed ? '' : '（没做成）'}${old}：${result.sequence || '（没有工具调用）'}${result.queries.length ? `；搜 ${JSON.stringify(result.queries)}` : ''}${result.error ? `；出错 ${result.error}` : ''}`
    )
  }
  return lines.join('\n') + '\n'
}

const listFrom = <T extends string>(raw: string | undefined, all: readonly T[]): T[] =>
  raw
    ? raw
        .split(',')
        .map((s) => s.trim() as T)
        .filter((s) => all.includes(s))
    : [...all]

it(
  'widgets as MCP servers: does a model find and use them',
  async () => {
    const env = collectProbeEnv(
      process.env,
      existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
    )
    const targets = (process.env.PROBE_MODELS ?? 'deepseek,kimi').split(',').map((raw) => {
      const name = raw.trim()
      const spec = MODELS[name]
      if (!spec) throw new Error(`unknown model "${name}" in PROBE_MODELS`)
      const key = env[spec.keyEnv] ?? ''
      const modelId = env[spec.modelEnv] ?? spec.fallbackModel ?? ''
      if (!key || !modelId)
        throw new Error(`${spec.keyEnv} / ${spec.modelEnv} not set (${ENV_FILE})`)
      return { name, spec, key, modelId }
    })
    const scenarios = listFrom(process.env.PROBE_SCENARIOS, Object.keys(SCENARIOS) as ScenarioId[])
    const conditions = listFrom(
      process.env.PROBE_CONDITIONS,
      Object.keys(CONDITIONS) as ConditionId[]
    )
    mkdirSync(join(OUT, 'transcripts'), { recursive: true })
    const debug = makeDebug(OUT)
    const queue: Plan[] = []
    for (let rep = 1; rep <= REPEAT; rep++) {
      for (const target of targets) {
        for (const scenario of scenarios) {
          for (const condition of conditions) {
            // 老快照只看请求会不会坏，一个任务够了
            if (condition === 'old-snapshot' && scenario !== 'total') continue
            queue.push({ model: target.name, scenario, condition, rep })
          }
        }
      }
    }
    const meta = {
      模型: targets.map((t) => `${t.name} = ${t.modelId}`).join('，'),
      每格重复: String(REPEAT),
      并行实例: String(WORKERS)
    }
    const total = queue.length
    const results: TrialResult[] = []
    const flush = (): void => {
      writeFileSync(join(OUT, 'report.md'), renderReport(results, meta))
      writeFileSync(
        join(OUT, 'results.jsonl'),
        results.map((r) => JSON.stringify(r)).join('\n') + '\n'
      )
    }
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (let plan = queue.shift(); plan; plan = queue.shift()) {
          const target = targets.find((t) => t.name === plan?.model)
          if (!target) continue
          const { result, text } = await runTrial(
            plan,
            target.spec,
            target.key,
            target.modelId,
            debug
          )
          results.push(result)
          writeFileSync(join(OUT, 'transcripts', `${result.id}.txt`), text)
          flush()
          console.log(
            `[${results.length}/${total}] ${result.id}: ${result.error ? `ERROR ${result.error}` : `${result.completed ? 'done' : 'NOT DONE'} ${result.sequence}`}`
          )
        }
      })
    )
    console.log(`report: ${join(OUT, 'report.md')}`)
  },
  60 * 60 * 1000
)
