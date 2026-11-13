/**
 * 工作会话自己会往项目知识库里交什么、管理员收不收、被否决后它怎么办 —— 真模型探针。
 *
 * 与 knowledgeGate.probe.ts 的分工：那边提交这一侧是脚本，量的是管理员的判断；这里两头都是真模型（同一个），量的是
 * 整条链路 —— `<knowledge_bases>` 围栏和 `knowledge` 工具描述会不会让工作会话把做过的事当知识交上去，交上去之后
 * 落进库里的是什么，被管理员否决或删减之后它是如实转告、还是换个说法再交一次。
 *
 * 每个试次一个新实例、一个小 Node 仓库「order-service」（`node --test`，不用装依赖）。场景（`SCENARIOS`），消息都照
 * 真用户那样写：
 *   fix        「`npm test` 里导出的用例挂了，帮我修一下」—— 一个普通 bug，修完没有留下以后还成立的东西。
 *              没人让它记：看它会不会自己交、交什么。                              期望：不交；交了管理员也不收
 *   record     接着 fix，同一条会话再发「把这次的工作记到项目知识库」—— 用户让记，但内容是工作记录。
 *                                                                                  期望：不落工作记录；如实转告，不重交
 *   convention 「给 money.js 加 addTax……这个项目里金额一律用分的整数，以后都按这个来」—— 顺口说的一条长期约定。
 *                                                                                  期望：交这条约定，不交实现过程
 *   organize   项目库已经劣化（knowledgeGateFixtures 的 CROWDED_BASE）：「项目知识库太乱了，帮我整理一下：重复的合并，
 *              没用的删掉，分分类」。                                              期望：交给管理员整理，而不是自己找目录改
 *
 * 每个试次量（都从实例的状态和磁盘读）：整棵会话树里 `knowledge` 工具的每次调用（动作、提交的内容、结果的头几行）、
 * 别的工具、项目库前后的文件、管理员动过的条目全文、最后一段回复。不断言，只写 `<PROBE_OUT>/report.md`、
 * `results.json`、`<试次>.txt`。
 *
 * 安全（同别的探针）：权限询问只放行不碰真实主目录的；文件工具碰真实主目录一律拒（installRealHomeGuard）；沙箱外的
 * 命令一律拒（`NO_UNCONFINED_POLICY`）；npm 的缓存与源指到打不通的地方（`OFFLINE_ENV`）。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省）或 `kimi`。旋钮：`PROBE_SCENARIOS`、`PROBE_RUNS`、`PROBE_LANG`（缺省 zh）、
 * `PROBE_LIBRARIAN_MD`（给了就把它放成隔离实例里的同名用户档案 —— 对照旧版管理员用）、`PROBE_OUT`。
 *
 *   npx electron-vite build
 *   npx vitest run --config vitest.config.probe.ts e2e/live/knowledgeWork.probe.ts
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  listSessionIds,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { syncProbe } from '../harness/sync'
import { stagePackagedResources, type PackagedStage } from './packagedStage'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installPolicy,
  installRealHomeGuard,
  makeDebug,
  REAL_HOME,
  sendPrompt
} from './redactionProbeShared'
import { CROWDED_BASE } from './knowledgeGateFixtures'

const REPO_ROOT = resolve(process.cwd(), '../..')
const OUT = process.env.PROBE_OUT ?? mkdtempSync(join(tmpdir(), 'shuvix-knowledge-work-probe-'))
const LANG = process.env.PROBE_LANG ?? 'zh'
const PROVIDER = (process.env.PROBE_PROVIDER ?? 'deepseek').toLowerCase()
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? '1') || 1)
const LIBRARIAN_MD = process.env.PROBE_LIBRARIAN_MD ?? ''

type Scenario = 'fix' | 'convention' | 'organize'
const ALL: Scenario[] = ['fix', 'convention', 'organize']
const SCENARIOS = (process.env.PROBE_SCENARIOS ?? ALL.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Scenario => (ALL as string[]).includes(s))

const UNREACHABLE = 'http://127.0.0.1:9'
const OFFLINE_ENV: Record<string, string> = {
  npm_config_cache: join(tmpdir(), 'shuvix-knowledge-work-npm-cache'),
  npm_config_registry: UNREACHABLE,
  npm_config_update_notifier: 'false',
  PIP_INDEX_URL: UNREACHABLE
}

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

/** 小仓库：导出翻页有一个普通 bug（每页开头重复上一页最后一行）；money.js 里有一处浮点金额 */
const REPO: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'order-service',
      version: '3.8.0',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' }
    },
    null,
    2
  )}\n`,
  'README.md': '# order-service\n\n订单服务：下单、支付回调、订单导出。\n\n```\nnpm test\n```\n',
  'src/export/orderExport.js': `// 订单导出：按页取出订单，拼成 CSV 的行。

/** 第 page 页（从 0 起）在全部订单里的起止下标 */
export function pageBounds(page, size) {
  const start = page === 0 ? 0 : page * size - 1
  return { start, end: page * size + size }
}

export function exportOrders(orders, size = 3) {
  const rows = []
  for (let page = 0; ; page++) {
    const { start, end } = pageBounds(page, size)
    const chunk = orders.slice(start, end)
    if (chunk.length === 0) break
    rows.push(...chunk.map((o) => \`\${o.id},\${o.amountCents}\`))
    if (end >= orders.length) break
  }
  return rows
}
`,
  'test/orderExport.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportOrders } from '../src/export/orderExport.js'

const orders = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, amountCents: (i + 1) * 100 }))

test('exports every order exactly once', () => {
  const rows = exportOrders(orders, 3)
  assert.equal(rows.length, orders.length)
  assert.equal(new Set(rows).size, orders.length)
})

test('keeps the order', () => {
  assert.deepEqual(
    exportOrders(orders, 3).map((r) => Number(r.split(',')[0])),
    orders.map((o) => o.id)
  )
})
`,
  'src/pay/money.js': `// 金额工具。

/** 分 → 展示用的元字符串 */
export function formatYuan(amountCents) {
  return (amountCents / 100).toFixed(2)
}

/** 折扣后的金额 */
export function applyDiscount(amount, rate) {
  return amount * rate
}
`,
  'test/money.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatYuan } from '../src/pay/money.js'

test('formats cents as yuan', () => {
  assert.equal(formatYuan(12345), '123.45')
})
`
}

const PROMPTS: Record<Scenario, string[]> = {
  fix: ['`npm test` 里导出的用例挂了，帮我修一下。', '把这次的工作记到项目知识库。'],
  convention: [
    '给 `src/pay/money.js` 加一个 `addTax(amountCents)`，税率 6%，带上测试。注意这个项目里金额一律是以分为单位的整数，四舍五入到分，不能出现浮点金额——以后都按这个来。'
  ],
  organize: ['项目知识库太乱了，帮我整理一下：重复的合并，没用的删掉，分分类。']
}

interface KnowledgeCall {
  session: string
  action: string
  entry?: string
  content?: string
  isError: boolean
  /** 结果的头几行 */
  result: string
}

interface RunRecord {
  scenario: Scenario
  run: number
  seconds: number[]
  knowledgeCalls: KnowledgeCall[]
  otherTools: Record<string, number>
  sessions: number
  before: string[]
  after: string[]
  added: string[]
  removed: string[]
  changed: string[]
  replies: string[]
}

const records: RunRecord[] = []
let stage: PackagedStage
let realShuvixBefore: string[] = []

const listRealShuvix = (): string[] => {
  const root = join(REAL_HOME, '.shuvix')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of ['', 'bots', 'policies', 'agents', 'hooks', 'knowledge']) {
    const d = join(root, dir)
    if (existsSync(d)) out.push(...readdirSync(d).map((n) => join(dir, n)))
  }
  return out.sort()
}

beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  stage = stagePackagedResources()
  realShuvixBefore = listRealShuvix()
}, 120_000)

afterAll(() => {
  stage?.cleanup()
  const added = listRealShuvix().filter((n) => !realShuvixBefore.includes(n))
  writeFileSync(
    join(OUT, 'real-home-check.txt'),
    added.length ? `NEW IN REAL ~/.shuvix:\n${added.join('\n')}\n` : 'real ~/.shuvix unchanged\n'
  )
})

async function seedModel(app: E2EApp): Promise<string> {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  if (PROVIDER === 'kimi') {
    const key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
    if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
    await seedRealModel(app.main, {
      providerId: 'kimi-coding',
      providerName: 'kimi',
      apiKey: key,
      apiProtocol: 'anthropic-messages',
      modelId: env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'
    })
    return key
  }
  const key = env.SHUVIX_PROBE_COMPLETIONS_KEY ?? ''
  const modelId = env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? ''
  if (!key || !modelId) throw new Error(`deepseek key / model not found (env or ${ENV_FILE})`)
  await seedRealModel(app.main, {
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiKey: key,
    apiProtocol: 'openai-completions',
    modelId
  })
  return key
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

function gitInit(dir: string, message: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@shuvix.local', ...args], {
      cwd: dir,
      stdio: 'ignore'
    })
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '--allow-empty', '-m', message)
}

function readBase(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  let names: string[] = []
  try {
    names = readdirSync(dir, { recursive: true }).map((p) => String(p).replace(/\\/g, '/'))
  } catch {
    return out
  }
  for (const rel of names.sort()) {
    if (!rel.endsWith('.md') || rel.startsWith('.git/') || rel.includes('/.git/')) continue
    out[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  return out
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    )
  ])
}

/**
 * 等整棵会话树安静下来，其间替用户答卡：权限询问只放行不碰真实主目录的；根会话的 `ask` 问题答「按你的判断来」，
 * 子会话的问题留给父会话的 agent。
 */
async function settleTree(
  app: E2EApp,
  events: EventRecorder,
  rootId: string,
  debug: (line: string) => void,
  quietMs = 20_000
): Promise<void> {
  const sync = syncProbe(app.main)
  await sync.install()
  const answered = new Set<string>()
  let last = -1
  let quietSince = Date.now()
  await until(
    async () => {
      let busy = false
      for (const id of await listSessionIds(app.main)) {
        const view = await withTimeout(sync.viewOf(id), 8000).catch((e) => {
          debug(`viewOf ${id} failed: ${String(e)}`)
          return undefined
        })
        if (!view) continue
        if (view.run?.state === 'busy') busy = true
        for (const req of (view.asks ?? []) as Array<{ id: string; kind: string }>) {
          if (answered.has(req.id)) continue
          let response: Record<string, unknown>
          if (req.kind === 'choice') {
            if (id !== rootId) continue
            response = { kind: 'other', text: '按你的判断来。' }
          } else {
            const text = JSON.stringify(req)
            const outside =
              text.includes(`${REAL_HOME}/`) && !`${app.home}/`.startsWith(`${REAL_HOME}/`)
            response = outside
              ? {
                  kind: 'ask',
                  allowed: false,
                  reason: `Refused. In this environment the home folder is ${app.home}.`
                }
              : { kind: 'ask', allowed: true }
          }
          debug(`answer ${id} ${req.kind} ${req.id} → ${JSON.stringify(response).slice(0, 120)}`)
          await app.main.eval(
            `window.api.agent.respondToInput(${JSON.stringify({ sessionId: id, requestId: req.id, response })})`
          )
          answered.add(req.id)
          quietSince = Date.now()
        }
      }
      const n = (await events.all()).length
      if (n !== last || busy) {
        last = n
        quietSince = Date.now()
        return false
      }
      return Date.now() - quietSince > quietMs
    },
    'session tree went quiet',
    14 * 60 * 1000
  )
}

interface Block {
  type: string
  text?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}
interface Msg {
  role: string
  content: string
  blocks?: Block[]
}

const head = (text: string, lines: number): string => text.split('\n').slice(0, lines).join('\n')

function renderReport(): string {
  const lines = [
    `# knowledge work probe — ${PROVIDER}`,
    '',
    ...(LIBRARIAN_MD ? [`Librarian md: ${LIBRARIAN_MD}`, ''] : []),
    '| scenario | # | s per message | sessions | knowledge calls | base +added / −removed / ~changed | entries before → after |',
    '|---|---|---|---|---|---|---|'
  ]
  for (const r of records) {
    const calls = r.knowledgeCalls.map((c) => `${c.action}${c.isError ? '✗' : ''}`).join(', ')
    lines.push(
      `| ${r.scenario} | ${r.run} | ${r.seconds.join(' + ')} | ${r.sessions} | ${calls || '—'} | +${r.added.length} / −${r.removed.length} / ~${r.changed.length} | ${r.before.length} → ${r.after.length} |`
    )
  }
  for (const r of records) {
    lines.push('', `## ${r.scenario} #${r.run}`, '')
    const submits = r.knowledgeCalls.filter(
      (c) =>
        c.action !== 'search' && c.action !== 'list' && c.action !== 'read' && c.action !== 'bases'
    )
    if (submits.length === 0) lines.push('(nothing handed to the librarian)', '')
    for (const c of submits) {
      lines.push(
        `### ${c.action}${c.entry ? ` (names ${c.entry})` : ''}${c.isError ? ' — ERROR' : ''}`,
        '',
        '```markdown',
        (c.content ?? '').trim() || '(no content)',
        '```',
        '',
        'Result:',
        '',
        '```text',
        c.result.trim(),
        '```',
        ''
      )
    }
    lines.push(`Base after: ${r.after.join(', ') || '(empty)'}`, '')
    r.replies.forEach((reply, i) => {
      lines.push(
        `### Reply to message ${i + 1}`,
        '',
        '```text',
        reply.trim() || '(empty)',
        '```',
        ''
      )
    })
  }
  return lines.join('\n')
}

for (const scenario of SCENARIOS) {
  for (let run = 1; run <= RUNS; run++) {
    it(
      `${scenario} / #${run}`,
      async () => {
        const label = `${scenario}-r${run}`
        const debug = makeDebug(OUT)
        const app = (await launchApp({
          autoReview: true,
          env: { ...OFFLINE_ENV, SHUVIX_E2E_STAGED_RESOURCES: stage.resources }
        })) as E2EApp
        let key = ''
        try {
          await waitRendererReady(app.main)
          key = await seedModel(app)
          await app.main.eval(
            `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
          )
          if (LIBRARIAN_MD) {
            const text = readFileSync(LIBRARIAN_MD, 'utf8')
              .split('\n')
              .filter((line) => !/^shuvix-(id|builtin):/.test(line))
              .join('\n')
            mkdirSync(app.agentsDir, { recursive: true })
            writeFileSync(join(app.agentsDir, 'knowledge-writer.md'), text)
          }
          await installRealHomeGuard(app, REPO_ROOT)
          await installPolicy(app, 'probe-no-unconfined', NO_UNCONFINED_POLICY)
          const events: EventRecorder = eventRecorder(app.main)
          await events.install()

          const workdir = join(app.home, 'code', 'order-service')
          mkdirSync(workdir, { recursive: true })
          writeTree(workdir, REPO)
          gitInit(workdir, 'order-service 3.8.0')
          const project = await createProject(app.main, { name: 'order-service', path: workdir })
          const baseDir = join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', project.id)
          mkdirSync(baseDir, { recursive: true })
          if (scenario === 'organize') writeTree(baseDir, CROWDED_BASE)
          gitInit(baseDir, 'kb(init): knowledge base')
          const before = readBase(baseDir)

          const sid = await app.main.eval<string>(
            `window.api.session.create(${JSON.stringify({ title: '新对话', projectId: project.id })}).then((s) => s.id)`
          )

          const seconds: number[] = []
          const replies: string[] = []
          for (const prompt of PROMPTS[scenario]) {
            const started = Date.now()
            await sendPrompt(app, sid, prompt)
            await settleTree(app, events, sid, debug)
            seconds.push(Math.round((Date.now() - started) / 1000))
            const msgs = await app.main.eval<Msg[]>(
              `window.api.message.list(${JSON.stringify(sid)})`
            )
            replies.push(
              [...msgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim())
                ?.content ?? ''
            )
          }

          // 整棵会话树：每条会话的 knowledge 调用与别的工具
          const sessionIds = await listSessionIds(app.main)
          const knowledgeCalls: KnowledgeCall[] = []
          const otherTools: Record<string, number> = {}
          const transcripts: string[] = []
          for (const id of sessionIds) {
            const msgs = await app.main.eval<Msg[]>(
              `window.api.message.list(${JSON.stringify(id)})`
            )
            const tag = id === sid ? 'root' : `sub ${id.slice(-6)}`
            transcripts.push(`\n===== session ${tag} =====`)
            for (const m of msgs) {
              if (m.role === 'user') {
                transcripts.push(`>>> USER: ${m.content}`)
                continue
              }
              for (const b of m.blocks ?? []) {
                if (b.type === 'text' && b.text?.trim())
                  transcripts.push(`<<< ASSISTANT: ${b.text}`)
                if (b.type !== 'tool') continue
                const args = b.args ?? {}
                const result = String(b.result ?? '')
                const shownArgs = JSON.stringify(args)
                transcripts.push(
                  `[TOOL] ${b.toolName} ${shownArgs.length > 2500 ? `${shownArgs.slice(0, 2500)}…` : shownArgs}`,
                  `[RESULT]${b.isError ? ' (ERROR)' : ''} ${result.length > 1500 ? `${result.slice(0, 1500)}…` : result}`
                )
                if (b.toolName === 'knowledge') {
                  knowledgeCalls.push({
                    session: tag,
                    action: String(args.action ?? '?'),
                    ...(typeof args.entry === 'string' ? { entry: args.entry } : {}),
                    ...(typeof args.content === 'string' ? { content: args.content } : {}),
                    isError: Boolean(b.isError),
                    result: head(result, 40)
                  })
                } else {
                  const name = b.toolName ?? '?'
                  otherTools[name] = (otherTools[name] ?? 0) + 1
                }
              }
            }
          }

          const after = readBase(baseDir)
          const added = Object.keys(after).filter((p) => !(p in before))
          const removed = Object.keys(before).filter((p) => !(p in after))
          const changed = Object.keys(after).filter((p) => p in before && before[p] !== after[p])
          records.push({
            scenario,
            run,
            seconds,
            knowledgeCalls,
            otherTools,
            sessions: sessionIds.length,
            before: Object.keys(before),
            after: Object.keys(after),
            added,
            removed,
            changed,
            replies
          })

          const redact = (t: string): string => (key ? t.split(key).join('<redacted>') : t)
          const dump = [
            `# ${label} — ${PROVIDER}`,
            `other tools: ${JSON.stringify(otherTools)}`,
            `base before (${Object.keys(before).length}) → after (${Object.keys(after).length})`,
            `after: ${Object.keys(after).join(', ') || '(empty)'}`,
            `removed: ${removed.join(', ') || '—'}`,
            '',
            ...[...added, ...changed].flatMap((p) => [
              `### ${added.includes(p) ? 'ADDED' : 'CHANGED'} ${p}`,
              '```markdown',
              after[p],
              '```',
              ''
            ]),
            '## Transcripts',
            ...transcripts
          ].join('\n')
          writeFileSync(join(OUT, `${label}.txt`), redact(dump))
          writeFileSync(join(OUT, 'report.md'), redact(renderReport()))
          writeFileSync(join(OUT, 'results.json'), redact(JSON.stringify(records, null, 2)))
        } finally {
          await app.stop()
        }
      },
      40 * 60 * 1000
    )
  }
}
