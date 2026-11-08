/**
 * Coding probe: real models do real (small) programming tasks in ShuviX, and a hidden grader scores the result.
 * Nothing is asserted; the output is a report. It exists to answer questions such as "does handing work from
 * `work` to a `coding` sub-session help or hurt?" and "does this coding.md draft beat today's?" with numbers
 * instead of feel.
 *
 * Tasks: `coding/tasks.ts` — three sets of five tasks on two Node repos (graders and reference solutions in
 * `coding/fixtures`). `PROBE_SET=hard` (default), `easy` or `ambig`; easy and hard are at ceiling for deepseek
 * and kimi. The ambig set's requests leave out what only the user knows: a simulated user (`coding/simUser.ts`,
 * on deepseek whatever model is under test) holds those facts and answers the root's questions, plain-text
 * or ask cards, and the report adds what it cost the user (turns, questions, how many touched a fact, text to
 * read), which facts were given before the agent called it done, and which facts were given but not met.
 *
 * Arms (`PROBE_ARMS`, comma-separated, default `direct,work`):
 *   direct  the user talks to the coding agent itself: the project session's base profile is replaced by the
 *           coding md (a user-level `work.md` built from it)
 *   work    today's product: the project session runs `work`, which hands the job to a `coding` sub-session
 * `PROBE_MD_DIR` points at a folder of md drafts (`coding.md`, `work.md`, …) installed as user-level agents in
 * every arm; `direct` then builds its `work.md` from that `coding.md`. Compare drafts by running twice with
 * different `PROBE_MD_DIR` / `PROBE_OUT`.
 *
 * Other knobs: `PROBE_MODELS` (deepseek, kimi, anthropic, openai — keys from ~/.shuvix-probe.env), `PROBE_TASKS`,
 * `PROBE_RUNS` (repeats of each model × arm × task), `PROBE_LANG` (default zh), `PROBE_AUTO_REVIEW=1` (let the
 * product's reviewer answer permission asks instead of the probe), `PROBE_OUT` (report folder).
 * `PROBE_SELFCHECK=1` runs no model: it checks that every task's start state fails its grader and its reference
 * solution passes.
 *
 * Safety (see memory "probe-auto-approve-scope"): each run is a fresh isolated instance on a packaged-shaped
 * stage; a policy denies file tools and commands that touch the real home folder; permission asks are approved
 * unless they name the real home; npm / pip / browser download hosts point at an unreachable port; after the
 * runs the real ~/.shuvix and ~/.npm are listed again and any new entry is reported in real-home-check.txt.
 *
 *   npx electron-vite build
 *   PROBE_MODELS=deepseek npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { syncProbe } from '../harness/sync'
import { stagePackagedResources, type PackagedStage } from './packagedStage'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import { ENV_FILE, installPolicy, makeDebug, REAL_HOME, sendPrompt } from './redactionProbeShared'
import { SETS, TASKS, type CodingTask, type SetId } from './coding/tasks'
import { applyReference, gradeRepo, prepareRepo, type Grade } from './coding/workspace'
import { createSimUser, type SimCard, type SimTurn, type SimVerdict } from './coding/simUser'

const BUILTIN_MD = fileURLToPath(
  new URL('../../../../packages/agent-runtime/src/subagent/builtinAgents/md', import.meta.url)
)
const OUT = process.env.PROBE_OUT ?? mkdtempSync(join(tmpdir(), 'shuvix-coding-probe-'))
const LANG = process.env.PROBE_LANG ?? 'zh'
const RUNS = Number(process.env.PROBE_RUNS ?? 1)
const MD_DIR = process.env.PROBE_MD_DIR
const AUTO_REVIEW = process.env.PROBE_AUTO_REVIEW === '1'
const SELFCHECK = process.env.PROBE_SELFCHECK === '1'
const list = (v: string | undefined, d: string): string[] =>
  (v ?? d)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const MODEL_IDS = list(process.env.PROBE_MODELS, 'deepseek')
const ARMS = list(process.env.PROBE_ARMS, 'direct,work') as Arm[]
const SET = (process.env.PROBE_SET ?? 'hard') as SetId
if (!SETS[SET]) throw new Error(`PROBE_SET must be easy or hard, got ${SET}`)
const TASK_IDS = list(
  process.env.PROBE_TASKS,
  TASKS.filter((t) => t.set === SET)
    .map((t) => t.id)
    .join(',')
)
const TURN_TIMEOUT_MS = 25 * 60 * 1000

/** what the stock user says when asked (tasks without a simulated user) */
const AGREE = '可以，按你说的来。'
const DECIDE = '你自己判断，按最合理的来。'
/** at most this many simulated-user answers per run (replies and cards); past it the run is "capped" */
const MAX_SIM_CALLS = 8

type Arm = 'direct' | 'work'

// ─────────────────────────── models ───────────────────────────

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
  },
  anthropic: {
    keyEnv: 'SHUVIX_PROBE_ANTHROPIC_KEY',
    modelEnv: 'SHUVIX_PROBE_ANTHROPIC_MODEL',
    fallbackModel: 'claude-sonnet-5-5',
    providerId: 'anthropic',
    providerName: 'anthropic',
    apiProtocol: 'anthropic-messages'
  },
  openai: {
    keyEnv: 'SHUVIX_PROBE_OPENAI_KEY',
    modelEnv: 'SHUVIX_PROBE_OPENAI_MODEL',
    fallbackModel: 'gpt-5.5',
    providerId: 'openai',
    providerName: 'openai',
    apiProtocol: 'openai-responses'
  }
}

function modelOf(id: string): { spec: ModelSpec; key: string; modelId: string } {
  const spec = MODELS[id]
  if (!spec) throw new Error(`unknown model ${id} (known: ${Object.keys(MODELS).join(', ')})`)
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  const key = env[spec.keyEnv] ?? ''
  const modelId = env[spec.modelEnv] ?? spec.fallbackModel ?? ''
  if (!key || !modelId)
    throw new Error(`${spec.keyEnv} / ${spec.modelEnv} not set (env or ${ENV_FILE})`)
  return { spec, key, modelId }
}

// ─────────────────────────── safety ───────────────────────────

const UNREACHABLE = 'http://127.0.0.1:9'
const OFFLINE_ENV: Record<string, string> = {
  npm_config_cache: join(tmpdir(), 'shuvix-coding-probe-npm-cache'),
  npm_config_registry: UNREACHABLE,
  npm_config_update_notifier: 'false',
  PIP_INDEX_URL: UNREACHABLE,
  PLAYWRIGHT_DOWNLOAD_HOST: UNREACHABLE,
  PUPPETEER_DOWNLOAD_BASE_URL: UNREACHABLE
}

async function installHomeGuard(app: E2EApp): Promise<void> {
  const home = `'${REAL_HOME.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const prompt = `This environment's home folder is ${app.home}; use ~ or paths under it.`
  await installPolicy(
    app,
    'probe-home-guard',
    [
      '---',
      'shuvix: policy v1',
      'name: probe-home-guard',
      'description: A live probe never touches the real home folder of this computer.',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    object.type: [path]',
      '    action: [read, write]',
      `    match: inDir(object.path, ${home})`,
      `    prompt: ${prompt}`,
      '  - effect: deny',
      '    object.type: [command]',
      '    action: [execute]',
      `    match: object.command.contains(${home})`,
      `    prompt: ${prompt}`,
      '---',
      ''
    ].join('\n')
  )
}

const realHomeEntries = (): string[] => {
  const out: string[] = []
  for (const dir of ['.shuvix', '.shuvix/agents', '.shuvix/policies', '.npm', '.npm/_npx']) {
    const d = join(homedir(), dir)
    if (existsSync(d)) out.push(...readdirSync(d).map((n) => `${dir}/${n}`))
  }
  return out.sort()
}

// ─────────────────────────── agent md per arm ───────────────────────────

function builtinMd(name: string): string {
  const localized = join(BUILTIN_MD, `${name}.${LANG}.md`)
  return readFileSync(
    LANG !== 'en' && existsSync(localized) ? localized : join(BUILTIN_MD, `${name}.md`),
    'utf8'
  )
}

/** A builtin md turned into a user-level file under another name */
function asUserAgent(md: string, name: string): string {
  return md
    .replace(/^shuvix-builtin: true\n/m, '')
    .replace(/^shuvix-id: .*\n/m, '')
    .replace(/^name: .*$/m, `name: ${name}`)
}

function installAgents(app: E2EApp, arm: Arm): string[] {
  mkdirSync(app.agentsDir, { recursive: true })
  const written: string[] = []
  const drafts = MD_DIR ? readdirSync(MD_DIR).filter((n) => n.endsWith('.md')) : []
  for (const n of drafts) {
    writeFileSync(join(app.agentsDir, n), readFileSync(join(MD_DIR as string, n), 'utf8'))
    written.push(n)
  }
  if (arm === 'direct') {
    const coding = drafts.includes('coding.md')
      ? readFileSync(join(MD_DIR as string, 'coding.md'), 'utf8')
      : builtinMd('coding')
    writeFileSync(join(app.agentsDir, 'work.md'), asUserAgent(coding, 'work'))
    written.push('work.md (from coding)')
  }
  return written
}

// ─────────────────────────── sessions ───────────────────────────

interface SessionRow {
  id: string
  title: string
  parentId?: string
  agentProfile?: string
}

async function treeOf(app: E2EApp, rootId: string): Promise<SessionRow[]> {
  const all = await app.main.eval<SessionRow[]>(
    `window.api.session.list().then((ss) => ss.map((s) => ({ id: s.id, title: s.title, parentId: s.parentId, agentProfile: s.agentProfile })))`
  )
  const out = all.filter((s) => s.id === rootId)
  for (let i = 0; i < out.length; i++) out.push(...all.filter((s) => s.parentId === out[i].id))
  return out
}

interface Usage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}
interface Block {
  type: string
  text?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  isError?: boolean
}
interface Msg {
  role: string
  content: string
  usage?: Usage
  isNotice?: boolean
  blocks: Block[]
}

const readMessages = (app: E2EApp, sid: string): Promise<Msg[]> =>
  app.main.eval<Msg[]>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => msgs.map((m) => ({
      role: m.role,
      content: String(m.content ?? ''),
      usage: m.metadata ? m.metadata.usage : undefined,
      isNotice: Boolean(m.metadata && m.metadata.isSystemNotice),
      blocks: (m.blocks ?? []).map((b) => b.type === 'tool'
        ? { type: 'tool', toolName: b.toolName, args: b.args, result: String(b.result ?? '').slice(0, 4000), isError: b.isError === true }
        : { type: b.type, text: b.text })
    })))
  `)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    )
  ])
}

interface SettleStats {
  questions: number
  permissions: number
  refused: number
  /** choice questions from a sub-session that nobody answered when the tree went quiet */
  unansweredSubQuestions: number
}

/**
 * Wait until the whole session tree is quiet, answering on the user's behalf meanwhile: permission asks anywhere
 * in the tree (refused when they name the real home), and the root's own questions (by the simulated user when
 * the task has one). A sub-session's question is the parent agent's to answer (sub-session intervention), so it
 * is left alone.
 */
async function settleTree(
  app: E2EApp,
  events: EventRecorder,
  rootId: string,
  stats: SettleStats,
  debug: (l: string) => void,
  quietMs = 20_000,
  answerRootChoice?: (card: SimCard) => Promise<Record<string, unknown>>
): Promise<void> {
  const sync = syncProbe(app.main)
  await sync.install()
  const answered = new Set<string>()
  let last = -1
  let quietSince = Date.now()
  let pendingSub = 0
  await until(
    async () => {
      let busy = false
      pendingSub = 0
      for (const s of await treeOf(app, rootId)) {
        const view = await withTimeout(sync.viewOf(s.id), 8000).catch((e) => {
          debug(`viewOf ${s.id} failed: ${String(e)}`)
          return undefined
        })
        if (!view) {
          busy = true
          continue
        }
        if (view.run?.state === 'busy') busy = true
        for (const req of (view.asks ?? []) as Array<{
          id: string
          kind: string
          question?: string
          options?: SimCard['options']
        }>) {
          if (answered.has(req.id)) continue
          let response: Record<string, unknown>
          if (req.kind === 'choice') {
            if (s.id !== rootId) {
              pendingSub++
              continue
            }
            stats.questions++
            response = answerRootChoice
              ? await answerRootChoice({ question: req.question ?? '', options: req.options ?? [] })
              : { kind: 'other', text: DECIDE }
          } else {
            const text = JSON.stringify(req)
            const outside =
              text.includes(`${REAL_HOME}/`) && !`${app.home}/`.startsWith(`${REAL_HOME}/`)
            stats.permissions++
            if (outside) stats.refused++
            response = outside
              ? {
                  kind: 'ask',
                  allowed: false,
                  reason: `Refused. In this environment the home folder is ${app.home}.`
                }
              : { kind: 'ask', allowed: true }
          }
          debug(`answer ${s.id} ${req.kind} ${req.id} → ${JSON.stringify(response).slice(0, 120)}`)
          await app.main.eval(
            `window.api.agent.respondToInput(${JSON.stringify({ sessionId: s.id, requestId: req.id, response })})`
          )
          answered.add(req.id)
          quietSince = Date.now()
        }
      }
      const mark = await events.mark()
      if (mark !== last || busy) {
        last = mark
        quietSince = Date.now()
        return false
      }
      return Date.now() - quietSince > quietMs
    },
    'session tree went quiet',
    TURN_TIMEOUT_MS
  )
  stats.unansweredSubQuestions = pendingSub
}

const looksLikeQuestion = (reply: string): boolean =>
  /[?？]\s*$/.test(reply.trim()) ||
  /(要不要|是否需要|需要我|你同意|同意的话|确认一下|你看可以|可以吗)/.test(reply.slice(-300))

// ─────────────────────────── run analysis ───────────────────────────

interface Dispatch {
  via: string
  text: string
  chars: number
  /** the user's message appears verbatim (whitespace ignored) */
  verbatim: boolean
  mentionsRootCause: string[]
  mentionsDecoy: string[]
}

interface UserRound {
  via: 'reply' | 'card'
  /** text the root showed the user since the last answer */
  agentChars: number
  /** root edits and hand-offs before this round */
  workBefore: number
  verdict: SimVerdict
}

/** What the run cost the simulated user, and what came of the facts it held */
interface UserReport {
  facts: string[]
  /** facts whose grader checks all passed */
  met: string[]
  /** facts the user gave, at any point */
  given: string[]
  /** facts given before the agent first reported it was done */
  givenBeforeDone: string[]
  /** given, yet not met: lost between the user and the code */
  givenNotMet: string[]
  rounds: UserRound[]
  /** messages and card answers the user sent after the request */
  turns: number
  questions: number
  /** questions that touched a fact */
  relevant: number
  noise: number
  /** the root asked its first question before any edit or hand-off */
  askedBeforeWork: boolean
  corrections: number
  /** characters of root text the user was shown */
  readChars: number
  /** sub-session ask cards the parent answered itself instead of asking the user */
  parentAnswered: number
  capped: boolean
  simErrors: string[]
}

interface RunRecord {
  model: string
  modelId: string
  arm: Arm
  task: string
  run: number
  seconds: number
  grade: Grade
  sessions: Array<{ id: string; title: string; profile?: string; parent?: string }>
  requests: number
  tokens: Required<Usage>
  toolCalls: Record<string, number>
  rootToolCalls: number
  /** root read/search calls before its first hand-off (work arm) */
  skimBeforeDispatch: number
  rootEdits: number
  dispatches: Dispatch[]
  exploreCalls: number
  settle: SettleStats
  followUps: number
  finalReply: string
  agents: string[]
  user?: UserReport
  error?: string
}

const squash = (s: string): string => s.replace(/\s+/g, '')
const mentions = (text: string, paths: string[]): string[] =>
  paths.filter((p) => text.includes(p) || text.includes(p.split('/').at(-1) as string))

function dispatchesOf(task: CodingTask, msgs: Msg[]): Dispatch[] {
  const out: Dispatch[] = []
  for (const m of msgs) {
    for (const b of m.blocks) {
      if (b.type !== 'tool') continue
      const a = b.args ?? {}
      let text: string | undefined
      let via = ''
      if (b.toolName === 'session' && /prompt-(sub-)?session/.test(String(a.action))) {
        text = String(a.message ?? '')
        via = 'prompt-session'
      } else if (b.toolName === 'agent' && String(a.name ?? '') !== 'explore') {
        text = String(a.prompt ?? '')
        via = `agent:${String(a.name ?? '')}`
      }
      if (text === undefined) continue
      out.push({
        via,
        text,
        chars: text.length,
        verbatim: squash(text).includes(squash(task.prompt)),
        mentionsRootCause: mentions(text, task.rootCause),
        mentionsDecoy: mentions(text, task.decoys)
      })
    }
  }
  return out
}

const READS = new Set(['read', 'grep', 'glob', 'ls', 'bash', 'powershell'])

/** A root tool call that commits to the work: an edit, or handing the job to another agent */
const isWork = (b: Block): boolean =>
  b.type === 'tool' &&
  (b.toolName === 'edit' ||
    b.toolName === 'write' ||
    (b.toolName === 'session' &&
      /create-sub-session|prompt-(sub-)?session/.test(String(b.args?.action))) ||
    (b.toolName === 'agent' && String(b.args?.name ?? '') !== 'explore'))

function transcriptMd(
  label: string,
  sessions: SessionRow[],
  bySession: Map<string, Msg[]>
): string {
  const out: string[] = []
  for (const s of sessions) {
    out.push(
      `\n## ${s.parentId ? 'sub-session' : 'session'} ${s.title} (${s.agentProfile ?? 'base'}) ${s.id}\n`
    )
    const lines: string[] = []
    for (const m of bySession.get(s.id) ?? []) {
      if (m.role === 'user') {
        lines.push(`>>> USER${m.isNotice ? ' (notice)' : ''}: ${m.content}`)
        continue
      }
      if (m.role !== 'assistant') {
        lines.push(`### ${m.role}: ${m.content.slice(0, 2000)}`)
        continue
      }
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text?.trim()) lines.push(`<<< ASSISTANT:\n${b.text}`)
        if (b.type !== 'tool') continue
        const args = JSON.stringify(b.args ?? {})
        lines.push(`[TOOL] ${b.toolName} ${args.length > 4000 ? `${args.slice(0, 4000)}…` : args}`)
        const r = b.result ?? ''
        lines.push(
          `[RESULT]${b.isError ? ' (ERROR)' : ''} ${r.length > 1500 ? `${r.slice(0, 1500)}…` : r}`
        )
      }
    }
    out.push('```text', lines.join('\n\n'), '```')
  }
  return `# ${label}\n${out.join('\n')}\n`
}

/** The answer the parent gives in a sub-session's place starts with this (askTool.ts PARENT_ANSWERED) */
const PARENT_ANSWERED = 'the session that assigned you this task answered on their behalf'

function userReport(
  facts: string[],
  grade: Grade,
  rounds: UserRound[],
  subMessages: Msg[],
  capped: boolean,
  simErrors: string[]
): UserReport {
  const met = facts.filter((id) => {
    const checks = grade.checks.filter((c) => c.fact === id)
    return checks.length > 0 && checks.every((c) => c.pass)
  })
  const given = [...new Set(rounds.flatMap((r) => r.verdict.disclosed))].sort()
  const beforeDone = new Set<string>()
  let doneSeen = false
  for (const r of rounds) {
    if (r.verdict.kind === 'completion' || r.verdict.kind === 'mixed') doneSeen = true
    if (!doneSeen) for (const f of r.verdict.disclosed) beforeDone.add(f)
  }
  const questions = rounds.flatMap((r) => r.verdict.questions)
  const firstAsk = rounds.find((r) => r.verdict.questions.length > 0)
  return {
    facts,
    met,
    given,
    givenBeforeDone: [...beforeDone].sort(),
    givenNotMet: given.filter((f) => !met.includes(f)),
    rounds,
    turns: rounds.filter((r) => r.via === 'card' || (!r.verdict.done && r.verdict.reply)).length,
    questions: questions.length,
    relevant: questions.filter((q) => q.facts.length > 0).length,
    noise: questions.filter((q) => q.facts.length === 0).length,
    askedBeforeWork: firstAsk !== undefined && firstAsk.workBefore === 0,
    corrections: rounds.filter((r) => r.verdict.correction).length,
    readChars: rounds.reduce((t, r) => t + r.agentChars, 0),
    parentAnswered: subMessages
      .flatMap((m) => m.blocks)
      .filter(
        (b) =>
          b.type === 'tool' && b.toolName === 'ask' && (b.result ?? '').includes(PARENT_ANSWERED)
      ).length,
    capped,
    simErrors
  }
}

// ─────────────────────────── report ───────────────────────────

const records: RunRecord[] = []
let stage: PackagedStage | undefined
let realBefore: string[] = []

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function renderSummary(): string {
  const lines = [
    `# Coding probe: ${SET} set (${LANG}${MD_DIR ? `, drafts from ${MD_DIR}` : ''}${AUTO_REVIEW ? ', auto-review on' : ''})`,
    ''
  ]
  // aggregate per model × arm
  lines.push(
    '| model | arm | runs | pass | core checks | visible tests | tokens in (mean) | out (mean) | requests (mean) | seconds (mean) |'
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const groups = new Map<string, RunRecord[]>()
  for (const r of records)
    groups.set(`${r.model}|${r.arm}`, [...(groups.get(`${r.model}|${r.arm}`) ?? []), r])
  for (const [key, rs] of groups) {
    const [model, arm] = key.split('|')
    const sum = (f: (r: RunRecord) => number): number => rs.reduce((t, r) => t + f(r), 0)
    const mean = (f: (r: RunRecord) => number): number => Math.round(sum(f) / rs.length)
    lines.push(
      `| ${model} | ${arm} | ${rs.length} | ${rs.filter((r) => r.grade.pass).length}/${rs.length} | ` +
        `${sum((r) => r.grade.core.passed)}/${sum((r) => r.grade.core.total)} | ` +
        `${sum((r) => r.grade.visible.pass)}/${sum((r) => r.grade.visible.pass + r.grade.visible.fail)} | ` +
        `${k(mean((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite))} | ${k(mean((r) => r.tokens.output))} | ` +
        `${mean((r) => r.requests)} | ${mean((r) => r.seconds)} |`
    )
  }
  lines.push(...userSummary())
  lines.push('', '## Runs', '')
  lines.push(
    '| model | arm | task | # | pass | core | extra | visible | tampered | tests added | changed (+/−) | in / out tokens | req | s | calls | hand-offs | skim | verbatim | decoy mentioned | root cause mentioned | asks |'
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of records) {
    const g = r.grade
    const add = g.diff.files.reduce((t, f) => t + f.added, 0)
    const rm = g.diff.files.reduce((t, f) => t + f.removed, 0)
    const tamper = [...g.tampered.tests, g.tampered.testScript ? 'test script' : '']
      .filter(Boolean)
      .join(', ')
    const d = r.dispatches
    const added =
      g.testsExtended.length +
      [...g.diff.files.map((f) => f.path), ...g.diff.untracked].filter(
        (p) =>
          /(^|\/)test\//.test(p) && !g.testsExtended.includes(p) && !g.tampered.tests.includes(p)
      ).length
    lines.push(
      `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${g.pass ? '✅' : '❌'}${r.error ? ' ⚠️' : ''} | ${g.core.passed}/${g.core.total} | ` +
        `${g.extra.passed}/${g.extra.total} | ${g.visible.pass}/${g.visible.pass + g.visible.fail} | ${tamper || '—'} | ${added ? `${added} file(s)` : '—'} | ` +
        `${g.diff.files.length + g.diff.untracked.length} (+${add}/−${rm}) | ` +
        `${k(r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite)} / ${k(r.tokens.output)} | ${r.requests} | ${r.seconds} | ` +
        `${Object.values(r.toolCalls).reduce((t, n) => t + n, 0)} | ${d.length ? d.map((x) => `${x.chars}ch`).join(' ') : '—'} | ` +
        `${r.arm === 'work' ? r.skimBeforeDispatch : '—'} | ${d.length ? d.map((x) => (x.verbatim ? 'yes' : 'no')).join(' ') : '—'} | ` +
        `${[...new Set(d.flatMap((x) => x.mentionsDecoy))].join(', ') || '—'} | ${[...new Set(d.flatMap((x) => x.mentionsRootCause))].join(', ') || '—'} | ` +
        `${r.settle.permissions}p ${r.settle.questions}q${r.settle.unansweredSubQuestions ? ` ${r.settle.unansweredSubQuestions} stuck` : ''} |`
    )
  }
  for (const r of records) {
    lines.push('', `### ${r.model} / ${r.arm} / ${r.task} / #${r.run}`, '')
    if (r.error) lines.push(`Error: ${r.error}`, '')
    for (const c of r.grade.checks) {
      lines.push(
        `- ${c.pass ? '✅' : '❌'}${c.core ? '' : ' (extra)'} ${c.name}${c.error ? ` — ${c.error.replace(/\n/g, ' ')}` : ''}`
      )
    }
    if (r.grade.graderError) lines.push(`- grader failed: ${r.grade.graderError}`)
    if (r.grade.visible.output)
      lines.push('', '```text', r.grade.visible.output.slice(-1200), '```')
    lines.push(
      '',
      `Changed: ${[...r.grade.diff.files.map((f) => `${f.path} (+${f.added}/−${f.removed})`), ...r.grade.diff.untracked.map((u) => `${u} (new)`)].join(', ') || 'nothing'}`,
      `Sessions: ${r.sessions.map((s) => `${s.profile ?? 'base'}${s.parent ? ' (sub)' : ''}`).join(', ')}; tools: ${Object.entries(
        r.toolCalls
      )
        .map(([n, c]) => `${n}×${c}`)
        .join(' ')}; explore: ${r.exploreCalls}; follow-ups: ${r.followUps}`,
      `Agents: ${r.agents.join('; ') || 'builtin'}`
    )
    for (const [i, d] of r.dispatches.entries()) {
      lines.push(
        '',
        `Hand-off ${i + 1} (${d.via}, ${d.chars} chars):`,
        '',
        '```text',
        d.text,
        '```'
      )
    }
    if (r.user) {
      lines.push('', 'With the simulated user:', '')
      for (const [i, u] of r.user.rounds.entries()) {
        const v = u.verdict
        const qs = v.questions.map((q) => `${q.text} [${q.facts.join(',') || '—'}]`).join('; ')
        lines.push(
          `${i + 1}. ${u.via}, ${v.kind}, ${u.agentChars} chars shown, ${u.workBefore} edits/hand-offs before` +
            `${qs ? ` — asked: ${qs}` : ''}` +
            `${v.disclosed.length ? ` — gave ${v.disclosed.join(',')}` : ''}${v.correction ? ' (correction)' : ''}` +
            `${v.selections.length ? ` — ticked ${v.selections.join(' / ')}` : ''}` +
            `${v.reply ? ` — "${v.reply.replace(/\n/g, ' ')}"` : ''}${v.error ? ` — ERROR ${v.error}` : ''}`
        )
      }
      if (r.user.capped) lines.push(`(stopped after ${MAX_SIM_CALLS} answers)`)
    }
    lines.push('', 'Final reply:', '', '```text', r.finalReply.slice(0, 3000), '```')
  }
  return lines.join('\n')
}

/** The ambig set's tables: what each run cost the user and what came of the facts it held */
function userSummary(): string[] {
  const rs = records.filter((r) => r.user)
  if (!rs.length) return []
  const out = [
    '',
    '## With the simulated user',
    '',
    'facts met = hidden facts whose checks all pass; given before done = facts the user gave before the agent first said it was done; ' +
      'given, not met = the user said it and the code does not do it; asked first = the first question came before any edit or hand-off; ' +
      'work answered = sub-session ask cards the parent answered itself.',
    '',
    '| model | arm | runs | pass | facts met | given before done | given, not met | user turns (mean) | questions (fact / none) | asked first | corrections | work answered | text shown (mean) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const groups = new Map<string, RunRecord[]>()
  for (const r of rs)
    groups.set(`${r.model}|${r.arm}`, [...(groups.get(`${r.model}|${r.arm}`) ?? []), r])
  for (const [key, g] of groups) {
    const [model, arm] = key.split('|')
    const u = g.map((r) => r.user as UserReport)
    const sum = (f: (x: UserReport) => number): number => u.reduce((t, x) => t + f(x), 0)
    const facts = sum((x) => x.facts.length)
    out.push(
      `| ${model} | ${arm} | ${g.length} | ${g.filter((r) => r.grade.pass).length}/${g.length} | ${sum((x) => x.met.length)}/${facts} | ` +
        `${sum((x) => x.givenBeforeDone.length)}/${facts} | ${sum((x) => x.givenNotMet.length)} | ${(sum((x) => x.turns) / g.length).toFixed(1)} | ` +
        `${sum((x) => x.relevant)} / ${sum((x) => x.noise)} | ${u.filter((x) => x.askedBeforeWork).length}/${g.length} | ${sum((x) => x.corrections)} | ` +
        `${sum((x) => x.parentAnswered)} | ${k(Math.round(sum((x) => x.readChars) / g.length))} |`
    )
  }
  out.push(
    '',
    '| model | arm | task | # | pass | facts met | given before done | given, not met | turns | questions (fact / none) | asked first | corrections | work answered | shown |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of rs) {
    const x = r.user as UserReport
    const list = (ids: string[]): string => (ids.length ? ids.join(',') : '—')
    out.push(
      `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${r.grade.pass ? '✅' : '❌'}${r.error || x.simErrors.length ? ' ⚠️' : ''} | ` +
        `${x.facts.length ? `${x.met.length}/${x.facts.length} ${list(x.met)}` : '—'} | ${list(x.givenBeforeDone)} | ${list(x.givenNotMet)} | ` +
        `${x.turns}${x.capped ? ' (capped)' : ''} | ${x.relevant} / ${x.noise} | ${x.askedBeforeWork ? 'yes' : 'no'} | ${x.corrections} | ` +
        `${x.parentAnswered} | ${k(x.readChars)} |`
    )
  }
  return out
}

function writeReport(): void {
  writeFileSync(join(OUT, 'summary.md'), renderSummary())
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(records, null, 2))
}

// ─────────────────────────── one run ───────────────────────────

async function runOne(modelName: string, arm: Arm, task: CodingTask, run: number): Promise<void> {
  const label = `${modelName}-${arm}-${task.id}-r${run}`
  const debug = makeDebug(OUT)
  const { spec, key, modelId } = modelOf(modelName)
  const started = Date.now()
  const stats: SettleStats = { questions: 0, permissions: 0, refused: 0, unansweredSubQuestions: 0 }
  let followUps = 0
  let error: string | undefined
  let agents: string[] = []

  // the simulated user (tasks with hidden facts): one per run, on deepseek whatever model is under test
  const simKey = task.user ? modelOf('deepseek') : undefined
  const sim =
    task.user && simKey
      ? createSimUser({
          key: simKey.key,
          model: simKey.modelId,
          request: task.prompt,
          facts: task.user.facts
        })
      : undefined
  const conv: SimTurn[] = [{ from: 'user', text: task.prompt }]
  const rounds: UserRound[] = []
  const simErrors: string[] = []
  let capped = false

  const app = await launchApp({
    autoReview: AUTO_REVIEW,
    env: { ...OFFLINE_ENV, SHUVIX_E2E_STAGED_RESOURCES: (stage as PackagedStage).resources }
  })
  const repoName = basename(SETS[task.set].repo)
  const repo = join(app.home, 'code', repoName)
  mkdirSync(join(app.home, 'code'), { recursive: true })
  const startSha = prepareRepo(task, repo)
  let rootId = ''
  try {
    await waitRendererReady(app.main)
    await seedRealModel(app.main, {
      providerId: spec.providerId,
      providerName: spec.providerName,
      apiKey: key,
      apiProtocol: spec.apiProtocol,
      modelId
    })
    await app.main.eval(
      `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
    )
    await installHomeGuard(app)
    agents = installAgents(app, arm)
    const events = eventRecorder(app.main)
    await events.install()
    const project = await createProject(app.main, { name: repoName, path: repo })
    rootId = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: '新对话', projectId: project.id })}).then((s) => s.id)`
    )
    // which profile the root really runs: the line under its Identity heading
    const systemPrompt = await app.main.eval<string>(
      `window.api.agent.getInfo(${JSON.stringify(rootId)}, { ensure: true }).then((i) => i.systemPrompt)`
    )
    const identity = systemPrompt.match(/^## (?:Identity|身份|アイデンティティ)\s*\n+(.+)$/m)?.[1]
    agents.push(`root identity: ${identity ?? '(not found)'}`)

    // what the root showed the user since the last look, and how much work it had committed to by then
    let shown = 0
    const freshText = async (): Promise<{ text: string; work: number }> => {
      const msgs = await readMessages(app, rootId)
      const fresh = msgs.slice(shown)
      shown = msgs.length
      return {
        text: fresh
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content.trim())
          .filter(Boolean)
          .join('\n\n'),
        work: msgs.flatMap((m) => m.blocks).filter(isWork).length
      }
    }
    const consult = async (
      via: UserRound['via'],
      text: string,
      work: number,
      card?: SimCard
    ): Promise<SimVerdict> => {
      const verdict = await (sim as NonNullable<typeof sim>).respond(conv, { text, card })
      if (verdict.error) simErrors.push(verdict.error)
      rounds.push({ via, agentChars: text.length, workBefore: work, verdict })
      conv.push({
        from: 'agent',
        text: card
          ? `${text}\n[选择卡片] ${card.question}（${card.options.map((o) => o.label).join(' / ')}）`.trim()
          : text
      })
      const said = [
        verdict.selections.length ? `勾选：${verdict.selections.join('、')}` : '',
        verdict.reply
      ]
        .filter(Boolean)
        .join('；')
      if (said) conv.push({ from: 'user', text: said })
      debug(`${label}: user (${via}) ${JSON.stringify(verdict).slice(0, 300)}`)
      return verdict
    }
    const answerCard = sim
      ? async (card: SimCard): Promise<Record<string, unknown>> => {
          if (rounds.length >= MAX_SIM_CALLS) {
            capped = true
            return { kind: 'other', text: DECIDE }
          }
          const { text, work } = await freshText()
          const v = await consult('card', text, work, card)
          // the model sometimes quotes "label：description"; match on the label
          const picked = card.options
            .map((o) => o.label)
            .filter((l) => v.selections.some((sel) => sel === l || sel.startsWith(l)))
          return picked.length
            ? { kind: 'choice', selections: picked, ...(v.reply ? { note: v.reply } : {}) }
            : { kind: 'other', text: v.reply || DECIDE }
        }
      : undefined
    const settle = (): Promise<void> =>
      settleTree(app, events, rootId, stats, (l) => debug(`${label}: ${l}`), 20_000, answerCard)

    await sendPrompt(app, rootId, task.prompt)
    await settle()
    if (sim) {
      for (;;) {
        const { text, work } = await freshText()
        if (!text) break
        if (rounds.length >= MAX_SIM_CALLS) {
          capped = true
          break
        }
        const v = await consult('reply', text, work)
        if (v.done || !v.reply) break
        await sendPrompt(app, rootId, v.reply)
        await settle()
      }
    } else {
      for (let i = 0; i < 2; i++) {
        const msgs = await readMessages(app, rootId)
        const reply =
          [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''
        if (!looksLikeQuestion(reply)) break
        followUps++
        await sendPrompt(app, rootId, AGREE)
        await settle()
      }
    }
  } catch (e) {
    error = String((e as Error)?.message ?? e)
    debug(`${label}: ${error}`)
  }

  const sessions = rootId ? await treeOf(app, rootId).catch(() => [] as SessionRow[]) : []
  const bySession = new Map<string, Msg[]>()
  for (const s of sessions) bySession.set(s.id, await readMessages(app, s.id).catch(() => []))
  // the temp folder each session's prompt names: a sub-session should name its root's, so the paths a
  // hand-off quotes from the parent's folder are writable without asking
  const tempDirs: string[] = []
  for (const s of sessions) {
    const prompt = await app.main
      .eval<string>(
        `window.api.agent.getInfo(${JSON.stringify(s.id)}, { ensure: false }).then((i) => i?.systemPrompt ?? '')`
      )
      .catch(() => '')
    const dir = prompt.match(/(?:Temporary files|临时文件|一時ファイル)[:：]\s*`([^`]+)`/)?.[1]
    tempDirs.push(dir ?? '(none)')
  }
  if (sessions.length > 1) {
    const same = tempDirs.every((d) => d === tempDirs[0])
    agents.push(`temp folders: ${same ? 'shared' : 'DIFFERENT'} (${tempDirs.join(', ')})`)
  }
  // the repo lives in the fake HOME: keep it until it is graded
  await app.stop({ keepHome: true })
  const redact = (t: string): string =>
    [key, simKey?.key ?? ''].filter(Boolean).reduce((acc, k) => acc.split(k).join('<redacted>'), t)
  writeFileSync(join(OUT, `${label}.md`), redact(transcriptMd(label, sessions, bySession)))
  if (sim) {
    writeFileSync(
      join(OUT, `${label}.user.json`),
      redact(JSON.stringify({ conversation: conv, rounds, calls: sim.log }, null, 2))
    )
  }

  const all = [...bySession.values()].flat()
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let requests = 0
  for (const m of all) {
    if (m.role !== 'assistant' || !m.usage) continue
    requests++
    tokens.input += m.usage.input ?? 0
    tokens.output += m.usage.output ?? 0
    tokens.cacheRead += m.usage.cacheRead ?? 0
    tokens.cacheWrite += m.usage.cacheWrite ?? 0
  }
  const toolCalls: Record<string, number> = {}
  for (const b of all.flatMap((m) => m.blocks)) {
    if (b.type === 'tool') toolCalls[b.toolName ?? '?'] = (toolCalls[b.toolName ?? '?'] ?? 0) + 1
  }
  const rootMsgs = bySession.get(rootId) ?? []
  const rootBlocks = rootMsgs.flatMap((m) => m.blocks).filter((b) => b.type === 'tool')
  const firstHandOff = rootBlocks.findIndex(
    (b) =>
      b.toolName === 'session' ||
      (b.toolName === 'agent' && String(b.args?.name ?? '') !== 'explore')
  )
  const beforeHandOff = firstHandOff === -1 ? rootBlocks : rootBlocks.slice(0, firstHandOff)

  let grade: Grade
  try {
    grade = gradeRepo(task, repo, startSha)
  } finally {
    rmSync(app.home, { recursive: true, force: true })
  }
  const user = task.user
    ? userReport(
        task.user.facts.map((f) => f.id),
        grade,
        rounds,
        sessions.filter((s) => s.id !== rootId).flatMap((s) => bySession.get(s.id) ?? []),
        capped,
        simErrors
      )
    : undefined
  const record: RunRecord = {
    model: modelName,
    modelId,
    arm,
    task: task.id,
    run,
    seconds: Math.round((Date.now() - started) / 1000),
    grade,
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      profile: s.agentProfile,
      parent: s.parentId
    })),
    requests,
    tokens,
    toolCalls,
    rootToolCalls: rootBlocks.length,
    skimBeforeDispatch: beforeHandOff.filter((b) => READS.has(b.toolName ?? '')).length,
    rootEdits: rootBlocks.filter((b) => b.toolName === 'edit' || b.toolName === 'write').length,
    dispatches: dispatchesOf(task, rootMsgs),
    exploreCalls: all
      .flatMap((m) => m.blocks)
      .filter(
        (b) =>
          b.type === 'tool' && b.toolName === 'agent' && String(b.args?.name ?? '') === 'explore'
      ).length,
    settle: stats,
    followUps,
    finalReply:
      [...rootMsgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ??
      '',
    agents,
    ...(user ? { user } : {}),
    error
  }
  records.push(record)
  writeFileSync(join(OUT, 'summary.md'), redact(renderSummary()))
  writeFileSync(join(OUT, 'summary.json'), redact(JSON.stringify(records, null, 2)))
  console.log(
    `[${label}] ${grade.pass ? 'PASS' : 'FAIL'} core ${grade.core.passed}/${grade.core.total} → ${OUT}`
  )
}

// ─────────────────────────── entry ───────────────────────────

const selected = TASKS.filter((t) => t.set === SET && TASK_IDS.includes(t.id))

if (SELFCHECK) {
  for (const task of selected) {
    it(`self-check ${task.id}: start fails, reference passes`, () => {
      const startRepo = mkdtempSync(join(tmpdir(), `ledger-${task.id}-start-`))
      const sha = prepareRepo(task, `${startRepo}/repo`)
      const atStart = gradeRepo(task, `${startRepo}/repo`, sha)
      const refRepo = mkdtempSync(join(tmpdir(), `ledger-${task.id}-ref-`))
      const sha2 = prepareRepo(task, `${refRepo}/repo`)
      applyReference(task, `${refRepo}/repo`)
      const fixed = gradeRepo(task, `${refRepo}/repo`, sha2)
      const failing = (g: Grade): string[] =>
        g.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.error}`)
      console.log(
        `[${task.id}] start: core ${atStart.core.passed}/${atStart.core.total}, visible ${atStart.visible.pass}/${atStart.visible.pass + atStart.visible.fail}; ` +
          `reference: core ${fixed.core.passed}/${fixed.core.total}, extra ${fixed.extra.passed}/${fixed.extra.total}, visible ${fixed.visible.pass}/${fixed.visible.pass + fixed.visible.fail}, suite ${fixed.suite.pass}/${fixed.suite.pass + fixed.suite.fail}`
      )
      expect(atStart.graderError).toBeUndefined()
      expect(atStart.pass).toBe(false)
      expect(fixed.graderError, fixed.graderError).toBeUndefined()
      expect(failing(fixed)).toEqual([])
      expect(fixed.visible.fail).toBe(0)
      expect(fixed.suite.fail).toBe(0)
      expect(fixed.tampered).toEqual({ tests: [], testScript: false })
    })
  }
} else {
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
    realBefore = realHomeEntries()
    stage = stagePackagedResources()
  }, 300_000)

  afterAll(() => {
    stage?.cleanup()
    const added = realHomeEntries().filter((n) => !realBefore.includes(n))
    writeFileSync(
      join(OUT, 'real-home-check.txt'),
      added.length
        ? `NEW IN REAL HOME:\n${added.join('\n')}\n`
        : 'real ~/.shuvix and ~/.npm unchanged\n'
    )
    if (records.length) writeReport()
    console.log(`report: ${join(OUT, 'summary.md')}`)
  })

  for (let run = 1; run <= RUNS; run++) {
    for (const modelName of MODEL_IDS) {
      for (const task of selected) {
        for (const arm of ARMS) {
          it(
            `${modelName} / ${arm} / ${task.id} / #${run}`,
            () => runOne(modelName, arm, task, run),
            TURN_TIMEOUT_MS * 3
          )
        }
      }
    }
  }
}
