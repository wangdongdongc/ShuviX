/**
 * 知识库提交的真模型探针 —— 不断言，只跑一遍并把经过摊开来读。
 *
 * 看的是 2026-11-08 那次改版落到真模型手里的样子：主 agent 不知道库目录，会不会把要记的内容经 `knowledge`
 * `submit` 交上去（而不是自己去找目录写）、交的内容有没有出处；知识库管理员（宿主同步派的 knowledge-writer，
 * 唯一写库的 agent）怎么组织 —— 建在哪、叫什么、frontmatter 对不对、有没有跑出库外去核实；它报上来的条目上
 * 宿主盖的章（`generated` = 提交者、`verified` = 管理员）是不是真落在文件里。
 *
 * 与 `probe.ts` 的 startProbe 不同，key **只从 env 文件来**（文件缺省 `~/.shuvix-probe.env`，
 * `SHUVIX_PROBE_ENV_FILE` 可改）—— 不碰真实实例的数据库与 key。key 只经 IPC 种进隔离实例，不打印、不落盘；
 * 输出里出现它就替换掉。
 *
 * 模型：`PROBE_PROVIDER=kimi`（缺省；`SHUVIX_PROBE_KIMI_KEY`，anthropic-messages）或 `deepseek`
 *（`SHUVIX_PROBE_COMPLETIONS_KEY` + `SHUVIX_PROBE_COMPLETIONS_MODEL`，openai-completions）。实测一律两家基础款
 * 各跑一遍（用户 2026-11-08）。
 *
 * 跑：`electron-vite build` 之后，`npx vitest run --config vitest.config.probe.ts e2e/live/knowledge.probe.ts`
 * （在 apps/desktop 下）。`SHUVIX_PROBE_KIMI_MODEL` 换模型（缺省 kimi-for-coding），`PROBE_PROMPT` 换任务，
 * `PROBE_OUT` 指定报告落点。`PROBE_FOLLOWUP` 给了就在同一会话里接着发第二轮（如「那个间隔其实改成了 600ms，更新一下」）——
 * 看提交者会不会点名已有的条目、管理员是改那一条还是另起一条。`PROBE_SEED=<名字>` 在第一轮之前往项目库里预置几条
 * 条目（见 SEEDS）—— 看一次改动牵到好几条时管理员会不会一起改、改得一致。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  installAutoAllow,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'

const ENV_FILE = process.env.SHUVIX_PROBE_ENV_FILE ?? join(homedir(), '.shuvix-probe.env')
const PROVIDER = (process.env.PROBE_PROVIDER ?? 'kimi').toLowerCase()
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-knowledge-probe.md')
const PROMPT =
  process.env.PROBE_PROMPT ??
  '看一下 src/auth/refresh.ts：刷新令牌之后为什么要等一下再重试一次？把这个决定记进项目知识库。'
/** 可选的第二轮（同一会话）：一次更正，看条目是被改还是被另起 */
const FOLLOWUP = process.env.PROBE_FOLLOWUP ?? ''

const okf = (fields: string[], body: string): string =>
  ['---', 'shuvix: okf v0.2', ...fields, 'status: stable', '---', '', body, ''].join('\n')

/** 预置进项目库的条目（库内路径 → 内容）：`PROBE_SEED` 点名一套 */
const SEEDS: Record<string, Record<string, string>> = {
  // 同一个事实（网关缓存窗口）落在两条里：一次更正该把两条都改掉
  overlap: {
    'gateway/token-cache.md': okf(
      [
        'type: Entity',
        'title: API 网关的令牌校验缓存',
        'description: 排查令牌刚轮换就 401 时打开——网关把令牌有效性缓存多久。',
        'tags: [gateway, auth]'
      ],
      '# API 网关的令牌校验缓存\n\nAPI 网关把令牌的有效性缓存约 **200ms**：令牌轮换后的这段时间里，网关仍按旧的判定放行或拒绝。\n\n客户端的重试间隔依赖这个窗口，见 [刷新后的重试](/auth/refresh-retry.md)。'
    ),
    'auth/refresh-retry.md': okf(
      [
        'type: Decision',
        'title: 刷新令牌后的重试',
        'description: 改 refreshAndRetry 的等待或重试次数之前打开。',
        'tags: [auth, retry]'
      ],
      '# 刷新令牌后的重试\n\n`refreshAndRetry` 在轮换令牌后等 **250ms** 再重试一次：略长于[网关的缓存窗口](/gateway/token-cache.md)（约 200ms）。只重试一次 —— 多次重试会掩盖真正的鉴权失败。'
    )
  }
}
const SEED = process.env.PROBE_SEED ?? ''

/** 被记录的那件事：一个代码里写明了理由、但仓库别处没写的决定 */
const REFRESH_TS = `// Token refresh.
//
// After rotating the access token we retry the failed request exactly once, after 250ms.
// The API gateway caches token validity for ~200ms, so a request sent right after rotation
// can still be rejected with 401 even though the new token is valid. Retrying immediately
// hits the same cache; retrying more than once hides real auth failures.
export async function refreshAndRetry<T>(run: () => Promise<T>, rotate: () => Promise<void>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!isUnauthorized(err)) throw err
    await rotate()
    await new Promise((r) => setTimeout(r, 250))
    return run()
  }
}

function isUnauthorized(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 401
}
`

let app: E2EApp
let events: EventRecorder
let sid: string
let projectId: string
let key = ''

/** 输出里绝不能出现 key */
const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

beforeAll(async () => {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  const deepseek = PROVIDER === 'deepseek'
  key = (deepseek ? env.SHUVIX_PROBE_COMPLETIONS_KEY : env.SHUVIX_PROBE_KIMI_KEY) ?? ''
  const modelId = deepseek
    ? (env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? '')
    : (env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding')
  if (!key || !modelId) throw new Error(`${PROVIDER} key / model not found (env or ${ENV_FILE})`)

  app = await launchApp()
  await waitRendererReady(app.main)
  await seedRealModel(
    app.main,
    deepseek
      ? {
          providerId: 'deepseek',
          providerName: 'deepseek',
          apiKey: key,
          apiProtocol: 'openai-completions',
          modelId
        }
      : {
          providerId: 'kimi-coding',
          providerName: 'kimi',
          apiKey: key,
          apiProtocol: 'anthropic-messages',
          modelId
        }
  )

  const workdir = mkdtempSync(join(tmpdir(), 'probe-kb-'))
  mkdirSync(join(workdir, 'src', 'auth'), { recursive: true })
  writeFileSync(join(workdir, 'src', 'auth', 'refresh.ts'), REFRESH_TS)
  const project = await createProject(app.main, { name: 'ProbeKB', path: workdir })
  projectId = project.id
  sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: 'knowledge probe', projectId })}).then((s) => s.id)`
  )
  events = eventRecorder(app.main)
  await events.install()
  // 扮演会点「允许一次」的用户：探的是知识库这条路，不是询问卡片
  await installAutoAllow(app.main)
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

/** 在目录树里找一个文件（会话库落在 userData 底下某处，不写死相对路径） */
function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === name) return p
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    }
  }
  return undefined
}

/** 一条 entry 的 JSON 美化后截断（工具结果可能很长） */
function clip(record: string, max = 4000): string {
  let text: string
  try {
    text = JSON.stringify(JSON.parse(record), null, 2)
  } catch {
    text = record
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text
}

it(
  'records a decision through submit + the knowledge librarian with a real model',
  async () => {
    // 「安静」而不是「一次 agent_end」：管理员那一轮也会发事件
    const promptAndSettle = async (text: string): Promise<void> => {
      await app.main.eval(
        `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
      )
      let last = -1
      let quietSince = Date.now()
      await until(
        async () => {
          const n = (await events.all()).length
          if (n !== last) {
            last = n
            quietSince = Date.now()
            return false
          }
          return Date.now() - quietSince > 10_000
        },
        'session went quiet',
        15 * 60 * 1000
      )
    }
    if (SEED) {
      const seed = SEEDS[SEED]
      if (!seed)
        throw new Error(`unknown PROBE_SEED "${SEED}" (have: ${Object.keys(SEEDS).join(', ')})`)
      const { root } = await app.main.eval<{ root: string }>(`window.api.knowledge.list()`)
      for (const [rel, text] of Object.entries(seed)) {
        const file = join(root, 'projects', projectId, rel)
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, text)
      }
    }
    await promptAndSettle(PROMPT)
    if (FOLLOWUP) await promptAndSettle(FOLLOWUP)

    const report: string[] = [
      `# Knowledge submit probe`,
      '',
      `Provider: ${PROVIDER}`,
      ...(SEED ? [`Seed: ${SEED}`] : []),
      `Prompt: ${PROMPT}`,
      ...(FOLLOWUP ? [`Follow-up: ${FOLLOWUP}`] : []),
      ''
    ]

    // 1. 主会话转写
    const transcript = await app.main.eval<string>(`
      (async () => {
        const msgs = await window.api.message.list(${JSON.stringify(sid)})
        const out = []
        for (const m of msgs) {
          if (m.role === 'user') { out.push('>>> USER: ' + m.content); continue }
          if (m.role !== 'assistant') { out.push('### ' + m.role + ': ' + m.content); continue }
          for (const b of m.blocks ?? []) {
            if (b.type === 'text' && b.text?.trim()) out.push('<<< ASSISTANT: ' + b.text)
            if (b.type !== 'tool') continue
            out.push('[TOOL] ' + b.toolName + ' ' + JSON.stringify(b.args ?? {}))
            out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + '\\n' + String(b.result ?? ''))
          }
        }
        return out.join('\\n\\n')
      })()
    `)
    report.push('## Main session', '', '```text', transcript, '```', '')

    // 2. 库里落了什么（从磁盘读）
    const listing = await app.main.eval<{
      entries: {
        path: string
        title: string
        status: string
        trustTier: string
        verifiedCurrent: boolean
      }[]
      root: string
    }>(`window.api.knowledge.list()`)
    const baseDir = join(listing.root, 'projects', projectId)
    report.push(`## Project base — ${baseDir}`, '')
    const files: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.md')) files.push(p)
      }
    }
    walk(baseDir)
    if (files.length === 0) report.push('(no entry files)', '')
    for (const f of files) {
      report.push(
        `### ${relative(baseDir, f)}`,
        '',
        '```markdown',
        readFileSync(f, 'utf8'),
        '```',
        ''
      )
    }
    report.push(
      '### Sidebar view',
      '',
      '```json',
      JSON.stringify(listing.entries, null, 2),
      '```',
      ''
    )

    // 3. 管理员那条对话：派生 agent 不在会话列表里，请求日志也已没有写入方 —— 直接读会话的 durable
    //    SQLite（`<userData>/data/sessions/<sid>.sqlite`），把根对话之外每条对话的 entries 摊开
    const dbFile = findFile(app.userData, `${sid}.sqlite`)
    if (!dbFile) {
      report.push('## Knowledge librarian', '', '(session database not found)', '')
    } else {
      const rows = JSON.parse(
        execFileSync('sqlite3', [
          '-readonly',
          '-json',
          dbFile,
          'SELECT conversation_id AS c, id, record FROM entries ORDER BY conversation_id, id'
        ]).toString('utf8') || '[]'
      ) as { c: number; id: number; record: string }[]
      const rootConversation = Math.min(...rows.map((r) => r.c))
      report.push('## Spawned conversations (knowledge librarian)', '')
      for (const r of rows) {
        if (r.c === rootConversation) continue
        report.push(
          `### conversation ${r.c} · entry ${r.id}`,
          '',
          '```json',
          clip(r.record),
          '```',
          ''
        )
      }
    }
    writeFileSync(OUT, redact(report.join('\n')))
    console.log(`knowledge probe report: ${OUT}`)
    expect(existsSync(OUT)).toBe(true)
  },
  20 * 60 * 1000
)
