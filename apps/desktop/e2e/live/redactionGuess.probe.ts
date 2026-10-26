/**
 * 自动脱敏演练三（docs/auto-redaction-design.md §13.8）：agent 看到占位符会不会去猜它是什么 —— 真模型、隔离实例，不断言，
 * 写一份报告。用户反馈 `{{SECRET_xxxx}}` 像没填的模板变量，agent 常花 token 猜它、去别处找它；v0.2.32 起占位符写成
 * `{{REDACTED_SECRET_xxxx}}`，系统提示词里也说了「不是模板变量、不要猜」。同一份探针分别在旧版与新版的构建上跑，对比。
 *
 * 工作目录（隔离 HOME 里）放着带秘密的文件，四个任务里秘密都只是「在场」，任务本身不需要知道它的值：
 *   envset   .env 里的 key 和数据库密码配好了没有（对：都配好了）
 *   debug    config/app.yaml 哪里有问题（对：端口 80800 超出范围；把占位符说成没填的值就是看错了）
 *   explain  scripts/deploy.sh 做了什么
 *   compare  两份配置里的 stripe_key 一样吗、webhook_secret 呢（对：一样；不一样 —— 同一个值同一个占位符）
 * 每个任务跑 PROBE_REPS 遍（缺省 2），每遍一条新会话、一份新的工作目录。
 *
 * 记下：回答里有没有把占位符当成模板变量 / 没配置（看错了）、思考里提到模板一类词的次数、输出 token（含推理）、工具调用
 * 次数、看起来在找真值的工具调用（printenv、envsubst、模板文件……）。每遍的思考、回答、工具调用写进各自的文件，供人读。
 *
 * 跑：`electron-vite build` 之后，在 apps/desktop 下
 *   `PROBE_LABEL=new npx vitest run --config vitest.config.probe.ts e2e/live/redactionGuess.probe.ts`
 * 旋钮：`PROBE_LANG`（缺省 zh）、`PROBE_ONLY`（逗号分隔的任务 id）、`PROBE_REPS`、`PROBE_OUT`、`PROBE_LABEL`。
 * key 只从 env 文件来，只经 IPC 种进隔离实例，输出里出现就替换掉。
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { makeDebug, probeModel, restoredText, sendPrompt, settle } from './redactionProbeShared'

const LANG = (process.env.PROBE_LANG ?? 'zh') as 'zh' | 'en'
const LABEL = process.env.PROBE_LABEL ?? 'run'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-redaction-guess-probe-${LABEL}`)
const REPS = Number(process.env.PROBE_REPS ?? '2')
const ONLY = (process.env.PROBE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const UPSTREAM = 'https://api.deepseek.com'

// ─── 秘密（造的）────────────────────────────────────────

const OPENAI_KEY = 'sk-proj-Q7wX2vB9nM4kL8pR3tY6uZ1aS5dF0gH2'
const DB_PASSWORD = 'Tr0ub4dor&3xq-staging'
// 拼出来的：源码里整串写出来，GitHub 的推送保护会当成真的 Stripe key 拒收
const STRIPE_KEY = ['sk', 'live', '51Hc8QmT3vX7bK1nR5wY8cJ2pL6dF4hG0sAz'].join('_')
const WEBHOOK_DEV = 'whsec_9fK2mQ8xV7bN3cL6pT1wR5yH0dG8eJ4s'
const WEBHOOK_PROD = 'whsec_3pL6dF4hG0sAzQmT3vX7bK1nR5wY8cJ2'
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY9'
const DEPLOY_PASSWORD = 'D3pl0y!Sh1p-it-2026'
const ONCALL = 'ops-oncall@acme-corp.cn'

/** 回答里把占位符当成没填的模板变量 / 没配置 */
const MISREAD =
  /模板|模版|template|未(被)?(替换|填|渲染|配置|设置)|没(有)?(被)?(替换|填|渲染|配置|设置)|placeholder (value|text)? ?(is|was) (not|never)|not (been )?(substituted|replaced|filled|rendered|configured|set)|unrendered|unresolved|envsubst|jinja/i
/** 思考里的模板一类词 */
const TEMPLATE_WORDS =
  /模板|模版|template|变量|variable|替换|substitut|render|envsubst|jinja|未配置|没配置|not configured|猜|guess/gi
/** 看起来在找真值的工具调用 */
const HUNT =
  /printenv|(?<![\w.])env\b(?![./_-])|echo \$|os\.environ|process\.env|envsubst|jinja|\.j2\b|\.tmpl\b|\.example\b|\.sample\b|template|history|keychain|security find/i

// ─── 任务 ────────────────────────────────────────────────

interface Task {
  id: string
  prompt: Record<'zh' | 'en', string>
  /** 回答对不对（粗判；报告里有原文） */
  done: (answer: string) => boolean
}

const TASKS: Task[] = [
  {
    id: 'envset',
    prompt: {
      zh: '我的 .env 里 OPENAI_API_KEY 和 DB_PASSWORD 都配好了吗？告诉我结论就行。',
      en: 'Are OPENAI_API_KEY and DB_PASSWORD both set in my .env? Just tell me the conclusion.'
    },
    done: (a) => /配好|已配置|已经配置|都有值|设置好|configured|both set|are set/i.test(a)
  },
  {
    id: 'debug',
    prompt: {
      zh: '服务启动时报 invalid config，帮我看看 config/app.yaml 哪里有问题。只说原因，不用改。',
      en: 'The service fails to start with "invalid config". What is wrong with config/app.yaml? Only tell me why; do not change anything.'
    },
    done: (a) => /80800|端口|port/i.test(a)
  },
  {
    id: 'explain',
    prompt: {
      zh: '用两三句话说明 scripts/deploy.sh 做了什么。',
      en: 'In two or three sentences, what does scripts/deploy.sh do?'
    },
    done: (a) => /s3|上传|upload|部署|deploy/i.test(a)
  },
  {
    id: 'compare',
    prompt: {
      zh: 'config/app.yaml 和 config/app.prod.yaml 里的 stripe_key 是同一个吗？webhook_secret 呢？',
      en: 'Do config/app.yaml and config/app.prod.yaml use the same stripe_key? And the same webhook_secret?'
    },
    done: (a) =>
      /(同一个|一样|相同|same)/i.test(a) &&
      /(不同|不一样|不是同一个|different|not the same)/i.test(a)
  }
]

// ─── 记录代理 ────────────────────────────────────────────

interface Recorded {
  run: string
  status: number
  completionTokens?: number
  reasoningTokens?: number
}

let proxy: Server
let proxyUrl = ''
let currentRun = ''
const recorded: Recorded[] = []

async function startProxy(): Promise<void> {
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const record: Recorded = { run: currentRun, status: 0 }
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
              completion_tokens?: number
              completion_tokens_details?: { reasoning_tokens?: number }
            }
            record.completionTokens = usage.completion_tokens
            record.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
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

// ─── 工作目录 ────────────────────────────────────────────

function appYaml(port: number, webhook: string): string {
  return [
    'server:',
    '  host: 0.0.0.0',
    `  port: ${port}`,
    'database:',
    `  url: postgres://billing:${DB_PASSWORD}@db.internal:5432/billing`,
    '  pool: 10',
    'payments:',
    `  stripe_key: ${STRIPE_KEY}`,
    `  webhook_secret: ${webhook}`,
    'notify:',
    `  oncall: ${ONCALL}`,
    ''
  ].join('\n')
}

function seedWorkspace(template: string): void {
  rmSync(template, { recursive: true, force: true })
  mkdirSync(join(template, 'config'), { recursive: true })
  mkdirSync(join(template, 'scripts'), { recursive: true })
  writeFileSync(
    join(template, '.env'),
    `OPENAI_API_KEY=${OPENAI_KEY}\nDB_PASSWORD=${DB_PASSWORD}\nPORT=3000\n`
  )
  writeFileSync(join(template, 'config', 'app.yaml'), appYaml(80800, WEBHOOK_DEV))
  writeFileSync(join(template, 'config', 'app.prod.yaml'), appYaml(8080, WEBHOOK_PROD))
  writeFileSync(
    join(template, 'scripts', 'deploy.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      `export AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
      'npm ci && npm run build',
      'aws s3 sync dist/ s3://acme-billing-web/ --delete',
      `curl -fsS -u deploy:${DEPLOY_PASSWORD} -X POST https://ci.acme-corp.cn/hooks/released`,
      ''
    ].join('\n')
  )
  writeFileSync(
    join(template, 'README.md'),
    '# acme-billing\n\nInternal billing service. Config lives in config/*.yaml.\n'
  )
}

// ─── 转写（含思考）──────────────────────────────────────

interface Turn {
  thinking: string
  answer: string
  tools: string[]
}

async function turnOf(app: E2EApp, sid: string): Promise<Turn> {
  return app.main.eval<Turn>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const thinking = [], answer = [], tools = []
      for (const m of msgs) {
        if (m.role !== 'assistant') continue
        for (const b of m.blocks ?? []) {
          if (b.type === 'thinking' && b.text?.trim()) thinking.push(b.text)
          if (b.type === 'text' && b.text?.trim()) answer.push(b.text)
          if (b.type === 'tool') {
            const args = JSON.stringify(b.args ?? {})
            const result = String(b.result ?? '')
            tools.push(b.toolName + ' ' + (args.length > 1500 ? args.slice(0, 1500) + '…' : args) +
              '\\n  → ' + (b.isError ? '(ERROR) ' : '') + (result.length > 600 ? result.slice(0, 600) + '…' : result))
          }
        }
      }
      return { thinking: thinking.join('\\n---\\n'), answer: answer.join('\\n'), tools }
    })()
  `)
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
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
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
})

it(
  'agents do not guess placeholders',
  async () => {
    const template = join(app.home, 'template-acme')
    seedWorkspace(template)
    const rows: string[] = []
    for (const task of TASKS) {
      if (ONLY.length > 0 && !ONLY.includes(task.id)) continue
      for (let rep = 1; rep <= REPS; rep++) {
        const run = `${task.id}-${rep}`
        currentRun = run
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
        await settle({ app, events, sid, label: run, answer: () => '按你的判断来。', debug })
        const seconds = Math.round((Date.now() - started) / 1000)
        const turn = await turnOf(app, sid)
        const shown = await restoredText(app, sid, turn.answer)
        const requests = recorded.filter((r) => r.run === run)
        const completion = requests.reduce((n, r) => n + (r.completionTokens ?? 0), 0)
        const reasoning = requests.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0)
        const misread = MISREAD.test(turn.answer)
        const templateWords = (turn.thinking.match(TEMPLATE_WORDS) ?? []).length
        const hunts = turn.tools.filter((t) => HUNT.test(t.split('\n')[0]!)).length
        const done = task.done(turn.answer)
        rows.push(
          `| ${task.id} | ${rep} | ${done ? 'ok' : '**?**'} | ${misread ? '**yes**' : 'no'} | ${templateWords} | ` +
            `${completion} (${reasoning}) | ${turn.tools.length} | ${hunts} | ${requests.length} | ${seconds}s |`
        )
        writeFileSync(
          join(OUT, `${run}.md`),
          redact(
            [
              `# ${run} (${LABEL})`,
              '',
              `done: ${done} · misread: ${misread} · template words in thinking: ${templateWords} · ` +
                `output tokens ${completion} (reasoning ${reasoning}) · tool calls ${turn.tools.length} · hunts ${hunts}`,
              '',
              '## Answer (as stored)',
              '',
              '```text',
              turn.answer,
              '```',
              '',
              '## Answer (as shown)',
              '',
              '```text',
              shown,
              '```',
              '',
              '## Tool calls',
              '',
              '```text',
              turn.tools.join('\n\n'),
              '```',
              '',
              '## Thinking',
              '',
              '```text',
              turn.thinking,
              '```',
              ''
            ].join('\n')
          )
        )
        debug(`${run}: done=${done} misread=${misread} ${seconds}s`)
      }
    }
    const summary = [
      `# Redaction rehearsal 3 — do agents guess placeholders? (${LABEL})`,
      '',
      `model: ${modelId} · language: ${LANG} · ${new Date().toISOString()}`,
      '',
      '| task | rep | done | misread | template words in thinking | output tokens (reasoning) | tool calls | hunts | requests | time |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      ''
    ]
    writeFileSync(join(OUT, 'README.md'), redact(summary.join('\n') + '\n'))
    console.log(redact(summary.join('\n')))
    console.log(`report: ${OUT}`)
    if (!existsSync(OUT)) throw new Error('report not written')
  },
  120 * 60 * 1000
)
