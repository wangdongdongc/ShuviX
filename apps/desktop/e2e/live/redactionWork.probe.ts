/**
 * 自动脱敏演练一（docs/auto-redaction-design.md §11.1）：占位符替换不影响 agent 正常干活 —— 真模型、隔离实例，不断言，
 * 写一份报告。
 *
 * 工作目录（隔离 HOME 里）放着带秘密的文件：`.env`（key、数据库密码、本地模拟服务的地址）、带 key 的 config.json、
 * 带邮箱和手机号的日志。五个任务，每个一条新会话、一份新的工作目录：
 *   ping    读 .env，用 key 调本地模拟服务（服务只认真 key）
 *   rotate  把 config.json 里的 key 换成用户给的新 key，旧的挪到 apiKeyPrevious
 *   script  写一个读 DB_PASSWORD、只打印长度的脚本并运行
 *   logs    数日志里有几个不同的邮箱、出现最多的手机号
 *   edit    用 edit 改 .env 里的密码（old_string 要和磁盘上的对得上）
 * 每个任务跑两遍：脱敏（缺省，内置 redact-sensitive）与基线（用户策略信任这个服务商：模型见真值）。
 *
 * 模型请求经本进程里的一个记录代理转发给 deepseek（自定义服务商指到代理），于是能看到发出去的每个请求：
 *   - 脱敏那遍的请求里有没有出现任何一个真值；
 *   - HTTP 状态（400 之类）；前缀缓存命中（deepseek usage 的 prompt_cache_hit_tokens）。
 * 每个任务结束后：任务完成没有（按任务各自的判据）、工作目录的文件里有没有占位符。
 *
 * 跑：`electron-vite build` 之后，在 apps/desktop 下
 *   `npx vitest run --config vitest.config.probe.ts e2e/live/redactionWork.probe.ts`
 * 旋钮：`PROBE_LANG`（缺省 zh）、`PROBE_ONLY`（逗号分隔的任务 id）、`PROBE_MODES`（redacted,baseline）、`PROBE_OUT`、
 * `PROBE_LABEL`。key 只从 env 文件来，只经 IPC 种进隔离实例，输出里出现就替换掉。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { seedRealModel } from './probe'
import {
  installPolicy,
  makeDebug,
  probeModel,
  restoredText,
  sendPrompt,
  settle,
  transcriptOf
} from './redactionProbeShared'

const LANG = (process.env.PROBE_LANG ?? 'zh') as 'zh' | 'en'
const LABEL = process.env.PROBE_LABEL ?? 'run'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-redaction-work-probe-${LABEL}`)
const ONLY = (process.env.PROBE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const MODES = (process.env.PROBE_MODES ?? 'redacted,baseline')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as Array<'redacted' | 'baseline'>
const UPSTREAM = 'https://api.deepseek.com'
const PROVIDER_NAME = 'probe-deepseek'

// ─── 秘密（造的）────────────────────────────────────────

const OPENAI_KEY = 'sk-proj-Q7wX2vB9nM4kL8pR3tY6uZ1aS5dF0gH2'
const OLD_CONFIG_KEY = 'sk-live-4fJ8sK2mQ9xV7bN3cL6pT1wR5yH0dG8e'
const NEW_CONFIG_KEY = 'sk-live-9QmT3vX7bK1nR5wY8cJ2pL6dF4hG0sAz'
const DB_PASSWORD = 'Tr0ub4dor&3xq-staging'
const NEW_DB_PASSWORD = 'N3w-P@ssw0rd-2026!'
const EMAILS = [
  'li.wei@acme-corp.cn',
  'zhang.min@acme-corp.cn',
  'ops-oncall@acme-corp.cn',
  'chen.jie@partner-labs.io'
]
const PHONES = ['13812345678', '13987654321', '15011112222']
/** 日志里出现最多的手机号 */
const TOP_PHONE = PHONES[1]!

const SECRETS = [
  OPENAI_KEY,
  OLD_CONFIG_KEY,
  NEW_CONFIG_KEY,
  DB_PASSWORD,
  NEW_DB_PASSWORD,
  ...EMAILS,
  ...PHONES
]

const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/

function logLines(): string {
  const rows: Array<[string, string, string]> = [
    ['09:00:01', EMAILS[0]!, PHONES[0]!],
    ['09:02:13', EMAILS[1]!, PHONES[1]!],
    ['09:05:40', EMAILS[2]!, PHONES[1]!],
    ['09:07:22', EMAILS[0]!, PHONES[2]!],
    ['09:11:05', EMAILS[3]!, PHONES[1]!],
    ['09:12:48', EMAILS[1]!, PHONES[0]!],
    ['09:15:31', EMAILS[2]!, PHONES[1]!],
    ['09:20:09', EMAILS[0]!, PHONES[2]!]
  ]
  return (
    rows
      .map(
        ([time, email, phone]) => `2026-10-25 ${time} INFO login ok user=${email} phone=${phone}`
      )
      .join('\n') + '\n'
  )
}

// ─── 任务 ────────────────────────────────────────────────

interface TaskCheck {
  ok: boolean
  note: string
}

interface Task {
  id: string
  prompt: Record<'zh' | 'en', string>
  /** 任务完成没有（工作目录、模拟服务的记录、界面上看到的回答） */
  check: (ctx: { dir: string; answer: string; mockAuths: string[] }) => TaskCheck
}

const TASKS: Task[] = [
  {
    id: 'ping',
    prompt: {
      zh: '读一下 .env，用里面的 OPENAI_API_KEY 作为 Bearer token，请求 MOCK_API_URL 下的 /v1/ping，告诉我返回了什么。',
      en: 'Read .env and call /v1/ping under MOCK_API_URL with OPENAI_API_KEY as a Bearer token. Tell me what it returns.'
    },
    check: ({ answer, mockAuths }) => {
      const real = mockAuths.filter((a) => a === `Bearer ${OPENAI_KEY}`).length
      const placeholders = mockAuths.filter((a) => PLACEHOLDER.test(a)).length
      return {
        ok: real > 0 && /acme/i.test(answer),
        note: `mock saw real key ${real}×, placeholder ${placeholders}×, other ${mockAuths.length - real - placeholders}×`
      }
    }
  },
  {
    id: 'rotate',
    prompt: {
      zh: `把 config.json 里的 apiKey 换成新的 key ${NEW_CONFIG_KEY}，旧的那个挪到新字段 apiKeyPrevious 里，其他字段不要动。`,
      en: `In config.json, replace apiKey with the new key ${NEW_CONFIG_KEY} and move the old one to a new field apiKeyPrevious. Leave the other fields alone.`
    },
    check: ({ dir }) => {
      try {
        const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<
          string,
          unknown
        >
        const ok =
          config.apiKey === NEW_CONFIG_KEY &&
          config.apiKeyPrevious === OLD_CONFIG_KEY &&
          config.service === 'billing' &&
          config.timeoutMs === 5000
        return {
          ok,
          note: JSON.stringify({
            ...config,
            apiKey: mask(config.apiKey),
            apiKeyPrevious: mask(config.apiKeyPrevious)
          })
        }
      } catch (error) {
        return { ok: false, note: `config.json unreadable: ${String(error)}` }
      }
    }
  },
  {
    id: 'script',
    prompt: {
      zh: '写一个脚本，从 .env 读取 DB_PASSWORD，只打印它的长度（不要打印密码本身），运行它，告诉我长度是多少。',
      en: 'Write a script that reads DB_PASSWORD from .env and prints only its length (never the password itself), run it, and tell me the length.'
    },
    check: ({ answer }) => ({
      ok: new RegExp(`\\b${DB_PASSWORD.length}\\b`).test(answer),
      note: `expected length ${DB_PASSWORD.length}`
    })
  },
  {
    id: 'logs',
    prompt: {
      zh: '看一下 logs/app.log：一共有几个不同的用户邮箱？出现次数最多的手机号是哪个？',
      en: 'Look at logs/app.log: how many distinct user emails are there, and which phone number appears most often?'
    },
    check: ({ answer }) => ({
      ok: new RegExp(`\\b${EMAILS.length}\\b`).test(answer) && answer.includes(TOP_PHONE),
      note: `expected ${EMAILS.length} emails and ${mask(TOP_PHONE)}`
    })
  },
  {
    id: 'edit',
    prompt: {
      zh: `用 edit 工具把 .env 里的 DB_PASSWORD 改成 ${NEW_DB_PASSWORD}，其他行不要动。`,
      en: `Use the edit tool to change DB_PASSWORD in .env to ${NEW_DB_PASSWORD}. Leave the other lines alone.`
    },
    check: ({ dir }) => {
      const env = readFileSync(join(dir, '.env'), 'utf8')
      const ok =
        env.includes(`DB_PASSWORD=${NEW_DB_PASSWORD}\n`) &&
        env.includes(`OPENAI_API_KEY=${OPENAI_KEY}\n`) &&
        env.includes('PORT=3000') &&
        !env.includes(DB_PASSWORD)
      return { ok, note: ok ? 'edited in place' : 'unexpected .env content' }
    }
  }
]

const FOLLOW_UP: Record<'zh' | 'en', string> = {
  zh: '按你的判断来，直接做完。',
  en: 'Use your judgement and finish it.'
}

function mask(v: unknown): string {
  return typeof v === 'string' && v.length > 6 ? `${v.slice(0, 4)}…${v.slice(-2)}` : String(v)
}

// ─── 记录代理与模拟服务 ──────────────────────────────────

interface Recorded {
  run: string
  body: string
  status: number
  promptTokens?: number
  cacheHit?: number
}

let proxy: Server
let mock: Server
let proxyUrl = ''
let mockUrl = ''
let currentRun = ''
const recorded: Recorded[] = []
const mockAuths: string[] = []

async function startProxy(): Promise<void> {
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const record: Recorded = { run: currentRun, body, status: 0 }
      recorded.push(record)
      void (async () => {
        try {
          const upstream = await fetch(`${UPSTREAM}${req.url ?? ''}`, {
            method: req.method ?? 'POST',
            headers: {
              'content-type': 'application/json',
              accept: String(req.headers.accept ?? '*/*'),
              authorization: String(req.headers.authorization ?? '')
            },
            body
          })
          record.status = upstream.status
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'text/event-stream'
          })
          let text = ''
          const decoder = new TextDecoder()
          if (upstream.body) {
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
              res.write(chunk)
              text += decoder.decode(chunk, { stream: true })
            }
          }
          res.end()
          const usages = [...text.matchAll(/"usage":\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)]
          const last = usages.at(-1)?.[1]
          if (last) {
            const usage = JSON.parse(last) as {
              prompt_tokens?: number
              prompt_cache_hit_tokens?: number
            }
            record.promptTokens = usage.prompt_tokens
            record.cacheHit = usage.prompt_cache_hit_tokens
          }
        } catch (error) {
          record.status = -1
          if (!res.headersSent) res.writeHead(502)
          res.end(String(error))
        }
      })()
    })
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
}

async function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '')
    mockAuths.push(auth)
    if (req.url?.startsWith('/v1/ping') && auth === `Bearer ${OPENAI_KEY}`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, account: 'acme-billing', region: 'cn-east-2' }))
    } else {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid api key' }))
    }
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
}

// ─── 工作目录 ────────────────────────────────────────────

function seedWorkspace(template: string): void {
  rmSync(template, { recursive: true, force: true })
  mkdirSync(join(template, 'logs'), { recursive: true })
  writeFileSync(
    join(template, '.env'),
    `OPENAI_API_KEY=${OPENAI_KEY}\nDB_PASSWORD=${DB_PASSWORD}\nMOCK_API_URL=${mockUrl}\nPORT=3000\n`
  )
  writeFileSync(
    join(template, 'config.json'),
    JSON.stringify({ service: 'billing', apiKey: OLD_CONFIG_KEY, timeoutMs: 5000 }, null, 2) + '\n'
  )
  writeFileSync(join(template, 'logs', 'app.log'), logLines())
  writeFileSync(join(template, 'README.md'), '# acme-billing\n\nInternal billing service.\n')
}

/** 每个漏出去的真值在请求体里第一次出现的上下文（值本身遮住）—— 看它是从哪儿漏的 */
function leakContexts(leaked: string[], requests: Recorded[]): string {
  const lines: string[] = []
  for (const value of leaked) {
    for (const [i, r] of requests.entries()) {
      const at = r.body.indexOf(value)
      if (at < 0) continue
      const around = r.body
        .slice(Math.max(0, at - 160), at + value.length + 80)
        .split(value)
        .join(`<${mask(value)}>`)
      lines.push(`- ${mask(value)} in request ${i + 1}: …${around}…`)
      break
    }
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

/** 工作目录里所有文本文件中出现的占位符（文件名 → 占位符） */
function placeholdersOnDisk(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (name !== '.git' && name !== 'node_modules') walk(p)
        continue
      }
      const text = readFileSync(p, 'utf8')
      const hit = text.match(new RegExp(PLACEHOLDER.source, 'g'))
      if (hit) out.push(`${p.slice(dir.length + 1)}: ${hit.join(', ')}`)
    }
  }
  walk(dir)
  return out
}

// ─── 跑 ──────────────────────────────────────────────────

let app: E2EApp
let events: EventRecorder
let key = ''
let modelId = ''
let debug: (line: string) => void = () => {}
const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

beforeAll(async () => {
  ;({ key, modelId } = probeModel())
  mkdirSync(OUT, { recursive: true })
  debug = makeDebug(OUT)
  await startProxy()
  await startMock()
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  // 自定义服务商指到记录代理（代理再转给 deepseek）：发出去的每个请求都看得见
  await seedRealModel(app.main, {
    providerId: 'probe-proxy',
    providerName: 'deepseek',
    apiKey: key,
    baseUrl: proxyUrl,
    apiProtocol: 'openai-completions',
    modelId
  })
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  await app?.stop()
  proxy?.close()
  mock?.close()
})

const TRUST_POLICY = `---
shuvix: policy v1
name: trust-probe
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == '${PROVIDER_NAME}'"
---
`

it(
  'agents work with placeholders',
  async () => {
    const template = join(app.home, 'template-acme')
    seedWorkspace(template)
    const rows: string[] = []
    const summary: string[] = [
      `# Redaction rehearsal 1 — agents work with placeholders (${LABEL})`,
      '',
      `model: ${modelId} · language: ${LANG} · ${new Date().toISOString()}`,
      ''
    ]
    for (const mode of MODES) {
      await installPolicy(app, 'trust-probe', mode === 'baseline' ? TRUST_POLICY : null)
      for (const task of TASKS) {
        if (ONLY.length > 0 && !ONLY.includes(task.id)) continue
        const run = `${mode}-${task.id}`
        currentRun = run
        mockAuths.length = 0
        const dir = join(app.home, 'work', run)
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(join(app.home, 'work'), { recursive: true })
        cpSync(template, dir, { recursive: true })
        const project = await createProject(app.main, { name: run, path: dir })
        const sid = await app.main.eval<string>(
          `window.api.session.create(${JSON.stringify({ title: run, projectId: project.id })}).then((s) => s.id)`
        )
        const started = Date.now()
        await sendPrompt(app, sid, task.prompt[LANG])
        let questions = await settle({
          app,
          events,
          sid,
          label: run,
          answer: () => FOLLOW_UP[LANG],
          debug
        })
        // 以文字提问结束一轮：把「按你的判断来」当下一条消息发过去（至多一轮）
        const lastText = await app.main.eval<string>(
          `window.api.message.list(${JSON.stringify(sid)}).then((ms) => ms.filter((m) => m.role === 'assistant')` +
            `.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text)).at(-1) ?? '')`
        )
        if (/[?？]\s*$/.test(lastText)) {
          await sendPrompt(app, sid, FOLLOW_UP[LANG])
          questions += await settle({
            app,
            events,
            sid,
            label: run,
            answer: () => FOLLOW_UP[LANG],
            debug
          })
        }
        const seconds = Math.round((Date.now() - started) / 1000)
        const transcript = await transcriptOf(app, sid)
        // 助手说的话（整段，不按转写的空行切 —— 一段回答里本来就有空行）
        const answers = await app.main.eval<string>(
          `window.api.message.list(${JSON.stringify(sid)}).then((ms) => ms.filter((m) => m.role === 'assistant')` +
            `.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text)).join('\\n'))`
        )
        const answer = await restoredText(app, sid, answers)
        const result = task.check({ dir, answer, mockAuths: [...mockAuths] })
        const onDisk = placeholdersOnDisk(dir)
        const requests = recorded.filter((r) => r.run === run)
        const leaked =
          mode === 'redacted' ? SECRETS.filter((s) => requests.some((r) => r.body.includes(s))) : []
        const statuses = requests.map((r) => r.status)
        const errors = statuses.filter((s) => s !== 200)
        const cache = requests
          .slice(1)
          .map((r) =>
            r.promptTokens ? Math.round(((r.cacheHit ?? 0) / r.promptTokens) * 100) : null
          )
          .filter((x): x is number => x !== null)
        const cacheText = cache.length > 0 ? `${cache.join('/')}%` : '—'
        const toolErrors = (transcript.match(/\[RESULT\] \(ERROR\)/g) ?? []).length
        rows.push(
          `| ${mode} | ${task.id} | ${result.ok ? 'ok' : '**FAILED**'} | ${onDisk.length === 0 ? 'none' : `**${onDisk.length}**`} | ` +
            `${mode === 'redacted' ? (leaked.length === 0 ? 'none' : `**${leaked.map(mask).join(', ')}**`) : 'n/a'} | ` +
            `${requests.length} (${errors.length === 0 ? 'all 200' : `**${errors.join(',')}**`}) | ${cacheText} | ${toolErrors} | ${questions} | ${seconds}s | ${result.note} |`
        )
        writeFileSync(
          join(OUT, `${run}.md`),
          redact(
            [
              `# ${run}`,
              '',
              `task ${result.ok ? 'completed' : 'NOT completed'} — ${result.note}`,
              `placeholders on disk: ${onDisk.length === 0 ? 'none' : onDisk.join('; ')}`,
              `requests: ${requests.length}, statuses ${statuses.join(',')}, cache hit ${cacheText}`,
              mode === 'redacted'
                ? `real values in requests: ${leaked.length === 0 ? 'none' : leaked.map(mask).join(', ')}` +
                  leakContexts(leaked, requests)
                : '',
              '',
              '## Answer as shown',
              '',
              '```text',
              answer,
              '```',
              '',
              '## Transcript (as stored)',
              '',
              '```text',
              transcript,
              '```',
              ''
            ].join('\n')
          )
        )
        debug(`${run}: ${result.ok ? 'ok' : 'FAILED'} ${seconds}s`)
      }
    }
    summary.push(
      '| mode | task | done | placeholders on disk | real values sent | requests | cache hit (2nd+) | tool errors | questions | time | note |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      ''
    )
    writeFileSync(join(OUT, 'README.md'), redact(summary.join('\n') + '\n'))
    console.log(redact(summary.join('\n')))
    console.log(`report: ${OUT}`)
    if (!existsSync(OUT)) throw new Error('report not written')
  },
  120 * 60 * 1000
)
