/**
 * Protocol probe (P4-06): one short live check per wire protocol, through the same model layer and
 * durable session runtime the desktop uses, with keys that come **only** from env vars.
 *
 * ── How to run it ─────────────────────────────────────────────────────────────────────────────
 *
 *  1. Put the keys in a file **outside the repo**, dotenv style (one `NAME=value` per line; only
 *     `SHUVIX_PROBE_*` names are read, everything else in the file is ignored):
 *
 *        SHUVIX_PROBE_ANTHROPIC_KEY=...
 *        SHUVIX_PROBE_OPENAI_KEY=...
 *        SHUVIX_PROBE_MAX_USD=1
 *
 *  2. From the workspace root (or `apps/desktop`):
 *
 *        SHUVIX_PROBE_ENV_FILE=~/probe-keys.env npm run probe:protocols
 *
 *     (an absolute or `~/` path: npm runs the script inside `apps/desktop`). `SHUVIX_PROBE_*` set
 *     directly in the shell work too and win over the file. Families
 *     without a key are skipped. The redacted markdown report goes to `PROBE_OUT` (default
 *     `$TMPDIR/shuvix-protocol-probe.md`); it is checked to contain no key before it is written.
 *
 *  3. `npm run probe:protocols:dry` runs the durable-session cases against a scripted faux provider:
 *     no keys, no network (any fetch fails the run). It verifies the probe code itself.
 *
 * Env vars per family (`_MODEL` is optional everywhere except the custom endpoint; the default is
 * the provider's cheapest priced reasoning model of that protocol, see `pickDefaultModel`):
 *
 *   anthropic-messages     SHUVIX_PROBE_ANTHROPIC_KEY, SHUVIX_PROBE_ANTHROPIC_MODEL
 *   openai-responses       SHUVIX_PROBE_OPENAI_KEY, SHUVIX_PROBE_OPENAI_MODEL
 *   openai-completions     SHUVIX_PROBE_COMPLETIONS_PROVIDER (deepseek | groq | openrouter,
 *                          default deepseek), SHUVIX_PROBE_COMPLETIONS_KEY, SHUVIX_PROBE_COMPLETIONS_MODEL
 *   google-generative-ai   SHUVIX_PROBE_GOOGLE_KEY, SHUVIX_PROBE_GOOGLE_MODEL
 *   mistral-conversations  SHUVIX_PROBE_MISTRAL_KEY, SHUVIX_PROBE_MISTRAL_MODEL
 *   xai (responses)        SHUVIX_PROBE_XAI_KEY, SHUVIX_PROBE_XAI_MODEL
 *   Kimi UA check          SHUVIX_PROBE_KIMI_KEY, SHUVIX_PROBE_KIMI_MODEL
 *   custom endpoint        SHUVIX_PROBE_CUSTOM_BASE_URL, SHUVIX_PROBE_CUSTOM_KEY, SHUVIX_PROBE_CUSTOM_MODEL,
 *                          SHUVIX_PROBE_CUSTOM_PROTOCOL (default openai-completions),
 *                          SHUVIX_PROBE_CUSTOM_HEADERS (JSON object), SHUVIX_PROBE_CUSTOM_VISION=1
 *   run knobs              SHUVIX_PROBE_MAX_USD (soft budget, default 1), SHUVIX_PROBE_DRY=1, PROBE_OUT
 *
 * ── What it checks (phase-4 plan §5; P = raw `models.streamSimple`, D = a durable session turn) ──
 *
 *   1 streaming (P) · 2 usage and cost (P, D) · 3 tool round trip + UI projection (D) ·
 *   4 thinking + a replayed second turn (D) · 5 abort, then resume (D) · 6 invalid key ends without
 *   a retry within 15 s (D) · 7 every request carries `timeoutMs 600000`, `maxRetries 0` (D) ·
 *   8 User-Agent seen by a fetch spy, Kimi 403 → P4-07 (P) · 9 vision, optional (P).
 *
 * Failure policy (Q-P4-10): FAIL fails the vitest case; WARN is a non-blocking follow-up (cost on an
 * unpriced model, a hidden thinking block, an inconclusive abort, a UA mismatch outside Kimi).
 *
 * ── Safety ────────────────────────────────────────────────────────────────────────────────────
 *
 * Plain vitest in node: no desktop app, no app database, no profile directory. Sessions live in
 * `MemoryStorage` on a private `SessionHost`. Keys sit in an in-memory `ProviderCredentialPort`
 * only; the registry's `AuthContext` answers no env var and no file, so ambient provider variables
 * are never consulted. Production config throughout: `createModelRegistry` (→ `withNetwork`) with
 * the desktop `llmNetwork` (its logger is mocked to the console) and the SessionHost's own
 * `createShuviXSettings()` (retry 10, stream `timeoutMs 600000` / `maxRetries 0`).
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { arch, homedir, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest'
import {
  calculateCost,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  Type,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthContext,
  type Context,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type Message,
  type Model,
  type Models,
  type Provider,
  type Usage,
  type UserMessage
} from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  LiveDoc,
  MemoryStorage,
  ToolResultEntry,
  UsageDoc,
  defineTool,
  type ConversationId,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import {
  backgroundContext as BG,
  createModelRegistry,
  createSessionHost,
  createShuviXSettings,
  projectSessionView,
  resolveDisplayItems,
  SHUVIX_RETRY_POLICY,
  SHUVIX_STREAM_OPTIONS,
  type AgentConfig,
  type DurableSession,
  type ModelRegistry,
  type ModelSelection,
  type ProviderCredentialPort,
  type ProviderModelRow,
  type ProviderRow,
  type RuntimeLogger,
  type SessionHost,
  type ToolHost
} from '@shuvix/agent-runtime'
import type { AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { installLlmNetwork, llmNetwork } from '../../src/main/services/models/llmNetwork'
import {
  assertNoSecrets,
  collectProbeEnv,
  familyEnvVars,
  familyRunnable,
  modelIsPriced,
  pickDefaultModel,
  probeOptions,
  redact,
  resolveFamilies,
  secretsOf,
  type FamilyConfig
} from './protocolProbeEnv'

// The desktop logger writes through electron-log; in plain node it goes to the console.
vi.mock('electron-log/main', () => {
  const scoped = {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: () => {},
    verbose: () => {},
    silly: () => {},
    log: (...args: unknown[]) => console.log(...args)
  }
  return {
    default: { ...scoped, scope: () => scoped, transports: { file: {}, console: {} }, hooks: [] }
  }
})

// ─────────────────────────── configuration ───────────────────────────

const expandHome = (path: string): string =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path

const ENV_FILE = process.env.SHUVIX_PROBE_ENV_FILE?.trim()
const ENV = collectProbeEnv(
  process.env,
  ENV_FILE ? readFileSync(expandHome(ENV_FILE), 'utf8') : undefined
)
const OPTIONS = probeOptions(ENV, process.env, join(tmpdir(), 'shuvix-protocol-probe.md'))
const DRY = OPTIONS.dry

/** Not a key: what the dry faux family "uses", so the redaction path has something to scrub. */
const DRY_KEY = 'dry-run-placeholder-credential-0000'
/** Sent by assertion 6; the provider must reject it. */
const INVALID_KEY = 'shuvix-probe-invalid-key-000000'

const FAUX_FAMILY: FamilyConfig = {
  id: 'faux',
  label: 'dry run (scripted faux provider)',
  api: 'faux',
  target: { kind: 'faux' },
  keyVar: 'SHUVIX_PROBE_DRY',
  modelVar: '-',
  key: DRY_KEY,
  model: 'faux-probe'
}

const ALL_FAMILIES = resolveFamilies(ENV)
const FAMILIES: FamilyConfig[] = DRY ? [FAUX_FAMILY] : ALL_FAMILIES
const SECRETS = [...secretsOf([...ALL_FAMILIES, FAUX_FAMILY]), INVALID_KEY]

/** Custom providers are addressed by their row id (a uuid in production). */
const CUSTOM_ROW_ID = '0194f1a2-7c3e-7d40-9b1a-5e6f70819203'
const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`

const D_TIMEOUT = 5 * 60_000
const P_TIMEOUT = 3 * 60_000
const AUTH_DEADLINE_MS = 15_000

// ─────────────────────────── fetch spy ───────────────────────────

interface SeenRequest {
  family: string
  check: string
  method: string
  url: string
  userAgent: string | undefined
  status?: number
  error?: string
}

const seenRequests: SeenRequest[] = []
const scope = { family: '-', check: '-' }

/**
 * Installed before `installLlmNetwork()`, so the LLM network layer wraps the spy and the spy sees
 * exactly what goes on the wire. Dry mode refuses every request (and the network-guard case below
 * fails the run if any was attempted).
 */
const realFetch = globalThis.fetch
globalThis.fetch = async function probeFetchSpy(
  input: Parameters<typeof realFetch>[0],
  init?: Parameters<typeof realFetch>[1]
): ReturnType<typeof realFetch> {
  const request = input instanceof Request ? input : undefined
  const url = new URL(request?.url ?? String(input))
  const headers = new Headers(init?.headers ?? request?.headers)
  const seen: SeenRequest = {
    family: scope.family,
    check: scope.check,
    method: init?.method ?? request?.method ?? 'GET',
    url: `${url.origin}${url.pathname}`,
    userAgent: headers.get('user-agent') ?? undefined
  }
  seenRequests.push(seen)
  if (DRY) {
    seen.error = 'blocked (dry mode)'
    throw new Error(`dry mode: network request to ${url.origin} blocked`)
  }
  try {
    const response = await realFetch(input, init)
    seen.status = response.status
    return response
  } catch (error) {
    seen.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}
installLlmNetwork()

// ─────────────────────────── report ───────────────────────────

type Status = 'PASS' | 'FAIL' | 'WARN' | 'INFO' | 'N/A' | 'SKIP'

interface CheckResult {
  id: string
  name: string
  status: Status
  detail: string
}

interface FamilyReport {
  family: FamilyConfig
  model?: string
  api?: string
  priced?: boolean
  note?: string
  checks: CheckResult[]
}

const reports = new Map<string, FamilyReport>()
let spentUsd = 0
let budgetStoppedAt: string | undefined

function reportOf(family: FamilyConfig): FamilyReport {
  let report = reports.get(family.id)
  if (!report) {
    report = { family, checks: [] }
    reports.set(family.id, report)
  }
  return report
}

function record(family: FamilyConfig, result: CheckResult): CheckResult {
  const checks = reportOf(family).checks
  const index = checks.findIndex((check) => check.id === result.id)
  if (index >= 0) checks[index] = result
  else checks.push(result)
  console.log(`[${family.id}] ${result.id} ${result.name}: ${result.status} — ${result.detail}`)
  return result
}

/** Record, then fail the vitest case when the result is FAIL. */
function settle(family: FamilyConfig, result: CheckResult): void {
  record(family, result)
  expect(result.status, `${family.id} · ${result.id} ${result.name}: ${result.detail}`).not.toBe(
    'FAIL'
  )
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

function renderReport(): string {
  const lines: string[] = []
  lines.push('# ShuviX protocol probe')
  lines.push('')
  lines.push(
    `${new Date().toISOString()} · mode **${DRY ? 'dry' : 'live'}** · node ${process.version} · ${platform()} ${release()} ${arch()}`
  )
  lines.push(
    `Budget: $${spentUsd.toFixed(4)} spent of $${OPTIONS.maxUsd} (soft cap)${
      budgetStoppedAt ? ` — exceeded, remaining checks skipped from ${budgetStoppedAt}` : ''
    }`
  )
  const settings = createShuviXSettings()
  lines.push(
    `Settings: createShuviXSettings().stream = ${JSON.stringify(settings.stream)}, retry = ${JSON.stringify(settings.retry)}`
  )
  lines.push(`Expected pi User-Agent: \`${PI_USER_AGENT}\``)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  lines.push(`| family | model | ${ids.join(' | ')} |`)
  lines.push(`|---|---|${ids.map(() => '---').join('|')}|`)
  for (const family of DRY ? [FAUX_FAMILY, ...ALL_FAMILIES] : ALL_FAMILIES) {
    const report = reports.get(family.id)
    if (!report || report.checks.length === 0) {
      const why = !report
        ? DRY && family.id !== 'faux'
          ? 'skipped (dry mode)'
          : family.configError
            ? `config error: ${family.configError}`
            : `skipped (no ${family.keyVar})`
        : (report.note ?? 'no checks ran')
      lines.push(`| ${cell(family.label)} | ${cell(why)} | ${ids.map(() => '').join(' | ')} |`)
      continue
    }
    const statusOf = (id: string): string =>
      report.checks.find((check) => check.id === id)?.status ?? ''
    lines.push(
      `| ${cell(family.label)} | ${cell(report.model ?? '?')} | ${ids.map(statusOf).join(' | ')} |`
    )
  }
  const blocking = [...reports.values()].flatMap((report) =>
    report.checks
      .filter((check) => check.status === 'FAIL')
      .map((check) => `${report.family.id} ${check.id}`)
  )
  lines.push('')
  lines.push(
    blocking.length === 0
      ? 'No FAIL results.'
      : `**FAIL:** ${blocking.join(', ')} (see Q-P4-10 for which ones block the release).`
  )
  for (const report of reports.values()) {
    lines.push('')
    lines.push(`## ${report.family.label}`)
    lines.push('')
    lines.push(
      `Model: \`${report.model ?? '?'}\` · api ${report.api ?? '?'} · ${
        report.priced ? 'priced' : 'unpriced'
      } · env: ${familyEnvVars(report.family).join(', ')}`
    )
    if (report.note) lines.push(`Note: ${report.note}`)
    lines.push('')
    for (const check of [...report.checks].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`- **[${check.status}]** ${check.id} ${check.name}: ${check.detail}`)
    }
  }
  lines.push('')
  lines.push('## Requests seen by the fetch spy')
  lines.push('')
  if (seenRequests.length === 0) {
    lines.push(DRY ? 'None (dry mode: the network was never touched).' : 'None.')
  } else {
    lines.push('| family | check | method | url | user-agent | status |')
    lines.push('|---|---|---|---|---|---|')
    for (const seen of seenRequests) {
      lines.push(
        `| ${seen.family} | ${seen.check} | ${seen.method} | ${cell(seen.url)} | ${cell(
          seen.userAgent ?? '(none)'
        )} | ${seen.status ?? cell(seen.error ?? '')} |`
      )
    }
  }
  return redact(lines.join('\n') + '\n', SECRETS)
}

// ─────────────────────────── model layer ───────────────────────────

/** The registry's ambient auth: no env var, no file — keys come from the port only. */
const SEALED_AUTH: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false
}

interface TapRequest {
  check: string
  timeoutMs: unknown
  maxRetries: unknown
  reasoning: unknown
}

interface TapUsage {
  check: string
  usage: Usage
}

interface Tap {
  requests: TapRequest[]
  usage: TapUsage[]
}

/**
 * `review.probe.ts`'s `tapModels`: a proxy over the registry's `Models` that records the options
 * of every generation request (assertion 7) and the usage of every result (assertion 2, budget).
 */
function tapModels(models: Models, tap: Tap): Models {
  return new Proxy(models, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if ((key !== 'stream' && key !== 'streamSimple') || typeof value !== 'function') return value
      return (model: unknown, context: unknown, options?: Record<string, unknown>) => {
        const check = scope.check
        tap.requests.push({
          check,
          timeoutMs: options?.timeoutMs,
          maxRetries: options?.maxRetries,
          reasoning: options?.reasoning
        })
        const stream = (value as (...args: unknown[]) => AssistantMessageEventStream).call(
          target,
          model,
          context,
          options
        )
        void stream.result().then(
          (message) => {
            tap.usage.push({ check, usage: message.usage })
            spentUsd += message.usage?.cost?.total ?? 0
          },
          () => {}
        )
        return stream
      }
    }
  })
}

/** Provider rows for one family (keys live here and nowhere else). */
function portFor(
  family: FamilyConfig,
  key: string,
  modelRows: ProviderModelRow[]
): ProviderCredentialPort {
  const target = family.target
  const row: ProviderRow =
    target.kind === 'custom'
      ? {
          id: CUSTOM_ROW_ID,
          name: 'Probe custom endpoint',
          isBuiltin: false,
          isEnabled: true,
          apiKey: key,
          baseUrl: target.baseUrl,
          apiProtocol: target.protocol,
          metadata: JSON.stringify(target.headers ? { customHeaders: target.headers } : {})
        }
      : {
          id: target.kind === 'builtin' ? target.slug : 'faux',
          name: target.kind === 'builtin' ? target.slug : 'faux',
          isBuiltin: true,
          isEnabled: true,
          apiKey: key,
          baseUrl: '',
          apiProtocol: '',
          metadata: '{}'
        }
  return {
    listProviders: () => [row],
    listModels: () => modelRows,
    readOAuth: () => undefined,
    saveOAuth: () => {},
    clearOAuth: () => {}
  }
}

const rowIdOf = (family: FamilyConfig): string =>
  family.target.kind === 'custom'
    ? CUSTOM_ROW_ID
    : family.target.kind === 'builtin'
      ? family.target.slug
      : 'faux'

// ─────────────────────────── dry mode: scripted faux ───────────────────────────

const FAUX_MODEL_ID = 'faux-probe'
/** $/Mtok like a small catalog model, so the cost and budget paths see non-zero numbers. */
const FAUX_COST = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }

const LONG_TEXT = Array.from(
  { length: 160 },
  (_, i) => `Line ${i + 1}: the lighthouse keeper climbed the stairs again.`
).join(' ')

function lastNonSystem(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== 'system') return messages[index]
  }
  return undefined
}

function textOf(message: Message | undefined): string {
  if (!message || message.role === 'system') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/**
 * The scripted model of the dry run: it reads the request and answers the way a cooperative real
 * model would (tool call → echo the result, long story for the abort case, colour for the image).
 */
const fauxBrain: FauxResponseFactory = (context) => {
  const last = lastNonSystem(context.messages)
  if (last?.role === 'toolResult') {
    return fauxAssistantMessage([fauxThinking('The tool answered.'), fauxText(textOf(last))])
  }
  const text = textOf(last)
  if (text.includes('probe_lookup')) {
    return fauxAssistantMessage(
      [
        fauxThinking('I should call the lookup tool.'),
        fauxToolCall('probe_lookup', { key: 'alpha' }, { id: `call_${Date.now().toString(36)}` })
      ],
      { stopReason: 'toolUse' }
    )
  }
  if (text.includes('lighthouse')) return fauxAssistantMessage([fauxText(LONG_TEXT)])
  if (last?.role === 'user' && Array.isArray(last.content)) {
    if (last.content.some((part) => part.type === 'image')) {
      return fauxAssistantMessage([fauxText('Red')])
    }
  }
  if (text.includes('Count from 1 to 20')) {
    return fauxAssistantMessage([
      fauxText(Array.from({ length: 20 }, (_, i) => String(i + 1)).join(' '))
    ])
  }
  return fauxAssistantMessage([fauxThinking('Short answer.'), fauxText('OK, DONE.')])
}

/** The provider rejecting the key, as a real one would. */
const fauxAuthFailure: FauxResponseFactory = () =>
  fauxAssistantMessage([], {
    stopReason: 'error',
    errorMessage:
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
  })

/** Stamp a price on faux results (faux itself reports cost 0). */
function stampCost(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  if (!message.usage) return message
  return { ...message, usage: { ...message.usage, cost: calculateCost(model, message.usage) } }
}

function pricedFaux(base: Provider): Provider {
  const wrap = (model: Model<Api>, inner: AssistantMessageEventStream) => {
    const outer = createAssistantMessageEventStream()
    void (async () => {
      for await (const event of inner) {
        const stamped: Record<string, unknown> = { ...event }
        for (const key of ['partial', 'message', 'error'] as const) {
          const value = stamped[key] as AssistantMessage | undefined
          if (value && typeof value === 'object') stamped[key] = stampCost(value, model)
        }
        outer.push(stamped as unknown as AssistantMessageEvent)
      }
      outer.end(stampCost(await inner.result(), model))
    })()
    return outer
  }
  return {
    id: base.id,
    name: base.name,
    auth: base.auth,
    getModels: () => base.getModels(),
    stream: (model, context, options) => wrap(model, base.stream(model, context, options)),
    streamSimple: (model, context, options) =>
      wrap(model, base.streamSimple(model, context, options))
  }
}

function makeFaux(brain: FauxResponseFactory): FauxProviderHandle {
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      {
        id: FAUX_MODEL_ID,
        reasoning: true,
        input: ['text', 'image'],
        cost: FAUX_COST,
        contextWindow: 128_000,
        maxTokens: 8192
      }
    ],
    // Slow enough that the abort case sees committed partials (durable throttles them at 100 ms).
    tokensPerSecond: 400
  })
  faux.appendResponses(Array.from({ length: 200 }, () => brain))
  return faux
}

// ─────────────────────────── the rig ───────────────────────────

const probeLogger: RuntimeLogger = {
  info: () => {},
  warn: (message) => console.warn(redact(message, SECRETS)),
  error: (message) => console.error(redact(message, SECRETS))
}

const PROFILE = {
  name: 'protocol-probe',
  displayName: 'Protocol probe',
  description: '',
  tools: [],
  systemPrompt:
    'You are a protocol test harness. Follow the instructions exactly and keep every reply short.'
}

interface Rig {
  registry: ModelRegistry
  models: Models
  model: Model<Api>
  selection: ModelSelection
  thinkingLevel: ThinkingLevel
  host: SessionHost
  tap: Tap
  /** The nonce the probe tool returned last (assertion 3). */
  nonce: { value: string | undefined; calls: number }
}

function probeTool(nonce: Rig['nonce']): ToolRegistration {
  return defineTool({
    name: 'probe_lookup',
    description: 'Look up the value stored under a key. Always call this when asked to look up.',
    parameters: Type.Object({ key: Type.String({ description: 'The key to look up' }) }),
    execute: async () => {
      nonce.calls++
      nonce.value = `PX-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      return { content: [{ type: 'text', text: nonce.value }] }
    }
  })
}

async function buildRig(family: FamilyConfig, key: string, brain?: FauxResponseFactory): Promise<Rig> {
  const modelRows: ProviderModelRow[] = []
  const port = portFor(family, key, modelRows)
  const registry = createModelRegistry({ port, network: llmNetwork, authContext: SEALED_AUTH })

  let model: Model<Api> | undefined
  if (family.target.kind === 'faux') {
    registry.mutable.setProvider(pricedFaux(makeFaux(brain ?? fauxBrain).provider))
    model = registry.models.getModel('faux', FAUX_MODEL_ID)
  } else {
    const providerId = family.target.kind === 'builtin' ? family.target.slug : CUSTOM_ROW_ID
    const capabilities = family.target.kind === 'custom' ? { vision: family.target.vision } : {}
    const modelId =
      family.model ?? pickDefaultModel(registry.models.getModels(providerId), family.api)?.id
    if (!modelId) throw new Error(`${family.id}: no ${family.api} model in the catalog; set ${family.modelVar}`)
    modelRows.push({
      providerId: rowIdOf(family),
      modelId,
      isEnabled: true,
      capabilities: JSON.stringify(capabilities)
    })
    await registry.refresh()
    model = registry.models.getModel(providerId, modelId)
  }
  if (!model) throw new Error(`${family.id}: model not found in the registry`)

  const tap: Tap = { requests: [], usage: [] }
  const models = tapModels(registry.models, tap)
  const nonce: Rig['nonce'] = { value: undefined, calls: 0 }
  const tool = probeTool(nonce)
  const toolHost: ToolHost = {
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false, tools: [tool] }),
    rebuildAgentTools: () => ({ tools: [tool] })
  }
  const selection: ModelSelection = { provider: rowIdOf(family), modelId: model.id }
  const thinkingLevel: ThinkingLevel = model.reasoning ? 'low' : 'off'
  const storages = new Map<string, MemoryStorage>()
  const host = createSessionHost({
    models,
    modelCatalog: { registry: { models, modelRefOf: registry.modelRefOf }, port },
    toolHost,
    resolveAgentConfig: (): AgentConfig => ({ profile: PROFILE, model: selection, thinkingLevel }),
    openStorage: async (sessionId) => {
      let storage = storages.get(sessionId)
      if (!storage) {
        storage = new MemoryStorage()
        storages.set(sessionId, storage)
      }
      return storage
    },
    storageExists: (sessionId) => storages.has(sessionId),
    deleteStorage: async (sessionId) => {
      storages.delete(sessionId)
    },
    isEphemeral: () => true,
    eventSink: { broadcast: () => {}, hasUserInputCapability: () => false },
    logger: probeLogger
  })
  return { registry, models, model, selection, thinkingLevel, host, tap, nonce }
}

// ─────────────────────────── helpers ───────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function allEntries(session: DurableSession): Promise<EntryRecord[]> {
  const conversation = await session.currentConversation()
  const page = await conversation.entries({}, 1000, undefined, BG)
  return [...page.items].reverse()
}

const assistantOf = (entry: EntryRecord): AssistantMessage | undefined => {
  const message = entry.model?.[0]
  return entry.kind === AssistantEntry.kind && message?.role === 'assistant' ? message : undefined
}

const assistantText = (message: AssistantMessage | undefined): string =>
  (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('')

async function lastAssistant(session: DurableSession): Promise<AssistantMessage | undefined> {
  const entries = await allEntries(session)
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = assistantOf(entries[index]!)
    if (message) return message
  }
  return undefined
}

/** Polls `pi.live` in the background: was a retry ever scheduled, was a partial committed. */
function sampleLive(session: DurableSession, conversationId: ConversationId) {
  const seen = { retry: undefined as string | undefined, partial: false }
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        const live = await session.harness.snapshot(LiveDoc, conversationId, BG)
        if (live?.generation?.retry) seen.retry = live.generation.retry.error
        const partial = live?.generation?.message as { content?: unknown[] } | undefined
        if (Array.isArray(partial?.content) && partial.content.length > 0) seen.partial = true
      } catch {
        return
      }
      await sleep(25)
    }
  })()
  return {
    seen,
    stop: async (): Promise<void> => {
      running = false
      await loop
    }
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(25)
  }
  return check()
}

function sumUsage(list: readonly TapUsage[]): { input: number; output: number; cost: number } {
  return list.reduce(
    (sum, { usage }) => ({
      input: sum.input + (usage?.input ?? 0),
      output: sum.output + (usage?.output ?? 0),
      cost: sum.cost + (usage?.cost?.total ?? 0)
    }),
    { input: 0, output: 0, cost: 0 }
  )
}

const usageLine = (usage: Usage | undefined): string =>
  usage
    ? `input ${usage.input}, output ${usage.output}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite}${
        usage.reasoning === undefined ? '' : `, reasoning ${usage.reasoning}`
      }, cost $${(usage.cost?.total ?? 0).toFixed(6)}`
    : 'no usage'

/** A solid-colour PNG (4×4 by default), built here so the probe needs no fixture file. */
function solidPng(rgb: [number, number, number], size = 4): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill(rgb).flat())])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

interface StreamOutcome {
  deltas: number
  firstDeltaMs?: number
  doneMs?: number
  message: AssistantMessage
}

/** One raw `streamSimple` call (P cases) with the production request options. */
async function streamOnce(rig: Rig, context: Context): Promise<StreamOutcome> {
  const started = Date.now()
  const stream = rig.models.streamSimple(rig.model, context, {
    timeoutMs: SHUVIX_STREAM_OPTIONS.timeoutMs,
    maxRetries: SHUVIX_STREAM_OPTIONS.maxRetries,
    maxTokens: 1024,
    signal: AbortSignal.timeout(P_TIMEOUT - 10_000)
  })
  let deltas = 0
  let firstDeltaMs: number | undefined
  let doneMs: number | undefined
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      deltas++
      firstDeltaMs ??= Date.now() - started
    }
    if (event.type === 'done' || event.type === 'error') doneMs = Date.now() - started
  }
  return { deltas, firstDeltaMs, doneMs, message: await stream.result() }
}

const userMessage = (message: UserMessage): Message => message

const isKimi = (family: FamilyConfig): boolean =>
  family.target.kind === 'builtin' && family.target.slug === 'kimi-coding'

const KIMI_HINT =
  'Kimi rejected the request (403 / unsupported client). Known fix P4-07: restore the User-Agent override as `model.headers` in agent-runtime `models/catalog.ts` for the kimi-coding overlay, without mutating the shared catalog object (report appendix B-3).'

const looksLikeKimiRejection = (text: string | undefined): boolean =>
  text !== undefined && /\b403\b|unsupported client|not supported|only available for/i.test(text)

/** Skip the rest of the run once the soft budget is spent. */
function guardBudget(ctx: TestContext, family: FamilyConfig, id: string, name: string): void {
  if (spentUsd < OPTIONS.maxUsd) return
  budgetStoppedAt ??= `${family.id} ${id}`
  record(family, {
    id,
    name,
    status: 'SKIP',
    detail: `budget: $${spentUsd.toFixed(4)} ≥ $${OPTIONS.maxUsd}`
  })
  ctx.skip()
}

// ─────────────────────────── the families ───────────────────────────

for (const family of FAMILIES) {
  describe.skipIf(!familyRunnable(family))(`protocol probe · ${family.label}`, () => {
    let rig: Rig | undefined
    let toolSession: DurableSession | undefined
    let streamResult: StreamOutcome | undefined
    let setupError: string | undefined
    /** Requests of check 6's own rig (invalid key), for check 7 */
    const r6requests: TapRequest[] = []

    const begin = (ctx: TestContext, id: string, name: string): Rig => {
      scope.family = family.id
      scope.check = id
      guardBudget(ctx, family, id, name)
      if (!rig) {
        record(family, { id, name, status: 'FAIL', detail: `setup failed: ${setupError}` })
        throw new Error(`${family.id}: setup failed: ${setupError}`)
      }
      return rig
    }

    beforeAll(async () => {
      scope.family = family.id
      scope.check = 'setup'
      const report = reportOf(family)
      try {
        rig = await buildRig(family, family.key ?? '')
        report.model = `${rig.model.provider === CUSTOM_ROW_ID ? 'custom' : rig.model.provider}/${rig.model.id}`
        report.api = rig.model.api
        report.priced = modelIsPriced(rig.model)
      } catch (error) {
        setupError = redact(error instanceof Error ? error.message : String(error), SECRETS)
        report.note = `setup failed: ${setupError}`
      }
    })

    afterAll(async () => {
      await rig?.host.closeAll()
    })

    it(
      '1 streaming (P)',
      async (ctx) => {
        const r = begin(ctx, '1', 'streaming (P)')
        const outcome = await streamOnce(r, {
          systemPrompt: PROFILE.systemPrompt,
          messages: [
            userMessage({
              role: 'user',
              content: 'Count from 1 to 20, separated by spaces. Nothing else.',
              timestamp: Date.now()
            })
          ]
        })
        streamResult = outcome
        const text = assistantText(outcome.message)
        const error = outcome.message.errorMessage
        const ok =
          outcome.deltas >= 3 &&
          outcome.firstDeltaMs !== undefined &&
          outcome.doneMs !== undefined &&
          outcome.firstDeltaMs <= outcome.doneMs &&
          text.trim() !== '' &&
          outcome.message.stopReason === 'stop'
        const detail = `${outcome.deltas} text deltas, first at ${outcome.firstDeltaMs ?? '-'} ms, end at ${
          outcome.doneMs ?? '-'
        } ms, stopReason ${outcome.message.stopReason}${error ? `, error: ${clip(error)}` : ''}, text "${clip(text, 80)}"`
        settle(family, {
          id: '1',
          name: 'streaming (P)',
          status: ok ? 'PASS' : 'FAIL',
          detail: isKimi(family) && looksLikeKimiRejection(error) ? `${detail}. ${KIMI_HINT}` : detail
        })
      },
      P_TIMEOUT
    )

    it(
      '3 tool round trip + UI projection (D)',
      async (ctx) => {
        const r = begin(ctx, '3', 'tool round trip (D)')
        const session = await r.host.open('probe-tools')
        const result = await session.submitUser(
          'Call the probe_lookup tool with key "alpha". Then reply with only the exact value the tool returned.'
        )
        const entries = await allEntries(session)
        const calls = entries.flatMap((entry) =>
          (assistantOf(entry)?.content ?? []).filter(
            (part): part is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> =>
              part.type === 'toolCall' && part.name === 'probe_lookup'
          )
        )
        const call = calls[0]
        const resultEntry = entries.find((entry) => {
          const message = entry.model?.[0]
          return (
            entry.kind === ToolResultEntry.kind &&
            message?.role === 'toolResult' &&
            message.toolCallId === call?.id
          )
        })
        const final = await lastAssistant(session)
        const finalText = assistantText(final)
        const nonce = r.nonce.value

        // The UI path: the same projection the renderer gets.
        const conversation = await session.currentConversation()
        const state = await conversation.viewState(BG)
        let block: AssistantToolBlock | undefined
        try {
          const { entries: live, docs } = state.value
          const display = await resolveDisplayItems(session.harness, conversation.id, live)
          const view = projectSessionView(
            { sessionId: session.sessionId, conversationId: conversation.id },
            live,
            docs['pi.live'] as LiveState | undefined,
            docs['pi.inbox'] as InboxState | undefined,
            display,
            [],
            session.runState
          )
          block = view.messages
            .flatMap((message) => (message.role === 'assistant' ? message.blocks : []))
            .find(
              (candidate): candidate is AssistantToolBlock =>
                candidate.type === 'tool' && candidate.toolCallId === call?.id
            )
        } finally {
          state.dispose()
        }

        const problems: string[] = []
        if (result.error) problems.push(`submit: ${result.error}`)
        if (!call) problems.push('no probe_lookup toolCall in a pi.assistant entry')
        else if (typeof call.arguments?.key !== 'string') problems.push('args.key not parsed')
        if (!resultEntry) problems.push('no pi.tool-result entry for the call')
        if (!nonce) problems.push('the tool never ran')
        else if (!finalText.includes(nonce)) problems.push('final answer lacks the nonce')
        if (final?.stopReason !== 'stop') {
          problems.push(
            `final stopReason ${final?.stopReason}${final?.errorMessage ? ` (${clip(final.errorMessage)})` : ''}`
          )
        }
        if (!block) problems.push('projection has no tool block for the call')
        else if (block.isError || !nonce || !block.result?.includes(nonce)) {
          problems.push('projected tool block lacks the result')
        }
        if (problems.length === 0) toolSession = session
        settle(family, {
          id: '3',
          name: 'tool round trip + UI projection (D)',
          status: problems.length === 0 ? 'PASS' : 'FAIL',
          detail:
            problems.length === 0
              ? `toolCall id \`${call!.id}\` (${call!.id.length} chars), args ${JSON.stringify(call!.arguments)}, result entry ok, answer "${clip(finalText, 60)}", projected block ok`
              : problems.join('; ')
        })
      },
      D_TIMEOUT
    )

    it(
      '2 usage and cost (P, D)',
      async (ctx) => {
        const r = begin(ctx, '2', 'usage and cost (P, D)')
        const priced = modelIsPriced(r.model)
        const parts: string[] = []
        let status: Status = 'PASS'
        const p = streamResult?.message.usage
        if (!p) {
          status = 'FAIL'
          parts.push('P: no streaming result (check 1)')
        } else {
          parts.push(`P: ${usageLine(p)}`)
          if (!(p.input > 0 && p.output > 0)) status = 'FAIL'
          if (priced && !(p.cost.total > 0)) status = 'FAIL'
        }
        if (!toolSession) {
          if (status !== 'FAIL') status = 'WARN'
          parts.push('D: skipped (check 3 failed)')
        } else {
          const conversation = await toolSession.currentConversation()
          const bucketKey = `${r.model.provider}/${r.model.id}`
          const doc = await toolSession.harness.snapshot(UsageDoc, conversation.id, BG)
          const bucket = doc?.models[bucketKey] as Usage | undefined
          const total = (await toolSession.harness.usage(BG)).models[bucketKey] as Usage | undefined
          const tapped = sumUsage(r.tap.usage.filter((entry) => entry.check === '3'))
          parts.push(`D: pi.usage[${bucketKey}] ${usageLine(bucket)}`)
          parts.push(
            `harness.usage() input ${total?.input ?? 0} / output ${total?.output ?? 0} vs tapped sum ${tapped.input} / ${tapped.output}`
          )
          if (!bucket || !(bucket.input > 0 && bucket.output > 0)) status = 'FAIL'
          if (!total || total.input < tapped.input || total.output < tapped.output) status = 'FAIL'
          if (priced && !((bucket?.cost?.total ?? 0) > 0)) status = 'FAIL'
        }
        if (!priced) {
          // Q-P4-10: missing usage / cost on an unpriced model is a non-blocking follow-up
          parts.push('model unpriced in the catalog: cost reported only')
          if (status === 'FAIL') status = 'WARN'
        }
        settle(family, {
          id: '2',
          name: 'usage and cost (P, D)',
          status,
          detail: parts.join(' · ')
        })
      },
      P_TIMEOUT
    )

    it(
      '4 thinking + replayed second turn (D)',
      async (ctx) => {
        const r = begin(ctx, '4', 'thinking + replayed second turn (D)')
        if (!r.model.reasoning) {
          record(family, {
            id: '4',
            name: 'thinking (D)',
            status: 'N/A',
            detail: 'model is not a reasoning model'
          })
          return
        }
        if (!toolSession) {
          settle(family, {
            id: '4',
            name: 'thinking + replayed second turn (D)',
            status: 'FAIL',
            detail: 'no tool-round-trip session to continue (check 3 failed)'
          })
          return
        }
        const before = await allEntries(toolSession)
        const assistants = before.map(assistantOf).filter((m): m is AssistantMessage => !!m)
        const thinkingBlocks = assistants.flatMap((m) =>
          m.content.filter((part) => part.type === 'thinking')
        )
        const signed = thinkingBlocks.filter(
          (part) => part.type === 'thinking' && (part.thinkingSignature || part.redacted)
        ).length
        const thoughtSignatures = assistants.flatMap((m) =>
          m.content.filter((part) => part.type === 'toolCall' && part.thoughtSignature)
        ).length
        const reasoningTokens = assistants.reduce((sum, m) => sum + (m.usage?.reasoning ?? 0), 0)
        const evidence =
          thinkingBlocks.length > 0
            ? `thinking blocks ${thinkingBlocks.length} (signed/encrypted ${signed})`
            : reasoningTokens > 0
              ? `no thinking block, reasoning tokens ${reasoningTokens}`
              : 'no thinking block and no reasoning tokens'

        const result = await toolSession.submitUser('Now reply with just the word DONE.')
        const final = await lastAssistant(toolSession)
        const text = assistantText(final)
        const replayOk = !result.error && final?.stopReason === 'stop' && text.trim() !== ''
        const detail = `level ${r.thinkingLevel}; ${evidence}; toolCall thoughtSignatures ${thoughtSignatures}; second turn ${
          replayOk
            ? `accepted ("${clip(text, 40)}"), ${usageLine(final?.usage)}`
            : `REJECTED: stopReason ${final?.stopReason} ${clip(final?.errorMessage ?? result.error ?? '')}`
        }`
        const status: Status = !replayOk
          ? 'FAIL'
          : thinkingBlocks.length === 0 && reasoningTokens === 0
            ? 'WARN'
            : 'PASS'
        settle(family, { id: '4', name: 'thinking + replayed second turn (D)', status, detail })
      },
      D_TIMEOUT
    )

    it(
      '5 abort, then resume (D)',
      async (ctx) => {
        const r = begin(ctx, '5', 'abort, then resume (D)')
        const session = await r.host.open('probe-abort')
        const conversation = await session.currentConversation()
        const sampler = sampleLive(session, conversation.id)
        let settled = false
        const run = session
          .submitUser(
            'Write a detailed 800-word story about a lighthouse keeper. Do not use any tools.'
          )
          .finally(() => (settled = true))
        const sawPartial = await waitUntil(() => sampler.seen.partial || settled, 120_000)
        const aborted = sawPartial && sampler.seen.partial && !settled
        if (aborted) await session.abort()
        await run
        const afterAbort = await lastAssistant(session)
        const idle = session.runState === 'idle' && !session.isBusy()
        const retry = sampler.seen.retry
        await sampler.stop()

        if (!aborted) {
          record(family, {
            id: '5',
            name: 'abort, then resume (D)',
            status: 'WARN',
            detail: `inconclusive: the run ended (stopReason ${afterAbort?.stopReason}) before a committed partial could be aborted — re-run`
          })
          return
        }
        const resumed = await session.submitUser('Reply with just OK.')
        const final = await lastAssistant(session)
        const problems: string[] = []
        if (afterAbort?.stopReason !== 'aborted') {
          problems.push(`last entry after abort has stopReason ${afterAbort?.stopReason}`)
        }
        if (!idle) problems.push(`run state after abort ${session.runState}`)
        if (retry) problems.push(`a retry was scheduled: ${clip(retry)}`)
        if (resumed.error || final?.stopReason !== 'stop' || assistantText(final).trim() === '') {
          problems.push(
            `resume failed: stopReason ${final?.stopReason} ${clip(final?.errorMessage ?? resumed.error ?? '')}`
          )
        }
        settle(family, {
          id: '5',
          name: 'abort, then resume (D)',
          status: problems.length === 0 ? 'PASS' : 'FAIL',
          detail:
            problems.length === 0
              ? `aborted after a committed partial (${assistantText(afterAbort).length} chars kept), idle, no retry; resume answered "${clip(assistantText(final), 40)}"`
              : problems.join('; ')
        })
      },
      D_TIMEOUT
    )

    it(
      '6 invalid key: error without retry within 15 s (D)',
      async (ctx) => {
        begin(ctx, '6', 'invalid key, no retry (D)')
        const bad = await buildRig(family, INVALID_KEY, fauxAuthFailure)
        try {
          const session = await bad.host.open('probe-auth')
          const conversation = await session.currentConversation()
          const sampler = sampleLive(session, conversation.id)
          const started = Date.now()
          let settled = false
          const run = session.submitUser('Reply with OK.').finally(() => (settled = true))
          await waitUntil(() => settled || sampler.seen.retry !== undefined, AUTH_DEADLINE_MS)
          const elapsed = Date.now() - started
          const retry = sampler.seen.retry
          if (!settled) await session.abort()
          await run
          await sampler.stop()
          const final = await lastAssistant(session)
          for (const request of bad.tap.requests) r6requests.push(request)
          const problems: string[] = []
          if (retry) problems.push(`retry scheduled (classified retryable): ${clip(retry)}`)
          if (!settled) problems.push(`no outcome within ${AUTH_DEADLINE_MS / 1000} s`)
          if (final?.stopReason !== 'error') problems.push(`last entry stopReason ${final?.stopReason}`)
          settle(family, {
            id: '6',
            name: 'invalid key, no retry (D)',
            status: problems.length === 0 ? 'PASS' : 'FAIL',
            detail:
              problems.length === 0
                ? `error entry after ${elapsed} ms, no retry; error: ${clip(final?.errorMessage ?? '', 200)}`
                : `${problems.join('; ')}; error: ${clip(final?.errorMessage ?? '', 200)}`
          })
        } finally {
          await bad.host.closeAll()
        }
      },
      60_000
    )

    it(
      '7 settings wiring on every request (D)',
      async (ctx) => {
        const r = begin(ctx, '7', 'settings wiring (D)')
        const settings = createShuviXSettings()
        const requests = [
          ...r.tap.requests.filter((request) => ['3', '4', '5'].includes(request.check)),
          ...r6requests
        ]
        const wrong = requests.filter(
          (request) =>
            request.timeoutMs !== SHUVIX_STREAM_OPTIONS.timeoutMs ||
            request.maxRetries !== SHUVIX_STREAM_OPTIONS.maxRetries
        )
        const problems: string[] = []
        if (settings.stream?.timeoutMs !== 600_000 || settings.stream?.maxRetries !== 0) {
          problems.push(`createShuviXSettings().stream is ${JSON.stringify(settings.stream)}`)
        }
        if (settings.retry?.maxRetries !== SHUVIX_RETRY_POLICY.maxRetries) {
          problems.push(`createShuviXSettings().retry is ${JSON.stringify(settings.retry)}`)
        }
        if (requests.length === 0) problems.push('no durable requests were tapped')
        if (wrong.length > 0) {
          problems.push(
            `${wrong.length}/${requests.length} requests without timeoutMs 600000 / maxRetries 0, e.g. ${JSON.stringify(wrong[0])}`
          )
        }
        const reasoning = [...new Set(requests.map((request) => String(request.reasoning)))]
        settle(family, {
          id: '7',
          name: 'settings wiring (D)',
          status: problems.length === 0 ? 'PASS' : 'FAIL',
          detail:
            problems.length === 0
              ? `${requests.length} durable requests, all timeoutMs 600000 / maxRetries 0 (reasoning option seen: ${reasoning.join(', ')})`
              : problems.join('; ')
        })
      },
      P_TIMEOUT
    )

    it(
      '8 User-Agent (P)',
      async (ctx) => {
        const r = begin(ctx, '8', 'User-Agent (P)')
        const requests = seenRequests.filter(
          (seen) => seen.family === family.id && seen.check === '1'
        )
        if (DRY) {
          record(family, {
            id: '8',
            name: 'User-Agent (P)',
            status: 'N/A',
            detail: `dry mode: no HTTP (${requests.length} requests reached the spy; expected live UA \`${PI_USER_AGENT}\`)`
          })
          expect(requests).toEqual([])
          return
        }
        const declared = Object.entries(r.model.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'user-agent'
        )?.[1]
        const expected = declared ?? PI_USER_AGENT
        const agents = [...new Set(requests.map((seen) => seen.userAgent ?? '(none)'))]
        const statuses = [...new Set(requests.map((seen) => seen.status ?? seen.error ?? '?'))]
        const matches = requests.length > 0 && requests.every((seen) => seen.userAgent === expected)
        const kimiRejected =
          isKimi(family) &&
          (requests.some((seen) => seen.status === 403) ||
            looksLikeKimiRejection(streamResult?.message.errorMessage))
        let status: Status = matches ? 'PASS' : 'WARN'
        let detail = `${requests.length} request(s), User-Agent ${agents.map((a) => `\`${a}\``).join(', ')} (expected \`${expected}\`${declared ? ', declared by the model' : ''}), status ${statuses.join(', ')}`
        if (isKimi(family)) {
          if (kimiRejected) {
            status = 'FAIL'
            detail = `${detail}. ${KIMI_HINT}`
          } else if (requests.some((seen) => seen.status === 200) && matches) {
            detail = `${detail} — Kimi accepts pi's User-Agent (phase-1 Q11 confirmed)`
          } else {
            status = 'FAIL'
            detail = `${detail} — no 200 from Kimi with pi's User-Agent`
          }
        }
        settle(family, { id: '8', name: 'User-Agent (P)', status, detail })
      },
      P_TIMEOUT
    )

    it(
      '9 vision (P, optional)',
      async (ctx) => {
        const r = begin(ctx, '9', 'vision (P, optional)')
        if (!r.model.input.includes('image')) {
          record(family, {
            id: '9',
            name: 'vision (P, optional)',
            status: 'N/A',
            detail: 'model takes no image input'
          })
          return
        }
        const outcome = await streamOnce(r, {
          systemPrompt: PROFILE.systemPrompt,
          messages: [
            userMessage({
              role: 'user',
              content: [
                { type: 'text', text: 'What colour is this image? Answer with one word.' },
                { type: 'image', data: solidPng([220, 20, 20]), mimeType: 'image/png' }
              ],
              timestamp: Date.now()
            })
          ]
        })
        const text = assistantText(outcome.message)
        const status: Status =
          outcome.message.stopReason !== 'stop' ? 'FAIL' : /red/i.test(text) ? 'PASS' : 'WARN'
        settle(family, {
          id: '9',
          name: 'vision (P, optional)',
          status,
          detail: `4×4 red PNG → "${clip(text, 60)}" (stopReason ${outcome.message.stopReason}${
            outcome.message.errorMessage ? `, ${clip(outcome.message.errorMessage)}` : ''
          })`
        })
      },
      P_TIMEOUT
    )
  })
}

// ─────────────────────────── network guard + report ───────────────────────────

describe('protocol probe · report', () => {
  it.runIf(DRY)('dry mode: no request left the process', () => {
    expect(seenRequests.map((seen) => `${seen.method} ${seen.url}`)).toEqual([])
  })

  it('writes the redacted report (no key substring)', () => {
    if (!DRY && FAMILIES.every((family) => !familyRunnable(family))) {
      console.log(
        'protocol probe: no family has a key. Put SHUVIX_PROBE_* keys in a file outside the repo and run\n' +
          '  SHUVIX_PROBE_ENV_FILE=<file> npm run probe:protocols'
      )
    }
    const text = renderReport()
    assertNoSecrets(text, SECRETS)
    writeFileSync(OPTIONS.out, text)
    console.log(`protocol probe report: ${OPTIONS.out}`)
  })
})
