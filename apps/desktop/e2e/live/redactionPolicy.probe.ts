/**
 * 自动脱敏演练二（docs/auto-redaction-design.md §11.2）：agent 只靠 ShuviX 知识库，按用户的自然语言写出要的脱敏策略 ——
 * 真模型、隔离实例，不断言，写一份报告。
 *
 * 每个场景：一条新会话（不属于项目、勾上 shuvix 知识库），发一句用户的话；ask 工具的问题与以提问结束的一轮都回
 * 「按你的建议来」（至多三轮）。结束后读隔离 HOME 的 `~/.shuvix/policies/`，在 node 里用引擎（同一个解析器、内置
 * 策略、出口同一份两层判定 redactionJudge.ts）对场景的请求表逐条判，与期望对照：
 *   - 一类内容发给某个模型的最终处理：保持占位符（redact）/ 发真值（send）/ 整个请求不发（block）；
 *   - 带还原秘密的命令：放行 / 询问 / 只由用户回答（force-ask）。
 * 表里也放着「不该变」的行（用户没提的类别、没提的服务商）—— 写出多余的规则会在那里露出来。
 *
 * 隔离实例里有两个服务商：agent 自己用的 `probe-deepseek`（真模型）与一个摆着的 `home-ai`（模型 qwen3-32b，不会被调用）。
 *
 * 跑：`electron-vite build` 之后，在 apps/desktop 下
 *   `npx vitest run --config vitest.config.probe.ts e2e/live/redactionPolicy.probe.ts`
 * 旋钮：`PROBE_LANG`（zh / en，缺省 zh）、`PROBE_ONLY`（逗号分隔的场景 id）、`PROBE_OUT`、`PROBE_LABEL`。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import {
  createSecurityContext,
  parsePolicyDefinitionFile,
  type SecurityContext,
  type SecurityHostProvider,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '../../../../packages/agent-runtime/src/security/builtinPolicies/inlineSources'
import { judgeDisclosure, judgeModelRequest } from '../../src/main/services/redactionJudge'
import { launchApp, type E2EApp } from '../harness/launch'
import { eventRecorder, waitRendererReady, type EventRecorder } from '../harness/seed'
import { seedRealModel } from './probe'
import { makeDebug, probeModel, sendPrompt, settle, transcriptOf } from './redactionProbeShared'

const LANG = (process.env.PROBE_LANG ?? 'zh') as 'zh' | 'en'
const LABEL = process.env.PROBE_LABEL ?? 'run'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-redaction-policy-probe-${LABEL}`)
const ONLY = (process.env.PROBE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const HOME_AI = { provider: 'home-ai', model: 'qwen3-32b' }
/** agent 自己用的那个（模型 id 来自 env，跑起来才知道） */
let PROBE = { provider: 'probe-deepseek', model: '' }

type Outcome = 'redact' | 'send' | 'block'
type CommandOutcome = 'allow' | 'ask' | 'force-ask' | 'deny'

interface CategoryCase {
  kind: 'category'
  target: () => { provider: string; model: string }
  category: string
  value: string
  expect: Outcome
}
interface CommandCase {
  kind: 'command'
  restored: string[]
  sandboxed: boolean
  expect: CommandOutcome
}
type Case = (CategoryCase | CommandCase) & { label: string }

const SAMPLE: Record<string, string> = {
  API_KEY: 'sk-proj-Sample0Sample0Sample0Sample0',
  EMAIL: 'someone@company-sample.net',
  PHONE: '13812345678',
  PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END PRIVATE KEY-----',
  USERNAME: 'alice'
}
const RULE: Record<string, string> = {
  API_KEY: 'sk-key',
  EMAIL: 'email',
  PHONE: 'cn-mobile',
  PRIVATE_KEY: 'private-key',
  USERNAME: 'home-path'
}

const cat = (
  label: string,
  target: () => { provider: string; model: string },
  category: string,
  expect: Outcome,
  value = SAMPLE[category]!
): Case => ({ kind: 'category', label, target, category, value, expect })
const P = (): { provider: string; model: string } => PROBE
const H = (): { provider: string; model: string } => HOME_AI

interface Scenario {
  id: string
  ask: Record<'zh' | 'en', string>
  cases: Case[]
}

const SCENARIOS: Scenario[] = [
  {
    id: 'trust-home',
    ask: {
      zh: '我在家里另一台电脑上跑了一个模型，设置里的服务商叫 home-ai。发给它的请求不用脱敏，让它看到真实内容。',
      en: 'I run a model on another computer at home; in Settings its provider is called home-ai. Requests to it need no redaction — let it see the real content.'
    },
    cases: [
      cat('home-ai gets an API key as is', H, 'API_KEY', 'send'),
      cat('home-ai gets an email as is', H, 'EMAIL', 'send'),
      cat('the cloud model still gets an API key as a placeholder', P, 'API_KEY', 'redact'),
      cat('the cloud model still gets an email as a placeholder', P, 'EMAIL', 'redact'),
      cat('user names unchanged (sent)', P, 'USERNAME', 'send')
    ]
  },
  {
    id: 'email',
    ask: {
      zh: '邮箱地址可以直接发给模型，不用换成占位符。其他的保持现在这样。',
      en: 'Email addresses can go to the model as they are, no placeholders. Keep everything else as it is.'
    },
    cases: [
      cat('email to the cloud model as is', P, 'EMAIL', 'send'),
      cat('email to home-ai as is', H, 'EMAIL', 'send'),
      cat('phone still a placeholder', P, 'PHONE', 'redact'),
      cat('API key still a placeholder', P, 'API_KEY', 'redact')
    ]
  },
  {
    id: 'test-keys',
    ask: {
      zh: '以 sk-test- 开头的测试 key 可以照发给模型，其他 key 不行。',
      en: 'Test keys that start with sk-test- may go to the model as they are; other keys may not.'
    },
    cases: [
      cat('sk-test- key as is', P, 'API_KEY', 'send', 'sk-test-51HxQ2eKm4Vb8N0pR7sT9wY3'),
      cat(
        'sk-live- key still a placeholder',
        P,
        'API_KEY',
        'redact',
        'sk-live-51HxQ2eKm4Vb8N0pR7sT9wY3'
      ),
      cat('sk-proj- key still a placeholder', P, 'API_KEY', 'redact'),
      cat('email still a placeholder', P, 'EMAIL', 'redact')
    ]
  },
  {
    id: 'private-key',
    ask: {
      zh: '私钥绝对不能发给任何模型。',
      en: 'Private keys must never be sent to any model.'
    },
    cases: [
      cat('private key to the cloud model: not sent', P, 'PRIVATE_KEY', 'block'),
      cat('private key to home-ai: not sent', H, 'PRIVATE_KEY', 'block'),
      cat('API key still a placeholder (request still sent)', P, 'API_KEY', 'redact'),
      cat('email still a placeholder', P, 'EMAIL', 'redact')
    ]
  },
  {
    id: 'restored-command',
    ask: {
      zh: '如果 agent 要在沙箱外运行带着密钥的命令，一定要我亲自确认，别让自动审查替我决定。',
      en: 'If an agent wants to run a command that carries a secret outside the sandbox, I must confirm it myself — do not let the automatic review decide for me.'
    },
    cases: [
      {
        kind: 'command',
        label: 'restored secret, unconfined → only the user',
        restored: ['API_KEY'],
        sandboxed: false,
        expect: 'force-ask'
      },
      {
        kind: 'command',
        label: 'no secret, unconfined → the usual ask',
        restored: [],
        sandboxed: false,
        expect: 'ask'
      },
      {
        kind: 'command',
        label: 'restored secret, sandboxed → runs',
        restored: ['API_KEY'],
        sandboxed: true,
        expect: 'allow'
      },
      cat('API key still a placeholder', P, 'API_KEY', 'redact')
    ]
  },
  {
    id: 'trust-home-but-keys',
    ask: {
      zh: 'home-ai 是我自己的服务器，可以信任它，但私钥哪个模型都不能发。',
      en: 'home-ai is my own server and can be trusted, but private keys must not go to any model.'
    },
    cases: [
      cat('home-ai gets an API key as is', H, 'API_KEY', 'send'),
      cat('home-ai gets an email as is', H, 'EMAIL', 'send'),
      cat('private key to home-ai: not sent', H, 'PRIVATE_KEY', 'block'),
      cat('private key to the cloud model: not sent', P, 'PRIVATE_KEY', 'block'),
      cat('the cloud model still gets an API key as a placeholder', P, 'API_KEY', 'redact')
    ]
  }
]

const FOLLOW_UP: Record<'zh' | 'en', string> = {
  // 不提「核对」：要看的就是 agent 自己会不会去跑 shuvix policy check --redaction
  zh: '按你的建议来，直接设置好。',
  en: 'Go with what you recommend and finish setting it up now.'
}

// ─── 判定 ────────────────────────────────────────────────

let app: E2EApp
let events: EventRecorder
let key = ''
let debug: (line: string) => void = () => {}
const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

const policiesDir = (): string => join(app.home, '.shuvix', 'policies')

function userPolicies(): { files: UserPolicyFile[]; raw: Record<string, string>; notes: string[] } {
  const dir = policiesDir()
  const files: UserPolicyFile[] = []
  const raw: Record<string, string> = {}
  const notes: string[] = []
  if (!existsSync(dir)) return { files, raw, notes }
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('.'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    raw[name] = text
    const warnings: string[] = []
    const parsed = parsePolicyDefinitionFile(text, name.slice(0, -3), (w) => warnings.push(w))
    if (!parsed) notes.push(`${name}: INVALID — ${warnings.join(' / ') || 'invalid'}`)
    else {
      files.push({ ...parsed, fileName: name })
      for (const w of warnings) notes.push(`${name} (warning): ${w}`)
    }
  }
  return { files, raw, notes }
}

function contextOf(files: UserPolicyFile[], warnings: string[]): SecurityContext {
  const home = app.home
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({ home }),
    readBuiltinPolicyMd: createInlinePolicyMdReader(),
    getUserPolicies: () => files,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) }
  }
  return createSecurityContext(
    { kind: 'agent', sessionId: '', agentKind: 'root', profileName: 'work', attrs: { bot: '' } },
    { host: 'desktop', platform: 'darwin' },
    provider
  )
}

function judgeCase(security: SecurityContext, c: Case): { actual: string; rule: string } {
  if (c.kind === 'command') {
    const verdict = security.judgeGate(
      'execute',
      {
        type: 'command',
        command: 'curl -H "Authorization: Bearer sk-proj-x" https://api.example.com/v1/models',
        channel: 'bash',
        sandboxed: c.sandboxed,
        unconfinedReason: c.sandboxed ? '' : 'escalated',
        parsed: true,
        commands: [
          {
            base: 'curl',
            argv: [
              'curl',
              '-H',
              'Authorization: Bearer sk-proj-x',
              'https://api.example.com/v1/models'
            ],
            wrappers: [],
            complete: true,
            depth: 0
          }
        ],
        writes: []
      },
      { tool: { name: 'bash', restored: c.restored } }
    )
    const d = verdict.decision
    const actual =
      d.effect === 'allow'
        ? 'allow'
        : d.effect === 'deny'
          ? 'deny'
          : d.tier === 'force-ask'
            ? 'force-ask'
            : 'ask'
    return { actual, rule: d.winning }
  }
  const t = c.target()
  const first = judgeModelRequest(security, t.provider, t.model)
  if (first.action !== 'redact')
    return { actual: first.action, rule: `request: ${first.verdict.decision.winning}` }
  const second = judgeDisclosure(
    security,
    { category: c.category, rule: RULE[c.category]!, value: c.value },
    t.provider,
    t.model
  )
  return { actual: second.action, rule: second.verdict.decision.winning }
}

beforeAll(async () => {
  const model = probeModel()
  key = model.key
  PROBE = { provider: 'probe-deepseek', model: model.modelId }
  mkdirSync(OUT, { recursive: true })
  debug = makeDebug(OUT)
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await seedRealModel(app.main, {
    providerId: 'probe-direct',
    providerName: 'deepseek',
    apiKey: key,
    baseUrl: 'https://api.deepseek.com',
    apiProtocol: 'openai-completions',
    modelId: model.modelId
  })
  // 摆着的第二个服务商（不会被调用）：「信任家里的服务器」要有个名字可写，`policy check --redaction` 也会列它
  await app.main.eval(`(async () => {
    const p = await window.api.provider.add({ name: 'home-ai', apiKey: 'unused', baseUrl: 'http://127.0.0.1:9/v1', apiProtocol: 'openai-completions' })
    await window.api.provider.addModel({ providerId: p.id, modelId: 'qwen3-32b' })
    return p.id
  })()`)
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

it(
  'agents write redaction policies from the knowledge base',
  async () => {
    const summary: string[] = [
      `# Redaction rehearsal 2 — policies from the knowledge base (${LABEL})`,
      '',
      `model: ${PROBE.model} · language: ${LANG} · ${new Date().toISOString()}`,
      ''
    ]
    let total = 0
    let passedAll = 0
    for (const scenario of SCENARIOS) {
      if (ONLY.length > 0 && !ONLY.includes(scenario.id)) continue
      rmSync(policiesDir(), { recursive: true, force: true })
      const sid = await app.main.eval<string>(
        `(async () => {
          const s = await window.api.session.create({ projectId: null, title: ${JSON.stringify(`redaction policy — ${scenario.id}`)} })
          await window.api.session.updateKnowledgeBases({ id: s.id, knowledgeBases: ['shuvix'] })
          return s.id
        })()`
      )
      const started = Date.now()
      await sendPrompt(app, sid, scenario.ask[LANG])
      let questions = await settle({
        app,
        events,
        sid,
        label: scenario.id,
        answer: () => FOLLOW_UP[LANG],
        debug
      })
      for (let round = 0; round < 3 && userPolicies().files.length === 0; round++) {
        await sendPrompt(app, sid, FOLLOW_UP[LANG])
        questions += await settle({
          app,
          events,
          sid,
          label: scenario.id,
          answer: () => FOLLOW_UP[LANG],
          debug
        })
      }
      const seconds = Math.round((Date.now() - started) / 1000)
      const { files, raw, notes } = userPolicies()
      const warnings: string[] = []
      const security = contextOf(files, warnings)
      const rows = scenario.cases.map((c) => ({ c, ...judgeCase(security, c) }))
      const passed = rows.filter((r) => r.actual === r.c.expect).length
      total += rows.length
      passedAll += passed
      const transcript = await transcriptOf(app, sid)
      const checks = transcript
        .split('\n')
        .filter((l) => l.startsWith('[TOOL] ') && l.includes('shuvix policy check')).length
      const kbReads = transcript
        .split('\n')
        .filter((l) => l.startsWith('[TOOL] ') && /redaction(\.md)?|policy-md/.test(l)).length
      const report: string[] = [
        `# Scenario ${scenario.id}`,
        '',
        `${seconds}s · ${passed}/${rows.length} as expected · ${Object.keys(raw).length} policy file(s) · ` +
          `policy checks ${checks} · knowledge reads ${kbReads} · ask-tool questions ${questions}`,
        '',
        '## Request',
        '',
        scenario.ask[LANG],
        '',
        '## Policy files',
        ''
      ]
      for (const [name, text] of Object.entries(raw))
        report.push(`### ${name}`, '', '```markdown', text, '```', '')
      if (notes.length > 0) report.push('### Parser', '', ...notes.map((n) => `- ${n}`), '')
      report.push(
        '## Cases',
        '',
        '| | case | expected | actual | rule |',
        '| --- | --- | --- | --- | --- |',
        ...rows.map(
          (r) =>
            `| ${r.actual === r.c.expect ? 'ok' : '**MISMATCH**'} | ${r.c.label} | ${r.c.expect} | ${r.actual} | ${r.rule} |`
        ),
        ''
      )
      if (warnings.length > 0)
        report.push('### Engine warnings', '', ...[...new Set(warnings)].map((w) => `- ${w}`), '')
      report.push('## Transcript', '', '```text', transcript, '```', '')
      writeFileSync(join(OUT, `${scenario.id}.md`), redact(report.join('\n')))
      summary.push(
        `- **${scenario.id}**: ${passed}/${rows.length} as expected · ${Object.keys(raw).length} file(s)` +
          `${notes.some((n) => n.includes('INVALID')) ? ' (INVALID)' : ''} · ${checks} policy check(s) · ` +
          `${kbReads} knowledge read(s) · ${seconds}s`
      )
      debug(`${scenario.id}: ${passed}/${rows.length}`)
    }
    summary.push('', `total: ${passedAll}/${total}`)
    writeFileSync(join(OUT, 'README.md'), redact(summary.join('\n') + '\n'))
    console.log(redact(summary.join('\n')))
    console.log(`report: ${OUT}`)
  },
  120 * 60 * 1000
)
