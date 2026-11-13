/**
 * Coding probe: real models do real (small) programming tasks in ShuviX, and a hidden grader scores the result.
 * Nothing is asserted; the output is a report. It exists to answer questions such as "does handing work from
 * `work` to a `coding` sub-session help or hurt?", "does this coding.md draft beat today's?" and "does setting
 * a goal get further than saying it once?" with numbers instead of feel.
 *
 * Tasks: `coding/tasks.ts` — six sets on two Node repos (graders and reference solutions in
 * `coding/fixtures`). `PROBE_SET=hard` (default), `easy`, `ambig`, `handoff`, `long` or `trap`; easy and hard
 * are at ceiling for deepseek and kimi. The ambig set's requests leave out what only the user knows: a
 * simulated user (`coding/simUser.ts`, on deepseek whatever model is under test) holds those facts and answers
 * the root's questions, plain-text or ask cards, and the report adds what it cost the user (turns, questions,
 * how many touched a fact, text to read), which facts were given before the agent called it done, and which
 * facts were given but not met. The handoff set states every fact where a hand-off can drop it. The long set
 * (three multi-layer features, each ending in "npm test passes, including test/<task>.test.js") is for goal
 * mode: the user first sends a message of two standing rules, settled before the request and never repeated,
 * and the grader checks each rule apart from the task (`constraint` C1, C2) — does a rule said only early in
 * the conversation survive a long run and its compactions, and in a goal run the manager's hand-off? The trap
 * set (four goal-style requests with a stated, checkable end condition) is built so that the cheapest check
 * looks green before the condition is met: a second command the start already fails (`avgcost`: lint), a
 * sweeping rename the tests cover in part (`quantity`), parts of a feature the tests never touch (`tags`), a
 * verification script the request names (`leadtime`: `npm run smoke`). It measures how often an agent declares
 * done too early, and in the goal arms whether the goal's manager sends the worker back or waves it through.
 *
 * Arms (`PROBE_ARMS`, comma-separated; default `direct,goal` for the long and trap sets, `direct,work`
 * otherwise):
 *   direct  the user talks to the coding agent itself: the project session's base profile is replaced by the
 *           coding md (a user-level `work.md` built from it)
 *   work    today's product: the project session runs `work`, which hands the job to a `coding` sub-session
 *   goal    the product's goal mode (docs/goal-mode-design.md §16). The project session is created as in
 *           direct (same md) and is the WORKER; the probe never sends it the request. The probe calls
 *           `agent.goalStart({ sessionId, objective })` with the request as the objective: the host forks the
 *           session, and the fork is the goal's MANAGER. It receives the objective as the user's message, with
 *           the `<goal-set>` note (chat-protocol goalSet.ts): write the acceptance criteria, ask the user at
 *           most three questions, hand the task to the worker with the `session` tool, judge by the worker's
 *           reports, send it back or tell the user the goal is met, and never do the work or look into the
 *           project itself. Set and leave: the probe sends neither session anything afterwards.
 *           The run lasts until the worker's session tree and the manager (with any sub-session of its own)
 *           are all quiet and have stayed so for 20 s, the settle window of every arm: no turn running (the
 *           session view, and the agent monitor in case a view lags), nothing running in the task list (the
 *           turn the manager started in the worker, a spawned agent, a background command: each can wake its
 *           session when it ends), no question the probe is still leaving to the manager. Or until
 *           `PROBE_GOAL_TIMEOUT_MIN` runs out: `timed out`, and the error says what was still busy. The
 *           workspace is graded as it stands when the run ends. A `goalStart` that refuses is recorded
 *           (`refused`) and the untouched workspace is graded.
 *           Ask cards meanwhile. A question in the manager's session is the manager asking the user: the
 *           simulated user answers it (tasks with one; it is shown what the manager wrote since the goal
 *           message), otherwise the first option is ticked, which the note tells the manager to make its
 *           recommendation. A question in the worker's session is the manager's to answer (`answer-session`):
 *           the probe leaves it for 60 s, then the user answers it (the simulated user, or "decide yourself"),
 *           and those are counted apart. Sub-sessions' questions are their parent's, as in every arm.
 *           Permission asks in either session are approved unless they name the real home, as in every arm.
 *           In the long set the early message goes to the worker and is settled before the goal is set, so
 *           the manager's copy of the conversation holds the rules. Not for the handoff set (its user speaks
 *           on its own: prelude, mid-task).
 *   goal-oracle  as goal, but the objective is the request plus every hidden fact as an explicit "done when"
 *           list, then the request's own end condition (`goalDraft.ts` goalTextOracle, `endCondition` in
 *           tasks.ts), cut to the goal's 4000 characters (the cut is reported): the upper bound of what a
 *           goal can say. Tasks with a simulated user only (ambig).
 * `PROBE_MD_DIR` points at a folder of md drafts (`coding.md`, `work.md`, …) installed as user-level agents in
 * every arm; `direct` and the goal arms then build their `work.md` from that `coding.md`. Compare drafts by
 * running twice with different `PROBE_MD_DIR` / `PROBE_OUT`.
 *
 * Other knobs: `PROBE_MODELS` (deepseek, kimi, anthropic, openai — keys from ~/.shuvix-probe.env), `PROBE_TASKS`,
 * `PROBE_RUNS` (repeats of each model × arm × task), `PROBE_LANG` (default zh), `PROBE_AUTO_REVIEW=1` (let the
 * product's reviewer answer permission asks instead of the probe, in every arm), `PROBE_OUT` (report folder).
 * Goal arms: `PROBE_GOAL_TIMEOUT_MIN` (default 120: the probe gives up on a goal whose manager and worker have
 * not gone quiet by then). A goal has no limits of its own any more, so there is nothing else to set.
 * `PROBE_CONTEXT_WINDOW=<tokens>` writes that window into the model row's capabilities so compaction comes
 * sooner. It only takes effect for a model id outside pi's catalog (an overlay row): catalog models keep the
 * catalog's window (deepseek-flash, deepseek-v4-pro and kimi-for-coding are 1M). The report shows the window
 * each run really had and how many compactions happened, so a run where it did not apply is visible.
 * `PROBE_SELFCHECK=1` runs no model: it checks that every task's start state fails its grader and its reference
 * solution passes, the early message's rules included (printed apart); for a task with a `trap/` overlay (the
 * trap set's plausible premature-done state) also that it passes the visible tests and the suite yet fails
 * the grader, so each trap is real. For every set it also checks the goal arms' own code without a model:
 * every goal-oracle text and the 4000-character cut, the reading of a made-up manager transcript (hand-offs,
 * questions, violations, turns, requests and tokens, with the copied part left out), and the "Goal manager"
 * section rendered from made-up records.
 *
 * Report (`summary.md`, `summary.json`; `<run>.md` is the transcript of every session of a run, the goal's
 * manager included): per model × arm and per run, pass / core / visible tests / tampering / tokens / requests /
 * seconds / hand-offs. In a goal run these count the worker's session tree; the manager's own are apart.
 * "With the simulated user" (ambig, every arm): facts met, given, lost, and what it cost the user.
 * "Rules and compaction" (whenever a run has rules or a goal): rules kept (C1, C2 per run), compactions, the
 * root's context window.
 * "Goal manager" (goal arms), one row per goal run: model, task, arm, run, pass, outcome (ok = the manager and
 * the worker went quiet; refused; timed out; error = the run broke), and from the manager's own transcript —
 * what follows the goal message, since before it the manager is a copy of the worker's conversation —
 * hand-offs (`session` prompt-session calls: the task, then each time it sent the worker back), questions to
 * the user (`ask` calls; +n = the worker's questions the manager left to the user), violations (calls of any
 * tool other than `session` and `ask`, as `tool×n`: the manager working or exploring itself; `none` is what
 * the note asks for), manager turns (the goal message plus each time it was woken), seconds from goalStart to
 * quiet, the manager's requests and tokens, and its final words (160 characters; 600 in the run's details and
 * in summary.json, with its other `session` actions and the worker's questions it answered itself).
 * "Traps" (trap set): what each task's trap is.
 *
 * Safety (see memory "probe-auto-approve-scope"): each run is a fresh isolated instance on a packaged-shaped
 * stage; a policy denies file tools and commands that touch the real home folder; permission asks are approved
 * unless they name the real home; npm / pip / browser download hosts point at an unreachable port; after the
 * runs the real ~/.shuvix and ~/.npm are listed again and any new entry is reported in real-home-check.txt.
 *
 *   npx electron-vite build
 *   PROBE_MODELS=deepseek npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SET=long PROBE_ARMS=direct,goal PROBE_MODELS=deepseek PROBE_RUNS=3 \
 *     npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SET=trap PROBE_MODELS=deepseek,kimi PROBE_RUNS=3 PROBE_GOAL_TIMEOUT_MIN=60 \
 *     npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SET=ambig PROBE_ARMS=direct,goal,goal-oracle PROBE_MODELS=deepseek PROBE_GOAL_TIMEOUT_MIN=60 \
 *     npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SELFCHECK=1 PROBE_SET=trap npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
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
import type { GoalStartResult } from '@shuvix/chat-protocol/types/goal'
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
import { fitObjective, goalTextOracle } from './coding/goalDraft'
import {
  applyReference,
  applyTrapState,
  gradeRepo,
  hasTrapState,
  prepareRepo,
  type Grade
} from './coding/workspace'
import {
  createSimUser,
  type SimCard,
  type SimTurn,
  type SimUser,
  type SimVerdict
} from './coding/simUser'

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
const SET = (process.env.PROBE_SET ?? 'hard') as SetId
if (!SETS[SET])
  throw new Error(`PROBE_SET must be one of ${Object.keys(SETS).join(', ')}; got ${SET}`)
const ARMS = list(
  process.env.PROBE_ARMS,
  SET === 'long' || SET === 'trap' ? 'direct,goal' : 'direct,work'
) as Arm[]
const ALL_ARMS: Arm[] = ['direct', 'work', 'goal', 'goal-oracle']
for (const arm of ARMS) {
  if (!ALL_ARMS.includes(arm))
    throw new Error(`PROBE_ARMS takes ${ALL_ARMS.join(', ')}; got ${arm}`)
}
const TASK_IDS = list(
  process.env.PROBE_TASKS,
  TASKS.filter((t) => t.set === SET)
    .map((t) => t.id)
    .join(',')
)
const TURN_TIMEOUT_MS = 25 * 60 * 1000
/** a session tree counts as quiet once nothing has happened in it for this long */
const QUIET_MS = 20_000

/** a positive number from the environment, or undefined when unset */
function positiveEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number, got ${raw}`)
  return n
}
/** goal arms: the probe gives up on a goal whose manager and worker have not gone quiet by then */
const GOAL_TIMEOUT_MS = (positiveEnv('PROBE_GOAL_TIMEOUT_MIN') ?? 120) * 60 * 1000
/** goal arms: how long the manager has to answer a question of the worker's before the user answers it */
const WORKER_ASK_GRACE_MS = 60_000
/** a smaller context window for the model under test (only models outside pi's catalog take it) */
const CONTEXT_WINDOW = (() => {
  const n = positiveEnv('PROBE_CONTEXT_WINDOW')
  return n === undefined ? undefined : Math.round(n)
})()

/** what the stock user says when asked (tasks without a simulated user) */
const AGREE = '可以，按你说的来。'
const DECIDE = '你自己判断，按最合理的来。'
/** at most this many simulated-user answers per run (replies and cards); past it the run is "capped" */
const MAX_SIM_CALLS = 8

type Arm = 'direct' | 'work' | 'goal' | 'goal-oracle'

/** the arms that set a goal and leave */
const isGoalArm = (arm: Arm): boolean => arm === 'goal' || arm === 'goal-oracle'

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

/** The user-level `work.md` the direct and goal arms run: the coding md (a draft's, else the builtin) */
function codingAsWork(): string {
  const draft = MD_DIR ? join(MD_DIR, 'coding.md') : undefined
  return asUserAgent(
    draft && existsSync(draft) ? readFileSync(draft, 'utf8') : builtinMd('coding'),
    'work'
  )
}

function installAgents(app: E2EApp, arm: Arm): string[] {
  mkdirSync(app.agentsDir, { recursive: true })
  const written: string[] = []
  const drafts = MD_DIR ? readdirSync(MD_DIR).filter((n) => n.endsWith('.md')) : []
  for (const n of drafts) {
    writeFileSync(join(app.agentsDir, n), readFileSync(join(MD_DIR as string, n), 'utf8'))
    written.push(n)
  }
  if (arm === 'direct' || isGoalArm(arm)) {
    writeFileSync(join(app.agentsDir, 'work.md'), codingAsWork())
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
  /** goal arms: the goal's manager session (set by the probe, for the transcript and the record) */
  manager?: boolean
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
  /** a compaction summary (the transcript before it was summarised) */
  compaction: boolean
  /** user：宿主随这条消息附上的用户原话条数（`user-words` Token 的 name，chat-protocol userWords.ts）；没附 = 0 */
  quoted: number
  /** user: the message that set a goal (it carries the `goal` token, chat-protocol goalSet.ts) */
  goalSet: boolean
  blocks: Block[]
}

const readMessages = (app: E2EApp, sid: string): Promise<Msg[]> =>
  app.main.eval<Msg[]>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => msgs.map((m) => ({
      role: m.role,
      content: String(m.content ?? ''),
      usage: m.metadata ? m.metadata.usage : undefined,
      isNotice: Boolean(m.metadata && m.metadata.isSystemNotice),
      compaction: Boolean(m.metadata && m.metadata.isCompactionSummary),
      quoted: Object.values((m.metadata && m.metadata.inlineTokens) || {})
        .filter((t) => t && t.type === 'user-words')
        .reduce((n, t) => n + (Number(t.name) || 0), 0),
      goalSet: Object.values((m.metadata && m.metadata.inlineTokens) || {})
        .some((t) => t && t.type === 'goal'),
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
  /**
   * the root's choice questions the user answered; in a goal run the root is the worker, and these are the
   * questions its manager left unanswered for WORKER_ASK_GRACE_MS
   */
  questions: number
  /** goal arms: the manager's choice questions (the manager asking the user), answered by the user */
  managerQuestions: number
  permissions: number
  refused: number
  /** choice questions from a sub-session that nobody answered when the tree went quiet */
  unansweredSubQuestions: number
}

const newSettleStats = (): SettleStats => ({
  questions: 0,
  managerQuestions: 0,
  permissions: 0,
  refused: 0,
  unansweredSubQuestions: 0
})

/** goal arms: the goal's manager session, watched along with the worker's tree */
interface ManagerWatch {
  id: string
  /** the user's answer to a question the manager asked */
  answerChoice: (card: SimCard) => Promise<Record<string, unknown>>
}

/**
 * What the task list and the agent monitor show running in these sessions: a task that has not ended (a turn
 * started in another session, a spawned agent, a background command — each can wake its session when it ends),
 * and an agent in a turn or a compaction (in case a session view lags behind).
 */
const runningIn = (app: E2EApp, sessionIds: string[]): Promise<string[]> =>
  app.main.eval<string[]>(`(async () => {
    const ids = new Set(${JSON.stringify(sessionIds)})
    const [tasks, agents] = await Promise.all([window.api.bgTask.listAll(), window.api.agent.monitorList()])
    return [
      ...tasks
        .filter((t) => ids.has(t.sessionId) && t.endedAt === null)
        .map((t) => t.sessionId + ': ' + t.kind + ' task running'),
      ...agents
        .filter((a) => ids.has(a.rootSessionId) && (a.phase === 'turn' || a.phase === 'compaction'))
        .map((a) => a.rootSessionId + ': ' + a.phase + ' (agent monitor)')
    ]
  })()`)

/**
 * Wait until the whole session tree is quiet, answering on the user's behalf meanwhile: permission asks anywhere
 * in the tree (refused when they name the real home), and the root's own questions (by the simulated user when
 * the task has one). A sub-session's question is the parent agent's to answer (sub-session intervention), so it
 * is left alone.
 *
 * `opts.manager` (goal arms): the root is the goal's worker, and the manager session (with any sub-session of
 * its own) is watched along with the worker's tree. Quiet then means, for every session of both trees: no turn
 * running, nothing running in the task list or the agent monitor (`runningIn`), no question the probe is still
 * leaving to the manager. A question of the manager's is the manager asking the user, and is answered at once
 * (`manager.answerChoice`). A question of the worker's is the manager's to answer (`answer-session`); one still
 * waiting after WORKER_ASK_GRACE_MS is answered by the user, as the root's are in the other arms. Permission
 * asks are handled the same in both trees. `opts.onQuiet` is told when the quiet began.
 */
async function settleTree(
  app: E2EApp,
  events: EventRecorder,
  rootId: string,
  stats: SettleStats,
  debug: (l: string) => void,
  quietMs = QUIET_MS,
  answerRootChoice?: (card: SimCard) => Promise<Record<string, unknown>>,
  opts: { timeoutMs?: number; manager?: ManagerWatch; onQuiet?: (since: number) => void } = {}
): Promise<void> {
  const sync = syncProbe(app.main)
  await sync.install()
  const manager = opts.manager
  const answered = new Set<string>()
  /** goal arms: when each question of the worker's was first seen waiting */
  const workerAskSeen = new Map<string, number>()
  let last = -1
  let quietSince = Date.now()
  let pendingSub = 0
  /** what kept the sessions busy at the last look (said when the wait times out) */
  let busyWith: string[] = []
  const poll = async (): Promise<boolean> => {
    const busy: string[] = []
    pendingSub = 0
    const watched = await treeOf(app, rootId)
    if (manager) {
      for (const s of await treeOf(app, manager.id))
        if (!watched.some((w) => w.id === s.id)) watched.push(s)
    }
    for (const s of watched) {
      const view = await withTimeout(sync.viewOf(s.id), 8000).catch((e) => {
        debug(`viewOf ${s.id} failed: ${String(e)}`)
        return undefined
      })
      if (!view) {
        busy.push(`${s.id}: its view could not be read`)
        continue
      }
      if (view.run?.state === 'busy') busy.push(`${s.id}: a turn is running`)
      for (const req of (view.asks ?? []) as Array<{
        id: string
        kind: string
        question?: string
        options?: SimCard['options']
      }>) {
        if (answered.has(req.id)) continue
        let response: Record<string, unknown>
        if (req.kind === 'choice') {
          const card: SimCard = { question: req.question ?? '', options: req.options ?? [] }
          if (manager && s.id === manager.id) {
            stats.managerQuestions++
            response = await manager.answerChoice(card)
          } else if (s.id !== rootId) {
            pendingSub++
            continue
          } else {
            if (manager) {
              const seenAt = workerAskSeen.get(req.id) ?? Date.now()
              workerAskSeen.set(req.id, seenAt)
              if (Date.now() - seenAt < WORKER_ASK_GRACE_MS) {
                busy.push(`${s.id}: a question is waiting for the manager to answer`)
                continue
              }
              debug(`ask ${req.id}: the manager left it for ${WORKER_ASK_GRACE_MS / 1000} s`)
            }
            stats.questions++
            response = answerRootChoice
              ? await answerRootChoice(card)
              : { kind: 'other', text: DECIDE }
          }
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
    if (manager) {
      busy.push(
        ...(await withTimeout(
          runningIn(
            app,
            watched.map((s) => s.id)
          ),
          8000
        ).catch((e) => {
          debug(`reading the task list and the agent monitor failed: ${String(e)}`)
          return ['the task list and the agent monitor could not be read']
        }))
      )
    }
    busyWith = busy
    const mark = await events.mark()
    if (mark !== last || busy.length > 0) {
      last = mark
      quietSince = Date.now()
      return false
    }
    if (Date.now() - quietSince <= quietMs) return false
    opts.onQuiet?.(quietSince)
    return true
  }
  try {
    await until(
      poll,
      manager ? 'the goal’s manager and worker went quiet' : 'session tree went quiet',
      opts.timeoutMs ?? TURN_TIMEOUT_MS
    )
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    throw new Error(busyWith.length ? `${message}; still busy: ${busyWith.join('; ')}` : message)
  }
  stats.unansweredSubQuestions = pendingSub
}

const looksLikeQuestion = (reply: string): boolean =>
  /[?？]\s*$/.test(reply.trim()) ||
  /(要不要|是否需要|需要我|你同意|同意的话|确认一下|你看可以|可以吗)/.test(reply.slice(-300))

/** the line under the system prompt's Identity heading: which profile a session really runs */
const identityOf = (systemPrompt: string): string =>
  systemPrompt.match(/^## (?:Identity|身份|アイデンティティ)\s*\n+(.+)$/m)?.[1] ?? '(not found)'

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
  /** the root's tree; in a goal run the worker's tree, then the manager (`manager: true`) and its sub-sessions */
  sessions: Array<{
    id: string
    title: string
    profile?: string
    parent?: string
    manager?: boolean
  }>
  /** LLM requests and tokens of the root's tree (in a goal run the worker's; the manager's are in `goal`) */
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
  /**
   * messages into sub-sessions (in a goal run also the manager's hand-offs into the worker) that carried the
   * user's own words, and how many words they quoted in all
   */
  userWordsAttached: { sends: number; words: number }
  user?: UserReport
  /** compaction summaries in the tree's transcripts */
  compactions: number
  /** the root's context window as it really ran (0 = unknown) */
  contextWindow: number
  goal?: GoalRun
  error?: string
}

/** What the goal's manager did, read from its transcript */
interface ManagerActivity {
  /** `session` calls with action prompt-session: the task handed to the worker, and each time it was sent back */
  handOffs: number
  /** its other `session` actions (wait-for-sessions, read-session, answer-session, …) and how often */
  sessionActions: Record<string, number>
  /** `ask` calls: questions to the user */
  userAsks: number
  /** calls of any tool other than `session` and `ask`: the manager working or exploring itself */
  violations: Record<string, number>
  /** turns it ran: the goal message, then each time it was woken (a completion notice, an answer) */
  managerTurns: number
  /** its last words, clipped to 600 characters */
  finalWords: string
  /** the manager's own LLM requests and tokens */
  requests: number
  tokens: Required<Usage>
}

/** What came of a goal (goal arms) */
interface GoalRun extends ManagerActivity {
  /** the text set as the goal (goal: the request; goal-oracle: the request plus "done when", see the header) */
  objective: string
  /** characters cut to fit the goal's 4000-character limit */
  cut: number
  /** `goalStart` refused: there is no manager and nothing ran */
  refused?: string
  /** the manager session (the fork `goalStart` made) */
  managerId?: string
  /** the manager and the worker had not gone quiet when PROBE_GOAL_TIMEOUT_MIN ran out */
  timedOut: boolean
  /** from `goalStart` until both had gone quiet, or until the probe gave up */
  seconds: number
  /** the worker's ask cards: answered by the manager, or left to the user after WORKER_ASK_GRACE_MS */
  workerAsks: { byManager: number; byUser: number }
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** LLM requests and tokens of these messages: one assistant message with usage = one request */
function usageOf(msgs: Msg[]): { requests: number; tokens: Required<Usage> } {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let requests = 0
  for (const m of msgs) {
    if (m.role !== 'assistant' || !m.usage) continue
    requests++
    tokens.input += m.usage.input ?? 0
    tokens.output += m.usage.output ?? 0
    tokens.cacheRead += m.usage.cacheRead ?? 0
    tokens.cacheWrite += m.usage.cacheWrite ?? 0
  }
  return { requests, tokens }
}

/**
 * The manager's own part of its transcript. The manager is a copy of the worker's conversation, so what comes
 * before the message that set the goal is the worker's past, not the manager's doing. `copied` = how many
 * messages the worker had when the goal was set, used when no message carries the goal token.
 */
function managerOwn(msgs: Msg[], copied: number): Msg[] {
  const at = msgs.findIndex((m) => m.role === 'user' && m.goalSet)
  return msgs.slice(at === -1 ? Math.min(copied, msgs.length) : at)
}

/** a `session` action under its current name (calls replayed from before 2026-10-20 carry the old ones) */
const sessionActionOf = (b: Block): string => {
  const action = String(b.args?.action ?? '?')
  return action === 'create-sub-session'
    ? action
    : action.replace(/-sub-session(s?)$/, '-session$1')
}

/** What the manager did, from its own part of the transcript (`managerOwn`) */
function managerActivity(own: Msg[]): ManagerActivity {
  const out: ManagerActivity = {
    handOffs: 0,
    sessionActions: {},
    userAsks: 0,
    violations: {},
    managerTurns: 0,
    finalWords: '',
    ...usageOf(own)
  }
  const add = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1
  }
  // a turn = a message it was sent (the goal, a notice that woke it) that it went on to answer
  let unanswered = false
  for (const m of own) {
    if (m.role === 'user') {
      unanswered = true
      continue
    }
    if (m.role !== 'assistant' || m.compaction) continue
    if (unanswered) {
      out.managerTurns++
      unanswered = false
    }
    if (m.content.trim()) out.finalWords = clip(m.content.trim(), 600)
    for (const b of m.blocks) {
      if (b.type !== 'tool') continue
      if (b.toolName === 'ask') out.userAsks++
      else if (b.toolName !== 'session') add(out.violations, b.toolName ?? '?')
      else if (sessionActionOf(b) === 'prompt-session') out.handOffs++
      else add(out.sessionActions, sessionActionOf(b))
    }
  }
  return out
}

/** `tool×n` pairs, most used first */
const countsText = (map: Record<string, number>): string =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join(' ')

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
      `\n## ${s.manager ? 'goal manager session' : s.parentId ? 'sub-session' : 'session'} ${s.title} (${s.agentProfile ?? 'base'}) ${s.id}\n`
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

/** the hidden facts whose grader checks all passed */
const factsMet = (facts: string[], grade: Grade): string[] =>
  facts.filter((id) => {
    const checks = grade.checks.filter((c) => c.fact === id)
    return checks.length > 0 && checks.every((c) => c.pass)
  })

function userReport(
  facts: string[],
  scripted: string[],
  grade: Grade,
  rounds: UserRound[],
  subMessages: Msg[],
  capped: boolean,
  simErrors: string[]
): UserReport {
  const met = factsMet(facts, grade)
  // facts the scripted user stated on its own (prelude, request, mid-task) are given, before any "done"
  const given = [...new Set([...scripted, ...rounds.flatMap((r) => r.verdict.disclosed)])].sort()
  const beforeDone = new Set<string>(scripted)
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

/** text as one table cell */
const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

function renderSummary(): string {
  const lines = [
    `# Coding probe: ${SET} set (${LANG}${MD_DIR ? `, drafts from ${MD_DIR}` : ''}${AUTO_REVIEW ? ', auto-review on' : ''}` +
      `${CONTEXT_WINDOW !== undefined ? `, context window ${CONTEXT_WINDOW} asked` : ''}` +
      `${ARMS.some(isGoalArm) ? `, goal timeout ${GOAL_TIMEOUT_MS / 60_000} min` : ''})`,
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
  if (records.some((r) => r.goal))
    lines.push(
      '',
      'Goal arms: tokens, requests and tool calls in this table and under Runs are the worker’s session tree; the manager’s own are under Goal manager.'
    )
  lines.push(...userSummary())
  lines.push(...rulesSummary())
  lines.push(...goalManagerSummary())
  lines.push(...trapNotes())
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
      const tag = c.constraint ? ` (rule ${c.constraint})` : c.core ? '' : ' (extra)'
      lines.push(
        `- ${c.pass ? '✅' : '❌'}${tag} ${c.name}${c.error ? ` — ${c.error.replace(/\n/g, ' ')}` : ''}`
      )
    }
    if (r.grade.graderError) lines.push(`- grader failed: ${r.grade.graderError}`)
    if (r.grade.visible.output)
      lines.push('', '```text', r.grade.visible.output.slice(-1200), '```')
    lines.push(
      '',
      `Changed: ${[...r.grade.diff.files.map((f) => `${f.path} (+${f.added}/−${f.removed})`), ...r.grade.diff.untracked.map((u) => `${u} (new)`)].join(', ') || 'nothing'}`,
      `Sessions: ${r.sessions.map((s) => `${s.profile ?? 'base'}${s.manager ? ' (goal manager)' : s.parent ? ' (sub)' : ''}`).join(', ')}; tools: ${Object.entries(
        r.toolCalls
      )
        .map(([n, c]) => `${n}×${c}`)
        .join(' ')}; explore: ${r.exploreCalls}; follow-ups: ${r.followUps}`,
      `Agents: ${r.agents.join('; ') || 'builtin'}`,
      `User words attached to ${r.goal ? 'the manager’s hand-offs and ' : ''}sub-session messages: ${r.userWordsAttached.words} in ${r.userWordsAttached.sends} message(s)`,
      `Compactions: ${r.compactions}; context window: ${r.contextWindow || 'unknown'}`
    )
    if (r.goal) {
      const g = r.goal
      if (r.arm !== 'goal')
        lines.push(
          '',
          `Goal text (${g.objective.length} chars${g.cut ? `, ${g.cut} cut` : ''}):`,
          '',
          '```text',
          g.objective,
          '```'
        )
      lines.push('', ...goalDetails(r))
    }
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
    lines.push(
      '',
      r.goal ? 'Final reply (the worker’s):' : 'Final reply:',
      '',
      '```text',
      r.finalReply.slice(0, 3000),
      '```'
    )
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

/** Rules the user stated only early (long set) and compaction, for runs with rules and for goal runs */
function rulesSummary(): string[] {
  const rs = records.filter((r) => r.goal || r.grade.constraints.total > 0)
  if (!rs.length) return []
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0)
  const out = [
    '',
    '## Rules and compaction',
    '',
    'rules kept = checks of the rules the user stated only in the early message (C1, C2 per task), apart from pass; ' +
      'all kept = runs that kept every rule; compactions and window = the root session’s tree (in a goal run the worker’s).',
    '',
    '| model | arm | runs | pass | rules kept | all kept | compactions (mean) | window |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const groups = new Map<string, RunRecord[]>()
  for (const r of rs)
    groups.set(`${r.model}|${r.arm}`, [...(groups.get(`${r.model}|${r.arm}`) ?? []), r])
  for (const [key, g] of groups) {
    const [model, arm] = key.split('|')
    const kept = g.reduce((t, r) => t + r.grade.constraints.kept, 0)
    const total = g.reduce((t, r) => t + r.grade.constraints.total, 0)
    const windows = [...new Set(g.map((r) => r.contextWindow || 0))].map((w) => (w ? k(w) : '?'))
    out.push(
      `| ${model} | ${arm} | ${g.length} | ${g.filter((r) => r.grade.pass).length}/${g.length} | ${total ? `${kept}/${total}` : '—'} | ` +
        `${total ? `${g.filter((r) => r.grade.constraints.kept === r.grade.constraints.total).length}/${g.length}` : '—'} | ` +
        `${mean(g.map((r) => r.compactions)).toFixed(1)} | ${windows.join(', ')} |`
    )
  }
  out.push(
    '',
    '| model | arm | task | # | pass | rules | compactions | window |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of rs) {
    const rules = r.grade.checks
      .filter((c) => c.constraint)
      .map((c) => `${c.constraint} ${c.pass ? '✅' : '❌'}`)
      .join(' ')
    out.push(
      `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${r.grade.pass ? '✅' : '❌'}${r.error ? ' ⚠️' : ''} | ${rules || '—'} | ${r.compactions} | ` +
        `${r.contextWindow ? k(r.contextWindow) : '?'} |`
    )
  }
  return out
}

/** How a goal run ended: ok = the manager and the worker both went quiet */
const goalOutcome = (r: RunRecord): 'ok' | 'refused' | 'timed out' | 'error' =>
  r.goal?.refused !== undefined
    ? 'refused'
    : r.goal?.timedOut
      ? 'timed out'
      : r.error
        ? 'error'
        : 'ok'

const tokensIn = (t: Required<Usage>): number => t.input + t.cacheRead + t.cacheWrite

/** The goal arms: how each goal run ended and what its manager did, one row per run */
function goalManagerSummary(): string[] {
  const rs = records.filter((r) => r.goal)
  if (!rs.length) return []
  const out = [
    '',
    '## Goal manager',
    '',
    'One row per goal run. The worker is the project session; the manager is the fork `goalStart` made of it, and its columns are read from its own transcript, from the goal message on. ' +
      'outcome: ok = the manager and the worker both went quiet; refused = `goalStart` said no and nothing ran; timed out = still busy when PROBE_GOAL_TIMEOUT_MIN ran out; error = the run broke (see the run). ' +
      'hand-offs = its `session` prompt-session calls: the task, then each time it sent the worker back. ' +
      'questions to the user = its `ask` calls (+n = questions of the worker’s that it left unanswered for a minute, so the user answered). ' +
      'violations = its calls of any tool other than `session` and `ask`: the manager working or exploring itself. ' +
      'manager turns = the goal message plus each time it was woken. s = from goalStart until both were quiet. ' +
      'manager req and tokens = the manager’s own; every other table counts the worker’s tree.',
    '',
    '| model | task | arm | # | pass | outcome | hand-offs | questions to the user | violations | manager turns | s | manager req | manager tokens in / out | final words |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const r of rs) {
    const g = r.goal as GoalRun
    const ran = g.managerId !== undefined
    out.push(
      `| ${r.model} | ${r.task} | ${r.arm} | ${r.run} | ${r.grade.pass ? '✅' : '❌'}${r.error ? ' ⚠️' : ''} | ${goalOutcome(r)} | ` +
        (ran
          ? `${g.handOffs} | ${g.userAsks}${g.workerAsks.byUser ? ` (+${g.workerAsks.byUser})` : ''} | ${countsText(g.violations) || 'none'} | ` +
            `${g.managerTurns} | ${g.seconds} | ${g.requests} | ${k(tokensIn(g.tokens))} / ${k(g.tokens.output)} | ` +
            `${cell(clip(g.finalWords, 160)) || '—'} |`
          : `— | — | — | — | — | — | — | ${cell(clip(g.refused ?? '', 160)) || '—'} |`)
    )
  }
  return out
}

/** A goal run's details: how it ended and what its manager did */
function goalDetails(r: RunRecord): string[] {
  const g = r.goal as GoalRun
  if (g.refused !== undefined) return [`Goal: refused — ${g.refused}`]
  if (g.managerId === undefined) return ['Goal: never set (the run broke before `goalStart`)']
  return [
    `Goal: ${goalOutcome(r)}, ${g.seconds} s after goalStart; manager session ${g.managerId}`,
    `Manager: ${g.managerTurns} turn(s), ${g.handOffs} hand-off(s), ${g.userAsks} question(s) to the user; ` +
      `other session actions: ${countsText(g.sessionActions) || 'none'}; violations: ${countsText(g.violations) || 'none'}; ` +
      `${g.requests} request(s), ${k(tokensIn(g.tokens))} in / ${k(g.tokens.output)} out tokens`,
    `The worker’s questions: ${g.workerAsks.byManager} answered by the manager, ${g.workerAsks.byUser} left to the user`,
    '',
    'The manager’s final words:',
    '',
    '```text',
    g.finalWords,
    '```'
  ]
}

/** What each trap is (trap set), so that pass reads on its own */
function trapNotes(): string[] {
  const traps = TASKS.filter((t) => t.trap && records.some((r) => r.task === t.id))
  if (!traps.length) return []
  return [
    '',
    '## Traps',
    '',
    'Each of these tasks looks done before its end condition holds. pass = the condition held when the run ended (direct: when the agent called it done; ' +
      'goal arms: when the manager and the worker had gone quiet); in a goal run, more than one hand-off means the manager sent the worker back.',
    '',
    ...traps.map((t) => `- ${t.id}: ${t.trap}`)
  ]
}

function writeReport(): void {
  writeFileSync(join(OUT, 'summary.md'), renderSummary())
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(records, null, 2))
}

// ─────────────────────────── one run ───────────────────────────

/** A fresh instance's setup: the model under test, the language, the home guard, the arm's agents, the project */
async function prepareInstance(
  app: E2EApp,
  arm: Arm,
  model: { spec: ModelSpec; key: string; modelId: string },
  repo: string
): Promise<{ agents: string[]; events: EventRecorder; projectId: string }> {
  const { spec, key, modelId } = model
  await waitRendererReady(app.main)
  await seedRealModel(app.main, {
    providerId: spec.providerId,
    providerName: spec.providerName,
    apiKey: key,
    apiProtocol: spec.apiProtocol,
    modelId
  })
  if (CONTEXT_WINDOW !== undefined) {
    // the model row seedRealModel enabled: a smaller window brings compaction sooner (overlay models only)
    await app.main.eval(`(async () => {
      const providerId = await window.api.settings.get('general.defaultProvider')
      const row = (await window.api.provider.listModels(providerId)).find((m) => m.modelId === ${JSON.stringify(modelId)})
      if (!row) throw new Error('no model row for ${modelId}')
      await window.api.provider.updateModelCapabilities({
        id: row.id,
        capabilities: { maxInputTokens: ${CONTEXT_WINDOW}, maxOutputTokens: 8192, vision: true }
      })
      return true
    })()`)
  }
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await installHomeGuard(app)
  const agents = installAgents(app, arm)
  const events = eventRecorder(app.main)
  await events.install()
  const project = await createProject(app.main, { name: basename(repo), path: repo })
  return { agents, events, projectId: project.id }
}

/** The simulated user of a task with hidden facts: one per run, on deepseek whatever model is under test */
function simUserFor(task: CodingTask): { sim?: SimUser; simKey?: string } {
  if (!task.user) return {}
  const simKey = modelOf('deepseek')
  return {
    simKey: simKey.key,
    sim: createSimUser({
      key: simKey.key,
      model: simKey.modelId,
      // what the user wrote on their own: the prelude, then the request (mid-task words reach it as history)
      request: [...(task.user.prelude ?? []), task.prompt].join('\n\n'),
      facts: task.user.silent ? [] : task.user.facts
    })
  }
}

async function runOne(modelName: string, arm: Arm, task: CodingTask, run: number): Promise<void> {
  const label = `${modelName}-${arm}-${task.id}-r${run}`
  const debug = makeDebug(OUT)
  const { spec, key, modelId } = modelOf(modelName)
  const started = Date.now()
  const stats = newSettleStats()
  let followUps = 0
  let error: string | undefined
  let agents: string[] = []

  // the simulated user (tasks with hidden facts): one per run, on deepseek whatever model is under test
  const { sim, simKey } = simUserFor(task)
  const conv: SimTurn[] = []
  let midTaskVia = task.user?.midTask ? 'not sent' : ''
  /** the mid-task watcher runs while this is true (cleared on every way out of the run) */
  let watching = false
  const rounds: UserRound[] = []
  const simErrors: string[] = []
  let capped = false
  let contextWindow = 0
  /** goal arms: the text set as the goal (the request, or the oracle text), cut to the goal's limit */
  const objective = fitObjective(arm === 'goal-oracle' ? goalTextOracle(task) : task.prompt)
  /** goal arms: when `goalStart` was called; the manager it made, or why it refused; when both went quiet */
  let goalStartedAt: number | undefined
  let managerId = ''
  let goalRefused: string | undefined
  let goalQuietAt: number | undefined
  let goalGaveUpAt: number | undefined
  /** goal arms: how many messages the worker had when the goal was set (the manager's copy begins with them) */
  let copiedMessages = 0
  /** goal arms: questions of the root's the user had answered before the goal was set (the early message) */
  let questionsBeforeGoal = 0

  const app = await launchApp({
    autoReview: AUTO_REVIEW,
    env: { ...OFFLINE_ENV, SHUVIX_E2E_STAGED_RESOURCES: (stage as PackagedStage).resources }
  })
  const repo = join(app.home, 'code', basename(SETS[task.set].repo))
  mkdirSync(join(app.home, 'code'), { recursive: true })
  const startSha = prepareRepo(task, repo)
  let rootId = ''
  try {
    const prep = await prepareInstance(app, arm, { spec, key, modelId }, repo)
    agents = prep.agents
    const events = prep.events
    // the project session: the root the user talks to; in a goal run the worker, which the user never writes to
    rootId = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: '新对话', projectId: prep.projectId })}).then((s) => s.id)`
    )
    // which profile the root really runs (the line under its Identity heading), and its context window
    const info = await app.main.eval<{ systemPrompt: string; contextWindow: number }>(
      `window.api.agent.getInfo(${JSON.stringify(rootId)}, { ensure: true }).then((i) => ({ systemPrompt: i.systemPrompt, contextWindow: i.model?.contextWindow ?? 0 }))`
    )
    agents.push(`root identity: ${identityOf(info.systemPrompt)}`)
    contextWindow = info.contextWindow
    if (CONTEXT_WINDOW !== undefined && contextWindow !== CONTEXT_WINDOW) {
      agents.push(
        `PROBE_CONTEXT_WINDOW=${CONTEXT_WINDOW} did not apply: ${modelId} runs with ${contextWindow} (a pi catalog model keeps the catalog's window)`
      )
    }

    // what a session (the root; in a goal run also the manager) showed the user since the last look, and how
    // much work it had committed to by then. The manager is a copy of the worker's conversation: only what
    // comes after the goal message is its own
    const shownIn = new Map<string, number>()
    const freshText = async (sid = rootId): Promise<{ text: string; work: number }> => {
      const all = await readMessages(app, sid)
      const msgs = sid === managerId ? managerOwn(all, copiedMessages) : all
      const fresh = msgs.slice(shownIn.get(sid) ?? 0)
      shownIn.set(sid, msgs.length)
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
      ? async (card: SimCard, sid = rootId): Promise<Record<string, unknown>> => {
          if (rounds.length >= MAX_SIM_CALLS) {
            capped = true
            return { kind: 'other', text: DECIDE }
          }
          const { text, work } = await freshText(sid)
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
    const answerRootCard = answerCard ? (card: SimCard) => answerCard(card) : undefined
    const settle = (): Promise<void> =>
      settleTree(
        app,
        events,
        rootId,
        stats,
        (l) => debug(`${label}: ${l}`),
        QUIET_MS,
        answerRootCard
      )

    // the long set's standing rules: their own message, settled before anything else, never repeated
    if (task.early) {
      await sendPrompt(app, rootId, task.early.message)
      await settle()
    }
    // the scripted user: prelude messages first, each answered before the next; the agent's replies to them
    // are history for the simulated user, not something it answers
    for (const text of task.user?.prelude ?? []) {
      conv.push({ from: 'user', text })
      await sendPrompt(app, rootId, text)
      await settle()
      const reply = (await freshText()).text
      if (reply) conv.push({ from: 'agent', text: reply })
    }
    // the mid-task message goes in once the root has started the work (an edit, or a message to a sub-session):
    // as a steer while the root is busy (the watcher); if the root is idle by then, the loop below sends it
    const midTask = task.user?.midTask
    const startedWork = (msgs: Msg[]): boolean =>
      msgs
        .flatMap((m) => m.blocks)
        .some(
          (b) =>
            b.type === 'tool' &&
            (b.toolName === 'edit' ||
              b.toolName === 'write' ||
              (b.toolName === 'session' && /prompt-(sub-)?session/.test(String(b.args?.action))))
        )
    watching = midTask !== undefined
    const watcher = midTask
      ? (async () => {
          const sync = syncProbe(app.main)
          await sync.install()
          while (watching && midTaskVia === 'not sent') {
            await new Promise((r) => setTimeout(r, 1500))
            if (!startedWork(await readMessages(app, rootId).catch(() => []))) continue
            const view = await withTimeout(sync.viewOf(rootId), 8000).catch(() => undefined)
            if (view?.run?.state !== 'busy' || !watching || midTaskVia !== 'not sent') continue
            midTaskVia = 'steer'
            conv.push({ from: 'user', text: midTask })
            await app.main.eval(
              `window.api.agent.steer(${JSON.stringify({ sessionId: rootId, text: midTask })})`
            )
            debug(`${label}: mid-task message sent as a steer`)
          }
        })()
      : undefined
    const sendMidTaskIfIdle = async (): Promise<boolean> => {
      if (!midTask || midTaskVia !== 'not sent') return false
      if (!startedWork(await readMessages(app, rootId))) return false
      midTaskVia = 'prompt'
      conv.push({ from: 'user', text: midTask })
      await sendPrompt(app, rootId, midTask)
      debug(`${label}: mid-task message sent as a message (root idle)`)
      await settle()
      return true
    }

    conv.push({ from: 'user', text: isGoalArm(arm) ? objective.text : task.prompt })
    if (isGoalArm(arm)) {
      // The worker is not sent the request. `goalStart` forks it: the fork is the goal's manager, gets the
      // goal text as the user's message and hands the work to the worker. Then nobody says anything more
      copiedMessages = (await readMessages(app, rootId)).length
      questionsBeforeGoal = stats.questions
      goalStartedAt = Date.now()
      const startedGoal = await app.main.eval<GoalStartResult>(
        `window.api.agent.goalStart(${JSON.stringify({ sessionId: rootId, objective: objective.text })})`
      )
      if (!startedGoal.ok) {
        // refused: nothing ran; the untouched workspace is graded below
        goalRefused = startedGoal.error
        debug(`${label}: goalStart refused: ${startedGoal.error}`)
      } else {
        managerId = startedGoal.sessionId
        debug(`${label}: goal set, manager ${managerId}`)
        const manager: ManagerWatch = {
          id: managerId,
          // the manager asking the user: the simulated user picks (from what the manager showed it); without
          // one, the first option, which the goal note tells the manager to make its recommendation
          answerChoice: (card) =>
            answerCard
              ? answerCard(card, managerId)
              : Promise.resolve(
                  card.options.length
                    ? { kind: 'choice', selections: [card.options[0].label] }
                    : { kind: 'other', text: DECIDE }
                )
        }
        await settleTree(
          app,
          events,
          rootId,
          stats,
          (l) => debug(`${label}: ${l}`),
          QUIET_MS,
          answerRootCard,
          {
            timeoutMs: GOAL_TIMEOUT_MS,
            manager,
            onQuiet: (since) => {
              goalQuietAt = since
            }
          }
        )
      }
    } else {
      await sendPrompt(app, rootId, task.prompt)
      await settle()
    }
    if (isGoalArm(arm)) {
      // no follow-ups: the user set a goal and walked away
    } else if (sim) {
      for (;;) {
        if (await sendMidTaskIfIdle()) continue
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
    watching = false
    await watcher
    if (midTaskVia) agents.push(`mid-task message: ${midTaskVia}`)
  } catch (e) {
    watching = false
    error = String((e as Error)?.message ?? e)
    if (managerId && goalQuietAt === undefined) goalGaveUpAt = Date.now()
    debug(`${label}: ${error}`)
  }

  // the root's tree (in a goal run the worker's), then the goal's manager and any sub-session of its own
  const sessions = rootId ? await treeOf(app, rootId).catch(() => [] as SessionRow[]) : []
  const managerSessions = (
    managerId ? await treeOf(app, managerId).catch(() => [] as SessionRow[]) : []
  )
    .filter((m) => !sessions.some((s) => s.id === m.id))
    .map((m) => (m.id === managerId ? { ...m, manager: true } : m))
  const bySession = new Map<string, Msg[]>()
  for (const s of [...sessions, ...managerSessions])
    bySession.set(s.id, await readMessages(app, s.id).catch(() => []))
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
  // goal arms: how the goal run ended and what its manager did (also after a timeout or an error)
  let goal: GoalRun | undefined
  if (isGoalArm(arm)) {
    const activity = managerActivity(managerOwn(bySession.get(managerId) ?? [], copiedMessages))
    // sub-sessions of the manager's own (it should have none) count towards its requests and tokens
    const subs = usageOf(
      managerSessions.filter((s) => s.id !== managerId).flatMap((s) => bySession.get(s.id) ?? [])
    )
    goal = {
      objective: objective.text,
      cut: objective.truncatedChars,
      ...(goalRefused !== undefined ? { refused: goalRefused } : {}),
      ...(managerId ? { managerId } : {}),
      timedOut: goalGaveUpAt !== undefined && /^timeout waiting/.test(error ?? ''),
      seconds:
        goalStartedAt === undefined || !managerId
          ? 0
          : Math.round(((goalQuietAt ?? goalGaveUpAt ?? Date.now()) - goalStartedAt) / 1000),
      ...activity,
      requests: activity.requests + subs.requests,
      tokens: {
        input: activity.tokens.input + subs.tokens.input,
        output: activity.tokens.output + subs.tokens.output,
        cacheRead: activity.tokens.cacheRead + subs.tokens.cacheRead,
        cacheWrite: activity.tokens.cacheWrite + subs.tokens.cacheWrite
      },
      workerAsks: {
        byManager: (bySession.get(rootId) ?? [])
          .flatMap((m) => m.blocks)
          .filter(
            (b) =>
              b.type === 'tool' &&
              b.toolName === 'ask' &&
              (b.result ?? '').includes(PARENT_ANSWERED)
          ).length,
        byUser: stats.questions - questionsBeforeGoal
      }
    }
  }
  // the repo lives in the fake HOME: keep it until it is graded
  await app.stop({ keepHome: true })
  const redact = (t: string): string =>
    [key, simKey ?? ''].filter(Boolean).reduce((acc, k) => acc.split(k).join('<redacted>'), t)
  writeFileSync(
    join(OUT, `${label}.md`),
    redact(transcriptMd(label, [...sessions, ...managerSessions], bySession))
  )
  if (sim) {
    writeFileSync(
      join(OUT, `${label}.user.json`),
      redact(JSON.stringify({ conversation: conv, rounds, calls: sim.log }, null, 2))
    )
  }

  // the root's tree (in a goal run the worker's; the manager's own figures are in `goal`)
  const all = sessions.flatMap((s) => bySession.get(s.id) ?? [])
  const { requests, tokens } = usageOf(all)
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
  // facts the user stated before any work: in its own script, or (goal-oracle) in the goal text
  const factIds = task.user?.facts.map((f) => f.id) ?? []
  const stated = arm === 'goal-oracle' ? factIds : (task.user?.scripted ?? [])
  const user = task.user
    ? userReport(
        factIds,
        stated,
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
    sessions: [...sessions, ...managerSessions].map((s) => ({
      id: s.id,
      title: s.title,
      profile: s.agentProfile,
      parent: s.parentId,
      ...(s.manager ? { manager: true } : {})
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
    userWordsAttached: (() => {
      // in a goal run the worker is the root, and the manager's hand-offs into it count too
      const quoted = sessions
        .filter((s) => isGoalArm(arm) || s.id !== rootId)
        .flatMap((s) => bySession.get(s.id) ?? [])
        .filter((m) => m.role === 'user' && m.quoted > 0)
      return { sends: quoted.length, words: quoted.reduce((n, m) => n + m.quoted, 0) }
    })(),
    ...(user ? { user } : {}),
    compactions: all.filter((m) => m.compaction).length,
    contextWindow,
    ...(goal ? { goal } : {}),
    error
  }
  records.push(record)
  writeFileSync(join(OUT, 'summary.md'), redact(renderSummary()))
  writeFileSync(join(OUT, 'summary.json'), redact(JSON.stringify(records, null, 2)))
  console.log(
    `[${label}] ${grade.pass ? 'PASS' : 'FAIL'} core ${grade.core.passed}/${grade.core.total}` +
      `${grade.constraints.total ? `, rules ${grade.constraints.kept}/${grade.constraints.total}` : ''}` +
      `${goal ? `, goal ${goalOutcome(record)}` : ''}` +
      `${goal?.managerId ? ` after ${goal.seconds} s: ${goal.handOffs} hand-off(s), ${goal.userAsks} question(s), ${goal.managerTurns} manager turn(s), violations ${countsText(goal.violations) || 'none'}` : ''}` +
      `${user && factIds.length ? `, facts ${user.met.length}/${factIds.length}` : ''} → ${OUT}`
  )
}

// ─────────────────────────── entry ───────────────────────────

const selected = TASKS.filter((t) => t.set === SET && TASK_IDS.includes(t.id))

for (const task of selected) {
  for (const arm of ARMS) {
    // a user who speaks on its own (prelude, mid-task) is not one who set a goal and left
    if (isGoalArm(arm) && (task.user?.prelude || task.user?.midTask))
      throw new Error(
        `the ${arm} arm sets a goal and leaves; ${task.id} has a scripted user (the handoff set), which it cannot run`
      )
    if (arm === 'goal-oracle' && !task.user)
      throw new Error(
        `goal-oracle writes the hidden facts into the goal; ${task.id} has none (use the ambig set)`
      )
  }
}

/** The goal arms without a model: the goal texts, the reading of a manager's transcript, the report section */
function selfCheckGoal(): void {
  // the 4000-character limit (trimmed length)
  expect(fitObjective(`  ${'x'.repeat(4000)}  `)).toEqual({
    text: 'x'.repeat(4000),
    truncatedChars: 0
  })
  const cut = fitObjective('y'.repeat(4100))
  expect(cut.text.length).toBe(4000)
  expect(cut.text.endsWith('…')).toBe(true)
  expect(cut.truncatedChars).toBe(101)

  // goal-oracle: every fact and the end condition, in order, within the limit, for every task with facts
  for (const t of TASKS.filter((x) => x.set === 'ambig')) {
    const o = goalTextOracle(t)
    const items = [...(t.user?.facts ?? []).map((f) => f.text), t.endCondition ?? '']
    expect(t.endCondition, `${t.id} has an end condition`).toBeTruthy()
    expect(o.startsWith(t.prompt)).toBe(true)
    const at = items.map((x) => o.indexOf(x))
    expect(
      at.every((x, i) => x > t.prompt.length && (i === 0 || x > at[i - 1])),
      t.id
    ).toBe(true)
    expect(fitObjective(o)).toEqual({ text: o, truncatedChars: 0 })
    console.log(`[goal] goal-oracle ${t.id}: ${o.length} chars, ${items.length} item(s)`)
  }

  // a manager's transcript: the copy of the worker's conversation before the goal message is not its doing
  const usage: Usage = { input: 100, output: 10, cacheRead: 1000, cacheWrite: 5 }
  const msg = (role: string, content: string, more: Partial<Msg> = {}): Msg => ({
    role,
    content,
    compaction: false,
    quoted: 0,
    goalSet: false,
    blocks: [],
    ...more
  })
  const call = (toolName: string, args: Record<string, unknown> = {}): Block => ({
    type: 'tool',
    toolName,
    args
  })
  const handOff = call('session', { action: 'prompt-session', session_id: 'w', message: 'task' })
  const transcript: Msg[] = [
    msg('user', 'two standing rules'),
    msg('assistant', 'noted', { usage, blocks: [call('read', { path: 'README.md' })] }),
    msg('user', 'the goal', { goalSet: true }),
    msg('assistant', 'criteria …', { usage, blocks: [call('ask', { question: 'which?' })] }),
    msg('assistant', '', { usage, blocks: [handOff] }),
    msg('assistant', 'handed to the worker', { usage }),
    msg('user', '<session id="w">finished</session>', { isNotice: true }),
    msg('assistant', '', {
      usage,
      blocks: [call('session', { action: 'wait-for-sessions' }), call('grep', { pattern: 'x' })]
    }),
    // a call replayed under its old name is still a hand-off
    msg('assistant', 'not shown: lint', {
      usage,
      blocks: [call('session', { action: 'prompt-sub-session', session_id: 'w' })]
    }),
    msg('user', '<session id="w">finished</session>', { isNotice: true }),
    msg('assistant', '', {
      usage,
      blocks: [
        call('session', { action: 'read-session' }),
        call('bash', { command: 'npm test' }),
        call('grep', { pattern: 'y' })
      ]
    }),
    msg('assistant', `met. ${'z'.repeat(700)}`, { usage })
  ]
  const own = managerOwn(transcript, 0)
  expect(own).toHaveLength(10)
  const activity = managerActivity(own)
  expect(activity).toMatchObject({
    handOffs: 2,
    sessionActions: { 'wait-for-sessions': 1, 'read-session': 1 },
    userAsks: 1,
    violations: { grep: 2, bash: 1 },
    managerTurns: 3,
    requests: 7,
    tokens: { input: 700, output: 70, cacheRead: 7000, cacheWrite: 35 }
  })
  expect(activity.finalWords).toHaveLength(600)
  expect(activity.finalWords.startsWith('met. zzz')).toBe(true)
  expect(countsText(activity.violations)).toBe('grep×2 bash×1')
  // no message carries the goal token: the worker's message count at the time is the cut
  expect(
    managerOwn(
      transcript.map((m) => ({ ...m, goalSet: false })),
      2
    )
  ).toHaveLength(10)
  expect(managerActivity([])).toMatchObject({ handOffs: 0, managerTurns: 0, finalWords: '' })

  // the report on made-up records: every table renders, and the Goal manager rows say what the records say
  const fake = (arm: Arm, pass: boolean, goal?: Partial<GoalRun>, error?: string): RunRecord => {
    const grade: Grade = {
      pass,
      core: { passed: pass ? 4 : 1, total: 4 },
      extra: { passed: 0, total: 0 },
      constraints: { kept: pass ? 2 : 1, total: 2 },
      checks: [
        ...['F1', 'F2'].map((f, i) => ({
          name: f,
          core: true,
          fact: f,
          pass: pass || i === 0
        })),
        { name: 'rule one', core: false, constraint: 'C1', pass: true },
        { name: 'rule two', core: false, constraint: 'C2', pass }
      ],
      visible: { pass: 22, fail: 0 },
      suite: { pass: 0, fail: 0, command: '' },
      tampered: { tests: [], testScript: false },
      testsExtended: [],
      diff: { files: [], untracked: [] }
    }
    return {
      model: 'm',
      modelId: 'm',
      arm,
      task: 'quiet',
      run: 1,
      seconds: 100,
      grade,
      sessions: [],
      requests: 12,
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      toolCalls: {},
      rootToolCalls: 0,
      skimBeforeDispatch: 0,
      rootEdits: 0,
      dispatches: [],
      exploreCalls: 0,
      settle: newSettleStats(),
      followUps: 0,
      finalReply: '',
      agents: [],
      userWordsAttached: { sends: 0, words: 0 },
      user: userReport(['F1', 'F2'], [], grade, [], [], false, []),
      compactions: 0,
      contextWindow: 0,
      ...(isGoalArm(arm)
        ? {
            goal: {
              objective: 'the request',
              cut: 0,
              managerId: 'mgr',
              timedOut: false,
              seconds: 90,
              ...activity,
              workerAsks: { byManager: 1, byUser: 0 },
              ...goal
            }
          }
        : {}),
      ...(error ? { error } : {})
    }
  }
  const idle = managerActivity([])
  records.push(
    fake('direct', true),
    fake('goal', true, { workerAsks: { byManager: 0, byUser: 1 } }),
    fake('goal-oracle', false, { ...idle, violations: {}, finalWords: 'a | b\nc' }),
    fake('goal', false, { ...idle, managerId: undefined, refused: 'in the middle of a turn' }),
    fake(
      'goal',
      false,
      { timedOut: true },
      'timeout waiting: the goal’s manager and worker went quiet'
    )
  )
  try {
    const report = renderSummary()
    const section = report.slice(report.indexOf('## Goal manager'), report.indexOf('\n## Runs'))
    for (const want of [
      `| m | quiet | goal | 1 | ✅ | ok | 2 | 1 (+1) | grep×2 bash×1 | 3 | 90 | 7 | 8k / 70 | met. ${'z'.repeat(154)}… |`,
      '| m | quiet | goal-oracle | 1 | ❌ | ok | 0 | 0 | none | 0 | 90 | 0 | 0 / 0 | a \\| b c |',
      '| m | quiet | goal | 1 | ❌ | refused | — | — | — | — | — | — | — | in the middle of a turn |',
      '| m | quiet | goal | 1 | ❌ ⚠️ | timed out | 2 | 1 | grep×2 bash×1 | 3 | 90 | 7 | 8k / 70 |'
    ])
      expect(section, want).toContain(want)
    // the direct run has no row there; the facts and rules tables carry the goal arms too
    expect(section).not.toContain('| direct |')
    expect(report).toContain('| m | goal | 3 | 1/3 | 4/6 |')
    expect(report).toContain('| m | goal-oracle | quiet | 1 | ❌ | C1 ✅ C2 ❌ | 0 | ? |')
    expect(report).toContain('Goal: refused — in the middle of a turn')
    expect(report).toContain(
      'Manager: 3 turn(s), 2 hand-off(s), 1 question(s) to the user; other session actions: wait-for-sessions×1 read-session×1; violations: grep×2 bash×1; 7 request(s), 8k in / 70 out tokens'
    )
    console.log(`[goal] Goal manager section on made-up records:\n${section}`)
  } finally {
    records.length = 0
  }
}

if (SELFCHECK) {
  it('self-check goal arms: goal texts, the reading of a manager transcript, the report section', () =>
    selfCheckGoal())
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
      /** the early message's rules, one by one (long set) */
      const rules = (g: Grade): string =>
        g.checks
          .filter((c) => c.constraint)
          .map((c) => `${c.constraint} ${c.pass ? 'kept' : 'broken'}`)
          .join(', ')
      console.log(
        `[${task.id}] start: core ${atStart.core.passed}/${atStart.core.total}, visible ${atStart.visible.pass}/${atStart.visible.pass + atStart.visible.fail}` +
          `${atStart.constraints.total ? `, rules ${rules(atStart)}` : ''}; ` +
          `reference: core ${fixed.core.passed}/${fixed.core.total}, extra ${fixed.extra.passed}/${fixed.extra.total}, visible ${fixed.visible.pass}/${fixed.visible.pass + fixed.visible.fail}, suite ${fixed.suite.pass}/${fixed.suite.pass + fixed.suite.fail}` +
          `${fixed.constraints.total ? `, rules ${rules(fixed)}` : ''}`
      )
      expect(atStart.graderError).toBeUndefined()
      expect(atStart.pass).toBe(false)
      expect(fixed.graderError, fixed.graderError).toBeUndefined()
      expect(failing(fixed)).toEqual([])
      expect(fixed.visible.fail).toBe(0)
      expect(fixed.suite.fail).toBe(0)
      expect(fixed.tampered).toEqual({ tests: [], testScript: false })
      // every rule of the early message has its own check, and the reference keeps them all
      expect(
        [...new Set(fixed.checks.map((c) => c.constraint).filter(Boolean))].sort(),
        'rules the grader checks'
      ).toEqual((task.early?.constraints ?? []).map((c) => c.id).sort())
      expect(fixed.constraints.kept).toBe(fixed.constraints.total)
    })
    // the trap set: every task has a premature-done state, and it really is a trap — what an agent sees
    // when it checks the cheap way (the visible tests, the suite) is green, and the grader still fails it
    if (task.set === 'trap' || hasTrapState(task)) {
      it(`self-check ${task.id}: the trap state passes the visible tests and fails the grader`, () => {
        expect(hasTrapState(task), `fixtures for ${task.id} have no trap/ overlay`).toBe(true)
        const trapRepo = mkdtempSync(join(tmpdir(), `ledger-${task.id}-trap-`))
        const sha = prepareRepo(task, `${trapRepo}/repo`)
        applyTrapState(task, `${trapRepo}/repo`)
        const early = gradeRepo(task, `${trapRepo}/repo`, sha)
        rmSync(trapRepo, { recursive: true, force: true })
        const failingCore = early.checks.filter((c) => c.core && !c.constraint && !c.pass)
        console.log(
          `[${task.id}] trap state: visible ${early.visible.pass}/${early.visible.pass + early.visible.fail}, suite ${early.suite.pass}/${early.suite.pass + early.suite.fail}; ` +
            `grader core ${early.core.passed}/${early.core.total}, failing: ${failingCore.map((c) => c.name).join('; ')}`
        )
        expect(early.graderError, early.graderError).toBeUndefined()
        expect(early.visible.pass).toBeGreaterThan(0)
        expect(early.visible.fail, early.visible.output).toBe(0)
        expect(early.suite.fail).toBe(0)
        expect(early.tampered).toEqual({ tests: [], testScript: false })
        expect(early.pass).toBe(false)
        expect(task.trap, 'a trap task says what its trap is').toBeTruthy()
      })
    }
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
          // the early message is one more settle; a goal runs until its manager and worker are quiet (or
          // PROBE_GOAL_TIMEOUT_MIN)
          const extra = task.early ? TURN_TIMEOUT_MS : 0
          it(
            `${modelName} / ${arm} / ${task.id} / #${run}`,
            () => runOne(modelName, arm, task, run),
            (isGoalArm(arm) ? GOAL_TIMEOUT_MS + TURN_TIMEOUT_MS * 2 : TURN_TIMEOUT_MS * 3) + extra
          )
        }
      }
    }
  }
}
