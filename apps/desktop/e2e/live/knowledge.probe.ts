/**
 * 知识库条目提交的真模型探针 —— 不断言，只跑一遍并把经过摊开来读。
 *
 * 看的是 2026-10-12 那次改版落到真模型手里的样子：主 agent 会不会把条目直接 `write` 进库目录（围栏里印着），
 * 会不会接着 `knowledge` `submit`；写手（宿主同步派的 knowledge-writer）补的 frontmatter 对不对、判得准不准；
 * 通过之后宿主盖的章（`generated` = 提交者、`verified` = 写手）是不是真落在文件里。
 *
 * 与 `probe.ts` 的 startProbe 不同，key **只从 env 文件来**（`SHUVIX_PROBE_KIMI_KEY`，文件缺省
 * `~/.shuvix-probe.env`，`SHUVIX_PROBE_ENV_FILE` 可改）—— 不碰真实实例的数据库与 key。key 只经 IPC 种进
 * 隔离实例，不打印、不落盘；输出里出现它就替换掉。
 *
 * 跑：`electron-vite build` 之后，`npx vitest run --config vitest.config.probe.ts e2e/live/knowledge.probe.ts`
 * （在 apps/desktop 下）。`SHUVIX_PROBE_KIMI_MODEL` 换模型（缺省 kimi-for-coding），`PROBE_PROMPT` 换任务，
 * `PROBE_OUT` 指定报告落点。
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
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-knowledge-probe.md')
const PROMPT =
  process.env.PROBE_PROMPT ??
  '看一下 src/auth/refresh.ts：刷新令牌之后为什么要等一下再重试一次？把这个决定记进项目知识库。'

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
  key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
  if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
  const modelId = env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'

  app = await launchApp()
  await waitRendererReady(app.main)
  await seedRealModel(app.main, {
    providerId: 'kimi-coding',
    providerName: 'kimi',
    apiKey: key,
    apiProtocol: 'anthropic-messages',
    modelId
  })

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
  'records a decision through write + submit with a real model',
  async () => {
    await app.main.eval(
      `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(PROMPT)} })`
    )
    // 「安静」而不是「一次 agent_end」：写手那一轮也会发事件
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

    const report: string[] = [`# Knowledge submit probe`, '', `Prompt: ${PROMPT}`, '']

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

    // 3. 写手那条对话：派生 agent 不在会话列表里，请求日志也已没有写入方 —— 直接读会话的 durable
    //    SQLite（`<userData>/data/sessions/<sid>.sqlite`），把根对话之外每条对话的 entries 摊开
    const dbFile = findFile(app.userData, `${sid}.sqlite`)
    if (!dbFile) {
      report.push('## Knowledge writer', '', '(session database not found)', '')
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
      report.push('## Spawned conversations (knowledge writer)', '')
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
