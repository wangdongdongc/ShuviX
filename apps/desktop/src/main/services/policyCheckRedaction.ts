/**
 * `shuvix policy check --redaction` —— 核对自动脱敏的策略（docs/auto-redaction-design.md §3）：agent 替用户写了
 * 「信任家里的服务器」「邮箱照发」「私钥绝不发」之后，按装进去之后的样子把两层都判一遍给它看。判定走出口用的同一份
 * 逻辑（redactionJudge.ts），主体是一条普通会话的根 agent（`--bot` 给了就是那个 bot 的）。
 *
 *   - 不带 `--category` → 两张表：每个已启用的模型，请求脱不脱敏；每一类敏感内容 × 每个脱敏的服务商（取它的第一个
 *     模型），保持占位符、发真值还是整个请求不发。类别用一个样例值判（按值写的规则用 `--value` 试自己的）；
 *   - 带 `--category` → 这一类发给每个（或 `--provider` / `--model` 指定的）模型时怎么处理，胜出的是哪条规则；
 *   - `--expect redact|send|block` 对不上 → 退出码 1（没给 `--category` 时比的是请求那一层）。
 *
 * 纯逻辑：模型清单与试算的安全上下文由 deps 给（policyCheckWiring 接线）。
 */
import {
  SENSITIVE_CATEGORIES,
  type DiscloseAction,
  type GateVerdict,
  type SecurityContext,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { judgeDisclosure, judgeModelRequest, type RedactionVerdict } from './redactionJudge'

export interface RedactionCheckDeps {
  /** 已启用服务商的已启用模型；provider = 策略里的名字（内置 = slug，自定义 = 用户起的名字） */
  models(): Array<{ provider: string; model: string }>
  /** 按给定的用户策略试算的 agent 主体安全上下文（普通会话的根 agent；给了 bot 就是那个 bot 的） */
  agentContextFor(
    userPolicies: UserPolicyFile[],
    logger: { info(m: string): void; warn(m: string): void; error(m: string): void },
    subject: { bot?: string }
  ): Pick<SecurityContext, 'judgeGate'>
}

/** 只在 --redaction 下用的选项 */
export const REDACTION_CHECK_FLAGS = [
  'redaction',
  'provider',
  'model',
  'category',
  'value',
  'bot'
] as const

export const REDACTION_CHECK_USAGE = [
  '       shuvix policy check [<file>] --redaction [--provider <name>] [--model <id>] [--bot <id>]',
  '                           [--category <CATEGORY> [--value <text>]] [--expect redact|send|block]',
  '',
  '  --redaction       check auto-redaction: whether each model gets redacted requests, and what happens to',
  '                    each category of sensitive content (see the redaction knowledge entry)',
  '  --provider <name> a provider as Settings names it (builtin ones by slug); --model <id> one of its models',
  '  --bot <id>        judge for this bot (its shuvix-id), not for an ordinary session',
  '  --category <C>    one category (API_KEY, EMAIL, PRIVATE_KEY, …); --value <text> its value (default: a sample)',
  '  --expect redact|send|block   with --redaction: placeholder / real value / not sent; exit 1 when it differs'
].join('\n')

/** 每一类的样例值与认出它的规则（按值写的规则用 --value 试真正关心的那个） */
const SAMPLES: Record<string, { rule: string; value: string }> = {
  PRIVATE_KEY: {
    rule: 'private-key',
    value:
      '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----'
  },
  API_KEY: { rule: 'sk-key', value: 'sk-proj-Sample0Sample0Sample0Sample0' },
  TOKEN: { rule: 'jwt', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW1wbGUifQ.c2FtcGxlc2lnbmF0dXJl' },
  PASSWORD: { rule: 'url-password', value: 'Sample-Pa55word!' },
  SECRET: { rule: 'secret-field', value: 'sample-secret-0123456789' },
  EMAIL: { rule: 'email', value: 'someone@company-sample.net' },
  ID_CARD: { rule: 'cn-id-card', value: '11010519491231002X' },
  PHONE: { rule: 'cn-mobile', value: '13812345678' },
  BANK_CARD: { rule: 'bank-card', value: '4111111111111111' },
  SSN: { rule: 'ssn', value: '123-45-6789' },
  PASSPORT: { rule: 'passport', value: 'E12345678' },
  IBAN: { rule: 'iban', value: 'GB82WEST12345698765432' },
  BIRTHDAY: { rule: 'birthday', value: '1990-04-12' },
  MAC: { rule: 'mac', value: '3c:22:fb:1a:2b:3c' },
  SERIAL: { rule: 'serial', value: 'C02XK1ZZJGH5' },
  USERNAME: { rule: 'home-path', value: 'alice' },
  HOSTNAME: { rule: 'ssh-target', value: 'build-server-01' },
  IP: { rule: 'ipv4', value: '8.8.4.4' },
  BUCKET: { rule: 'bucket-url', value: 'acme-backups' }
}

class RedactionUsageError extends Error {}
export { RedactionUsageError }

const ACTIONS: readonly DiscloseAction[] = ['redact', 'send', 'block']

function ruleOf(verdict: GateVerdict): string {
  const winning = verdict.decision.winning
  return winning.startsWith('default') ? 'no rule matched' : winning
}

const REQUEST_WORDS: Record<DiscloseAction, string> = {
  redact: 'redacted',
  send: 'real values (trusted)',
  block: 'not sent'
}
const CELL_WORDS: Record<DiscloseAction, string> = {
  redact: 'placeholder',
  send: 'real value',
  block: 'not sent'
}

export function runRedactionCheck(
  flags: Map<string, string>,
  users: UserPolicyFile[],
  deps: RedactionCheckDeps,
  out: string[],
  formatTable: (rows: string[][]) => string[]
): { out: string[]; exitCode: 0 | 1 } {
  const provider = flags.get('provider')
  const model = flags.get('model')
  const bot = flags.get('bot')
  const category = flags.get('category')?.toUpperCase()
  const value = flags.get('value')
  const expect = flags.get('expect')
  if (model !== undefined && provider === undefined) {
    throw new RedactionUsageError(
      '--model needs --provider (a model id means nothing without its provider).'
    )
  }
  if (category !== undefined && !(SENSITIVE_CATEGORIES as readonly string[]).includes(category)) {
    throw new RedactionUsageError(
      `Unknown category '${category}'. Categories: ${SENSITIVE_CATEGORIES.join(', ')}.`
    )
  }
  if (value !== undefined && category === undefined) {
    throw new RedactionUsageError('--value needs --category (whose value it is).')
  }
  if (expect !== undefined && !(ACTIONS as readonly string[]).includes(expect)) {
    throw new RedactionUsageError('With --redaction, --expect takes redact, send or block.')
  }

  const warnings: string[] = []
  const logger = {
    info: () => {},
    warn: (m: string) => {
      if (!m.includes('is not provided by the host')) warnings.push(m)
    },
    error: (m: string) => warnings.push(m)
  }
  const security = deps.agentContextFor(users, logger, bot === undefined ? {} : { bot })

  // ── 要判的模型 ──
  const all = deps.models()
  let targets = all
  if (provider !== undefined) {
    targets = all.filter(
      (m) => m.provider === provider && (model === undefined || m.model === model)
    )
    if (targets.length === 0) {
      targets = [{ provider, model: model ?? 'any-model' }]
      out.push(
        `Note: no enabled model of provider '${provider}'${model ? ` named '${model}'` : ''} — checked it anyway.`
      )
    }
  } else if (targets.length === 0) {
    targets = [{ provider: 'example-provider', model: 'example-model' }]
    out.push(
      'Note: no provider is enabled — checked a made-up one (example-provider / example-model).'
    )
  }
  const who =
    bot === undefined ? 'the root agent of an ordinary session' : `the root agent of bot ${bot}`

  const first = targets.map((t) => ({
    ...t,
    verdict: judgeModelRequest(security, t.provider, t.model)
  }))
  let exitCode: 0 | 1 = 0

  // ── 一类 ──
  if (category !== undefined) {
    const sample = SAMPLES[category]!
    const item = { category, rule: sample.rule, value: value ?? sample.value }
    out.push(`${category}${value === undefined ? ' (a sample value)' : ''}, for ${who}:`)
    for (const t of first) {
      const result: RedactionVerdict =
        t.verdict.action === 'redact'
          ? judgeDisclosure(security, item, t.provider, t.model)
          : t.verdict
      const why =
        t.verdict.action === 'redact'
          ? ruleOf(result.verdict)
          : `the request is ${REQUEST_WORDS[t.verdict.action]} — ${ruleOf(t.verdict.verdict)}`
      const mismatch = expect !== undefined && expect !== result.action
      if (mismatch) exitCode = 1
      out.push(
        `${mismatch ? '✗' : '-'} ${t.provider} / ${t.model}: ${CELL_WORDS[result.action]} (${why})` +
          (mismatch ? ` — expected ${CELL_WORDS[expect as DiscloseAction]}` : '')
      )
    }
    return { out: withWarnings(out, warnings), exitCode }
  }

  // ── 第一层：每个模型 ──
  out.push(`Model requests, for ${who}:`)
  const requestRows = [['provider', 'model', 'request', 'rule']]
  for (const t of first) {
    const mismatch = expect !== undefined && expect !== t.verdict.action
    if (mismatch) exitCode = 1
    requestRows.push([
      t.provider,
      t.model,
      REQUEST_WORDS[t.verdict.action] +
        (mismatch ? ` ✗ expected ${REQUEST_WORDS[expect as DiscloseAction]}` : ''),
      ruleOf(t.verdict.verdict)
    ])
  }
  out.push(...formatTable(requestRows), '')

  // ── 第二层：每一类 × 每个脱敏的服务商（取它的第一个模型） ──
  const columns: Array<{ provider: string; model: string }> = []
  for (const t of first) {
    if (t.verdict.action === 'redact' && !columns.some((c) => c.provider === t.provider))
      columns.push(t)
  }
  if (columns.length === 0) {
    out.push('No model gets redacted requests, so no category is kept as a placeholder.')
    return { out: withWarnings(out, warnings), exitCode }
  }
  out.push(
    'Sensitive content in redacted requests (a sample value per category; the first model of each provider —',
    'check another with --provider / --model, a value of your own with --category and --value):'
  )
  const header = ['category', ...columns.map((c) => `${c.provider} / ${c.model}`)]
  const rows = [header]
  for (const cat of SENSITIVE_CATEGORIES) {
    const sample = SAMPLES[cat]!
    rows.push([
      cat,
      ...columns.map(
        (c) =>
          CELL_WORDS[
            judgeDisclosure(security, { category: cat, ...sample }, c.provider, c.model).action
          ]
      )
    ])
  }
  out.push(...formatTable(rows))
  return { out: withWarnings(out, warnings), exitCode }
}

function withWarnings(out: string[], warnings: string[]): string[] {
  const unique = [...new Set(warnings)]
  if (unique.length > 0) out.push('', 'Policy engine warnings:', ...unique.map((w) => `- ${w}`))
  return out
}
