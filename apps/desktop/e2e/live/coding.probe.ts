/**
 * Coding probe: real models do real (small) programming tasks in ShuviX, and a hidden grader scores the result.
 * Nothing is asserted; the output is a report. It exists to answer questions such as "does handing work from
 * `work` to a `coding` sub-session help or hurt?" and "does this coding.md draft beat today's?" with numbers
 * instead of feel.
 *
 * Tasks: `coding/tasks.ts` — six sets on two Node repos (graders and reference solutions in
 * `coding/fixtures`). `PROBE_SET=hard` (default), `easy`, `ambig`, `handoff`, `long` or `trap` (or `s1`, below);
 * easy and hard are at ceiling for deepseek and kimi. The ambig set's requests leave out what only the user knows: a simulated user
 * (`coding/simUser.ts`, on deepseek whatever model is under test) holds those facts and answers the root's
 * questions, plain-text or ask cards, and the report adds what it cost the user (turns, questions, how many
 * touched a fact, text to read), which facts were given before the agent called it done, and which facts were
 * given but not met. The handoff set states every fact where a hand-off can drop it. The long set (three
 * multi-layer features, each ending in "npm test passes, including test/<task>.test.js") is for goal mode: the
 * user first sends a message of two standing rules, settled before the request and never repeated, and the
 * grader checks each rule apart from the task (`constraint` C1, C2) — does a rule said only early in the
 * conversation survive a long run and its compactions? The trap set (four goal-style requests with a stated,
 * checkable end condition) is built so that the cheapest check looks green before the condition is met: a
 * second command the start already fails (`avgcost`: lint), a sweeping rename the tests cover in part
 * (`quantity`), parts of a feature the tests never touch (`tags`), a verification script the request names
 * (`leadtime`: `npm run smoke`). It measures how often an agent declares done too early, and in the goal arm
 * whether the judge catches it.
 *
 * Arms (`PROBE_ARMS`, comma-separated; default `direct,goal` for the long and trap sets, `goal,goal-oracle,
 * goal-shaped` for s1, `direct,work` otherwise):
 *   direct  the user talks to the coding agent itself: the project session's base profile is replaced by the
 *           coding md (a user-level `work.md` built from it)
 *   work    today's product: the project session runs `work`, which hands the job to a `coding` sub-session
 *   goal    as direct, but the request is set as a goal (`agent.goalAct` set, objective = the request; the host
 *           sends it as the user's message) and the run lasts until the goal ends: met, impossible or paused,
 *           with no verdict pending. No "go ahead" follow-ups: the user set a goal and walked away. Ask cards
 *           are answered as in the other arms (on ambig by the simulated user, with its facts), but nobody
 *           reads the completion report or corrects anything. Not for the handoff set (its user speaks on its
 *           own: prelude, mid-task).
 *           Graded twice: at the end, and as the judge first saw it. The probe records the root's `goal`
 *           events in the renderer; the moment the first check begins (`judging: true`, with a fallback poll
 *           of `agent.goal`) it copies the repo, .git included. That is the state the judge judges: the run
 *           has ended, the session is idle (the host does not judge while background work runs), the judge
 *           only reads, and the host starts a continuation only after the verdict is stored. The copy counts
 *           as sound unless a not_met verdict had already landed when it finished (then a continuation could
 *           have begun editing; it is reported, not dropped). The copy is graded after the run.
 *   goal-oracle  as goal, set and leave, but the goal text is the request plus every hidden fact as an
 *           explicit "done when" list, then the request's own end condition (`goalDraft.ts` goalTextOracle,
 *           `endCondition` in tasks.ts): the upper bound of what a goal can hold. Tasks with a simulated
 *           user only (ambig).
 *   goal-shaped  the S1 prototype of the goal spec-shaping proposal (reports/Goal 验收规格展开调研.md), probe
 *           side only. Before the goal, the goal planner (`coding/md/goal-planner.md`: read, ls, grep, glob,
 *           no ask, thinking declared in the md) runs as the root of a throwaway session on the same
 *           project: while it is created and runs, the user-level `work.md` is the planner (plus
 *           `goal-planner.md` itself); both are swapped back to the coding md before the working session
 *           exists, so the working agent never sees the planner (S3: host-dispatched). The planner's
 *           thinking level is set on its session from the md (`shuvix-thinking`; a root session does not
 *           read it from the profile). Its permission asks are refused (fail closed, S4). Its input is the
 *           request alone; for a task with an early message (long), that message comes first inside
 *           `<earlier-user-words>` (S11: the user's words in the session). Its last message must end with a
 *           JSON block (S5: verdict ready | shape, criteria ≤ 8 with proofs, decisions ≤ 3, assumptions ≤ 5,
 *           nonGoals ≤ 5); a missing or invalid block is `planner-error` and the goal is the request alone.
 *           ready → the goal is the request alone. shape → the simulated user reviews the draft once
 *           (`simUser.ts` review mode: answers each decision, a fact where one settles it; rewrites what
 *           contradicts a fact; adds a fact only where an item touches its point), or, for a task without
 *           hidden facts, the draft is accepted as it is with each decision's recommended option; the goal
 *           is the request + the accepted draft (`goalTextShaped`, S6 order: decisions, assumptions, done
 *           when, do not touch), cut to 4000 characters (cuts reported). Then set and leave, as goal.
 *   planner the planner step of goal-shaped alone (planner, then the review): no working session, no goal,
 *           not graded. For the controls of s1 and for iterating on the planner md cheaply.
 * `PROBE_SET=s1` (measurement S1): the ambig set's four tasks with hidden facts in `PROBE_ARMS` (default
 * goal, goal-oracle, goal-shaped; add direct for the present-user baseline), and the controls — catval, the
 * three long and the four trap tasks — in the planner arm (`PROBE_S1_CONTROLS=full`: goal-shaped, a full goal
 * run each). `PROBE_PLANNER_MD` points at another planner draft (else `goal-planner.md` from `PROBE_MD_DIR`,
 * else `coding/md/goal-planner.md`); `PROBE_PLANNER_TIMEOUT_MIN` (default 10) bounds the planner's run.
 * `PROBE_MD_DIR` points at a folder of md drafts (`coding.md`, `work.md`, …) installed as user-level agents in
 * every arm (a `goal-planner.md` there is only the planner's source); `direct` and the goal arms then build
 * their `work.md` from that `coding.md`. Compare drafts by running twice with different `PROBE_MD_DIR` /
 * `PROBE_OUT`.
 *
 * Other knobs: `PROBE_MODELS` (deepseek, kimi, anthropic, openai — keys from ~/.shuvix-probe.env), `PROBE_TASKS`,
 * `PROBE_RUNS` (repeats of each model × arm × task), `PROBE_LANG` (default zh), `PROBE_AUTO_REVIEW=1` (let the
 * product's reviewer answer permission asks instead of the probe, in every arm), `PROBE_OUT` (report folder).
 * Goal arm: `PROBE_GOAL_TIMEOUT_MIN` (default 120: the probe gives up on a goal that has not ended by then),
 * `PROBE_GOAL_TURNS` (continuations) sets the goal's turn limit; unset, the product's default applies (50).
 * `PROBE_CONTEXT_WINDOW=<tokens>` writes that window into the model row's capabilities so compaction comes
 * sooner. It only takes effect for a model id outside pi's catalog (an overlay row): catalog models keep the
 * catalog's window (deepseek-flash, deepseek-v4-pro and kimi-for-coding are 1M). The report shows the window
 * each run really had and how many compactions happened, so a run where it did not apply is visible.
 * `PROBE_SELFCHECK=1` runs no model: it checks that every task's start state fails its grader and its reference
 * solution passes, the early message's rules included (printed apart); for a task with a `trap/` overlay (the
 * trap set's plausible premature-done state) also that it passes the visible tests and the suite yet fails
 * the grader, so each trap is real. For every set it also checks the goal-shaped machinery without a model:
 * the planner md parses as an agent with the tools above, the planner-answer parser (fences, limits, bad
 * answers), the review parser, applying a review, the renderers and the 4000-character cut, and every
 * goal-oracle text.
 *
 * Report (`summary.md`, `summary.json`): per model × arm and per run, pass / core / visible tests / tampering /
 * tokens / requests / seconds / hand-offs. When a run has rules or a goal, "Goals, rules and compaction" adds:
 * rules kept (C1, C2 per run), compactions, the root's context window, and for the goal arm the final
 * status, pause reason, continuations (`turns`), wall time from setting the goal to its end, and the judge's
 * last verdict with its reason (each not-met reason on the way is in the run's details).
 * "Trap: declared done vs the end condition" (whenever a goal run has a first check, and for
 * the trap set): per model × arm, direct runs that stopped short (the state the agent declared done fails the
 * grader), and for goal runs the grade at the first check against the first verdict — clean (passes, met),
 * caught (fails, not_met, the final state passes), caught-not-fixed (fails, not_met, final fails), false-met
 * (fails, met), over-strict (passes, not_met) — with continuations and seconds; per run the first
 * verdict's reason and the core checks the first state failed.
 * "S1: does shaping recover what a vague goal loses?" (whenever a run is in goal-oracle, goal-shaped or
 * planner): per model × arm on the tasks with hidden facts — facts met (all and per task), pass, first-check
 * classes, continuations, seconds; for goal-shaped and planner the planner's verdicts, decisions that
 * touched a fact vs noise, facts in the accepted text before work (and how they got there), planner seconds
 * (median); the controls' ready rate and decisions; then the four S1 thresholds evaluated:
 * (i) goal meets fewer facts than goal-oracle; (ii) goal-shaped recovers at least half of that gap; (iii) the
 * planner says ready on at least 6/7 of control runs (the proposal counts 7 controls; there are 8: catval,
 * 3 long, 4 trap, so it is applied as a rate) with at most 1 decision per control run on average;
 * (iv) the median planner time is at most 90 s. Rates, not sums, so arms with failed runs still compare.
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
 *   PROBE_SELFCHECK=1 PROBE_SET=trap npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SET=s1 PROBE_MODELS=deepseek,kimi PROBE_RUNS=2 PROBE_GOAL_TIMEOUT_MIN=60 \
 *     npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
 *   PROBE_SET=ambig PROBE_TASKS=quiet PROBE_ARMS=planner PROBE_PLANNER_MD=/tmp/goal-planner.md \
 *     npx vitest run --config vitest.config.probe.ts e2e/live/coding.probe.ts
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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GoalActResult,
  GoalLimits,
  GoalStatus,
  GoalVerdictKind,
  GoalVerdictRecord,
  GoalView
} from '@shuvix/chat-protocol/types/goal'
import { parseAgentDefinitionFile } from '@shuvix/agent-runtime'
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
import {
  applyReview,
  DRAFT_LIMITS,
  extractJson,
  fitObjective,
  goalTextOracle,
  goalTextShaped,
  parsePlannerAnswer,
  reviewText,
  type AppliedReview,
  type DraftReview,
  type FactEntry,
  type PlannerDraft
} from './coding/goalDraft'
import {
  applyReference,
  applyTrapState,
  gradeRepo,
  hasTrapState,
  prepareRepo,
  snapshotRepo,
  type Grade
} from './coding/workspace'
import {
  createSimUser,
  parseReview,
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
/** `s1`: measurement S1 — the ambig set's tasks with hidden facts, plus the shaping controls (see the header) */
const SET = (process.env.PROBE_SET ?? 'hard') as SetId | 's1'
if (SET !== 's1' && !SETS[SET])
  throw new Error(`PROBE_SET must be one of ${Object.keys(SETS).join(', ')}, s1; got ${SET}`)
const S1_SETS: SetId[] = ['ambig', 'long', 'trap']
const inSet = (t: CodingTask): boolean => (SET === 's1' ? S1_SETS.includes(t.set) : t.set === SET)
const ARMS = list(
  process.env.PROBE_ARMS,
  SET === 'long' || SET === 'trap'
    ? 'direct,goal'
    : SET === 's1'
      ? 'goal,goal-oracle,goal-shaped'
      : 'direct,work'
) as Arm[]
const ALL_ARMS: Arm[] = ['direct', 'work', 'goal', 'goal-oracle', 'goal-shaped', 'planner']
for (const arm of ARMS) {
  if (!ALL_ARMS.includes(arm))
    throw new Error(`PROBE_ARMS takes ${ALL_ARMS.join(', ')}; got ${arm}`)
}
/** s1: the controls run the planner alone (`planner`), or a full goal-shaped run each (`full`) */
const S1_CONTROLS = process.env.PROBE_S1_CONTROLS ?? 'planner'
if (S1_CONTROLS !== 'planner' && S1_CONTROLS !== 'full')
  throw new Error(`PROBE_S1_CONTROLS takes planner or full; got ${S1_CONTROLS}`)
const TASK_IDS = list(
  process.env.PROBE_TASKS,
  TASKS.filter(inSet)
    .map((t) => t.id)
    .join(',')
)
const TURN_TIMEOUT_MS = 25 * 60 * 1000

/** a positive number from the environment, or undefined when unset */
function positiveEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number, got ${raw}`)
  return n
}
/** goal arm: the probe gives up on a goal that has not ended by then */
const GOAL_TIMEOUT_MS = (positiveEnv('PROBE_GOAL_TIMEOUT_MIN') ?? 120) * 60 * 1000
/** goal arm: limits set with the goal; what is unset takes the product's defaults */
const GOAL_LIMITS: Partial<GoalLimits> = (() => {
  const maxTurns = positiveEnv('PROBE_GOAL_TURNS')
  return maxTurns !== undefined ? { maxTurns: Math.round(maxTurns) } : {}
})()
/** goal-shaped / planner arms: the planner's run is given up after this long (the goal is then the request) */
const PLANNER_TIMEOUT_MS = (positiveEnv('PROBE_PLANNER_TIMEOUT_MIN') ?? 10) * 60 * 1000
/** the planner draft: PROBE_PLANNER_MD, else goal-planner.md in PROBE_MD_DIR, else the probe's own */
const PLANNER_MD_PATH =
  process.env.PROBE_PLANNER_MD ??
  (MD_DIR && existsSync(join(MD_DIR, 'goal-planner.md'))
    ? join(MD_DIR, 'goal-planner.md')
    : fileURLToPath(new URL('./coding/md/goal-planner.md', import.meta.url)))
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

type Arm = 'direct' | 'work' | 'goal' | 'goal-oracle' | 'goal-shaped' | 'planner'

/** the arms that set a goal and leave */
const isGoalArm = (arm: Arm): boolean =>
  arm === 'goal' || arm === 'goal-oracle' || arm === 'goal-shaped'
/** the arms that run the goal planner first */
const runsPlanner = (arm: Arm): boolean => arm === 'goal-shaped' || arm === 'planner'
/** a task whose user holds facts the request leaves out */
const hasFacts = (t: CodingTask): boolean => (t.user?.facts.length ?? 0) > 0

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
  // a goal-planner.md among the drafts is only the planner's source: the working agent must not see it
  const drafts = MD_DIR
    ? readdirSync(MD_DIR).filter((n) => n.endsWith('.md') && n !== 'goal-planner.md')
    : []
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
      blocks: (m.blocks ?? []).map((b) => b.type === 'tool'
        ? { type: 'tool', toolName: b.toolName, args: b.args, result: String(b.result ?? '').slice(0, 4000), isError: b.isError === true }
        : { type: b.type, text: b.text })
    })))
  `)

/** The session's goal as the goal bar shows it (null = no goal) */
const goalViewOf = (app: E2EApp, sid: string): Promise<GoalView | null> =>
  app.main.eval<GoalView | null>(`window.api.agent.goal(${JSON.stringify(sid)})`)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    )
  ])
}

// ─────────────────────────── goal arm: the judge's first check ───────────────────────────

/** What the renderer saw of one session's `goal` events: when the first check began, the first verdict */
interface GoalSeen {
  /** renderer clock when a view with `judging: true` first came (0 = not yet) */
  judgingAt: number
  verdict: GoalVerdictRecord | null
}

/** Record the root's `goal` events in the renderer from now on (before the goal is set) */
const installGoalRecorder = (app: E2EApp, sid: string): Promise<unknown> =>
  app.main.eval(`(() => {
    const sid = ${JSON.stringify(sid)}
    const seen = (window.__probeGoalSeen = { judgingAt: 0, verdict: null })
    window.api.agent.onEvent((e) => {
      if (e.type !== 'goal' || e.sessionId !== sid || !e.goal) return
      if (e.goal.judging && !seen.judgingAt) seen.judgingAt = Date.now()
      if (e.goal.lastVerdict && !seen.verdict) seen.verdict = e.goal.lastVerdict
    })
    return true
  })()`)

const goalSeen = (app: E2EApp): Promise<GoalSeen> =>
  app.main.eval<GoalSeen>(`window.__probeGoalSeen ?? { judgingAt: 0, verdict: null }`)

/** The repo as the judge's first check saw it (copied, graded after the run) */
interface FirstSnapshot {
  /** the copy (a `repo` folder inside a temp folder of its own) */
  path: string
  /** seconds from setting the goal to the copy */
  atSeconds: number
  /** no not_met verdict had landed when the copy finished, so no continuation could have edited it yet */
  sound: boolean
  /** how the moment was caught, and why it may be off */
  note: string
}

/**
 * Copy the repo the moment the judge's first check begins: the run has ended, the session is idle and the
 * judge only reads, and the host starts a continuation only after it has stored the verdict — so what is
 * copied is what is judged. Watches the recorded `goal` events every 200 ms, and the goal view itself every
 * 2 s in case an event went missing.
 */
function watchFirstCheck(
  app: E2EApp,
  rootId: string,
  repo: string,
  setAt: number,
  debug: (l: string) => void
): { stop: () => Promise<FirstSnapshot | undefined> } {
  let active = true
  let snap: FirstSnapshot | undefined
  const take = async (note: string): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'shuvix-first-check-'))
    const path = snapshotRepo(repo, dir)
    const after = await goalSeen(app).catch(() => undefined)
    const late = after?.verdict?.verdict === 'not_met'
    snap = {
      path,
      atSeconds: Math.round((Date.now() - setAt) / 1000),
      sound: !late,
      note: late ? `${note}; a not_met verdict had landed before the copy finished` : note
    }
    debug(`first check: repo copied (${snap.note})`)
  }
  const loop = (async () => {
    for (let polls = 1; active && !snap; polls++) {
      await new Promise((r) => setTimeout(r, 200))
      const seen = await goalSeen(app).catch(() => undefined)
      if (seen?.judgingAt) {
        await take('at judging: true')
        break
      }
      if (seen?.verdict) {
        await take('the check was missed: copied after the verdict')
        break
      }
      if (polls % 10 !== 0) continue
      const view = await withTimeout(goalViewOf(app, rootId), 8000).catch(() => undefined)
      if (view?.judging) await take('at judging: true (goal view poll)')
      else if (view?.lastVerdict)
        await take('the check was missed: copied after the verdict (goal view poll)')
    }
  })().catch((e) => debug(`first-check watcher failed: ${String(e)}`))
  return {
    stop: async () => {
      active = false
      await loop
      return snap
    }
  }
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
 * is left alone. `opts.done`: quiet is not enough, this must hold too (the goal arm: the goal has ended — a
 * verdict can be pending while the tree is quiet). `opts.refuseAsks`: refuse every permission ask (the goal
 * planner: its asks fail closed).
 */
async function settleTree(
  app: E2EApp,
  events: EventRecorder,
  rootId: string,
  stats: SettleStats,
  debug: (l: string) => void,
  quietMs = 20_000,
  answerRootChoice?: (card: SimCard) => Promise<Record<string, unknown>>,
  opts: { done?: () => Promise<boolean>; timeoutMs?: number; refuseAsks?: string } = {}
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
            if (outside || opts.refuseAsks) stats.refused++
            response = opts.refuseAsks
              ? { kind: 'ask', allowed: false, reason: opts.refuseAsks }
              : outside
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
      if (Date.now() - quietSince <= quietMs) return false
      return opts.done ? opts.done() : true
    },
    opts.done ? 'session tree went quiet and the goal ended' : 'session tree went quiet',
    opts.timeoutMs ?? TURN_TIMEOUT_MS
  )
  stats.unansweredSubQuestions = pendingSub
}

const looksLikeQuestion = (reply: string): boolean =>
  /[?？]\s*$/.test(reply.trim()) ||
  /(要不要|是否需要|需要我|你同意|同意的话|确认一下|你看可以|可以吗)/.test(reply.slice(-300))

/** the line under the system prompt's Identity heading: which profile a session really runs */
const identityOf = (systemPrompt: string): string =>
  systemPrompt.match(/^## (?:Identity|身份|アイデンティティ)\s*\n+(.+)$/m)?.[1] ?? '(not found)'

// ─────────────────────────── goal-shaped arm: the planner and the user's review ───────────────────────────

/** The goal planner's run (goal-shaped and planner arms) */
interface PlannerRun {
  /** the draft it ran from */
  md: string
  sessionId: string
  /** what it was sent: the request (after the early message, if any, in <earlier-user-words>) */
  input: string
  verdict: 'ready' | 'shape' | 'planner-error'
  error?: string
  /** contract breaches the parser mended (clipped lists, a recommended option not among the options, …) */
  violations: string[]
  draft?: PlannerDraft
  /** from sending the request to its last message */
  seconds: number
  /** as the session really ran: thinking level, tools, the identity line of its system prompt */
  thinkingLevel: string
  tools: string[]
  identity: string
  toolCalls: Record<string, number>
  /** permission asks it raised (every one refused) */
  asks: number
  finalText: string
}

/** What the user made of the planner's draft, and the goal text that came of it */
interface ShapeRecord {
  planner: PlannerRun
  /**
   * sim = the simulated user reviewed the draft; accept = accepted as it is with the recommended options (no
   * hidden facts, or the review failed); none = nothing to review (ready, planner-error, an empty draft)
   */
  reviewBy: 'sim' | 'accept' | 'none'
  reviewError?: string
  reviewSeconds: number
  review?: DraftReview
  applied?: AppliedReview
  /** the draft as the user read it */
  shown: string
  /** the goal text: goal-shaped set it; the planner arm only reports it */
  objective: string
  truncatedChars: number
}

/** the one follow-up when the planner's run ends without a draft */
const PLANNER_NUDGE =
  'Your run ended without the draft. Reply now with your final answer: exactly one fenced json block as specified, and nothing after it.'
const PLANNER_REFUSAL = 'Refused: the goal planner only reads the project.'

/**
 * The goal planner as the root of a throwaway session on the project. While that session is created and runs,
 * the user-level `work.md` is the planner (and the planner is installed as `goal-planner.md` too); afterwards
 * both are put back as they were, before the working session exists, and the session is deleted — the working
 * agent never sees the planner (S3). A root session takes its thinking level from the session, not from the
 * profile, so the md's `shuvix-thinking` is set on the session. Permission asks are refused (S4: fail closed).
 */
async function runPlanner(
  app: E2EApp,
  events: EventRecorder,
  projectId: string,
  input: string,
  debug: (l: string) => void
): Promise<{ run: PlannerRun; messages: Msg[] }> {
  const md = readFileSync(PLANNER_MD_PATH, 'utf8')
  const declared = parseAgentDefinitionFile(md, 'goal-planner')
  const run: PlannerRun = {
    md: PLANNER_MD_PATH,
    sessionId: '',
    input,
    verdict: 'planner-error',
    violations: [],
    seconds: 0,
    thinkingLevel: '',
    tools: [],
    identity: '',
    toolCalls: {},
    asks: 0,
    finalText: ''
  }
  if (!declared) {
    run.error = `${PLANNER_MD_PATH} does not parse as an agent md`
    return { run, messages: [] }
  }
  const workPath = join(app.agentsDir, 'work.md')
  const ownPath = join(app.agentsDir, 'goal-planner.md')
  const workBefore = existsSync(workPath) ? readFileSync(workPath, 'utf8') : undefined
  const stats: SettleStats = { questions: 0, permissions: 0, refused: 0, unansweredSubQuestions: 0 }
  let sentAt = 0
  let settledAt = 0
  let messages: Msg[] = []
  writeFileSync(ownPath, md)
  writeFileSync(workPath, asUserAgent(md, 'work'))
  try {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'goal planner', projectId })}).then((s) => s.id)`
    )
    run.sessionId = sid
    if (declared.thinkingLevel) {
      await app.main.eval(
        `window.api.agent.setThinkingLevel(${JSON.stringify({ sessionId: sid, level: declared.thinkingLevel })})`
      )
    }
    const info = await app.main.eval<{
      systemPrompt: string
      thinkingLevel: string
      tools: string[]
    }>(
      `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true }).then((i) => ({ systemPrompt: i.systemPrompt, thinkingLevel: i.thinkingLevel, tools: i.tools.map((t) => t.name) }))`
    )
    run.identity = identityOf(info.systemPrompt)
    run.thinkingLevel = info.thinkingLevel
    run.tools = info.tools
    sentAt = Date.now()
    await sendPrompt(app, sid, input)
    let idleSince = 0
    const settlePlanner = async (): Promise<void> => {
      idleSince = 0
      // Quiet alone is not enough: this throwaway session's view carries no run state the probe can read, and the
      // event stream is silent during a turn, so a thinking pause looked like the end (first real runs, 2026-11-08:
      // settled after 28 s mid-exploration; then waited out the timeout after an answer). Done = the tree is quiet
      // AND the planner's root agent is idle in the agent monitor (its run is over, answered or not)
      await settleTree(app, events, sid, stats, debug, 20_000, undefined, {
        timeoutMs: PLANNER_TIMEOUT_MS,
        refuseAsks: PLANNER_REFUSAL,
        done: async () => {
          const phases = await app.main
            .eval<
              string[]
            >(`window.api.agent.monitorList().then((es) => es.filter((e) => e.rootSessionId === ${JSON.stringify(sid)} && e.kind === 'root').map((e) => e.phase))`)
            .catch(() => [] as string[])
          if (!(phases.length > 0 && phases.every((phase) => phase === 'idle'))) {
            idleSince = 0
            return false
          }
          idleSince ||= Date.now()
          // idle with the turn's last block being text = answered; idle for 30 s with no answer = the run ended
          // without one (a monitor `idle` seen mid-run once let the probe delete a planner that was still reading)
          const msgs = await readMessages(app, sid).catch(() => [] as Msg[])
          const last = [...msgs].reverse().find((m) => m.role === 'assistant')
          const tail = last?.blocks.filter((b) => b.type !== 'thinking').at(-1)
          const answered =
            tail !== undefined && tail.type === 'text' && (tail.text ?? '').trim() !== ''
          return answered || Date.now() - idleSince >= 30_000
        }
      })
    }
    await settlePlanner()
    // A run can end with no answer at all (deepseek, 2026-11-08: 24 reads in ~15 s, then an empty turn). A product
    // host would ask once more for the draft; so does the probe, and the summary counts it
    const answerNow = async (): Promise<string> => {
      const msgs = await readMessages(app, sid).catch(() => [] as Msg[])
      const last = [...msgs].reverse().find((m) => m.role === 'assistant')
      const texts = (last?.blocks ?? []).filter(
        (b) => b.type === 'text' && (b.text ?? '').trim() !== ''
      )
      return texts.length > 0 ? (texts.at(-1)?.text ?? '') : (last?.content ?? '')
    }
    if (!parsePlannerAnswer(await answerNow()).ok) {
      run.violations.push('no draft at the end of its run: asked once more for the JSON block')
      await sendPrompt(app, sid, PLANNER_NUDGE)
      await settlePlanner()
    }
    settledAt = Date.now()
  } catch (e) {
    run.error = String((e as Error)?.message ?? e)
    debug(`planner: ${run.error}`)
    if (run.sessionId)
      await app.main
        .eval(`window.api.agent.abort(${JSON.stringify(run.sessionId)})`)
        .catch(() => undefined)
  } finally {
    rmSync(ownPath, { force: true })
    if (workBefore === undefined) rmSync(workPath, { force: true })
    else writeFileSync(workPath, workBefore)
  }
  run.asks = stats.permissions
  if (run.sessionId) {
    // The answer is the text after the turn's last tool call: one assistant message holds the whole turn, so take
    // its last text block (the message's `content` need not be it). The view can trail the monitor's `idle` by a
    // moment (first S1 run, 2026-11-08: a complete JSON answer read as "no JSON block"), so re-read for up to 20 s
    // until that text carries the draft
    const finalTextOf = (msgs: Msg[]): string => {
      const last = [...msgs].reverse().find((m) => m.role === 'assistant')
      if (last === undefined) return ''
      const texts = last.blocks.filter((b) => b.type === 'text' && (b.text ?? '').trim() !== '')
      return texts.length > 0 ? (texts.at(-1)?.text ?? '') : last.content
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      messages = await readMessages(app, run.sessionId).catch(() => [])
      run.finalText = finalTextOf(messages)
      if (parsePlannerAnswer(run.finalText).ok) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    for (const b of messages.flatMap((m) => m.blocks))
      if (b.type === 'tool')
        run.toolCalls[b.toolName ?? '?'] = (run.toolCalls[b.toolName ?? '?'] ?? 0) + 1
    const rows = await app.main
      .eval<
        Array<{ kind: string; lastActivityAt: number }>
      >(`window.api.agent.monitorList().then((es) => es.filter((e) => e.rootSessionId === ${JSON.stringify(run.sessionId)}).map((e) => ({ kind: e.kind, lastActivityAt: e.lastActivityAt || 0 })))`)
      .catch(() => [])
    const root = rows.find((r) => r.kind === 'root')
    // the agent's last message, else when the tree went quiet (5 s late)
    const end = root && root.lastActivityAt > sentAt ? root.lastActivityAt : settledAt
    if (sentAt && end) run.seconds = Math.round((end - sentAt) / 1000)
    // throwaway: the working agent's session tool must not find it
    await app.main
      .eval(`window.api.session.delete(${JSON.stringify(run.sessionId)})`)
      .catch((e) => debug(`planner: deleting its session failed: ${String(e)}`))
  }
  if (!run.error) {
    const parsed = parsePlannerAnswer(run.finalText)
    if (parsed.ok) {
      run.verdict = parsed.draft.verdict
      run.draft = parsed.draft
      run.violations = parsed.violations
    } else run.error = parsed.error
  }
  debug(`planner: ${run.verdict}${run.error ? ` (${run.error})` : ''} in ${run.seconds} s`)
  return { run, messages }
}

/** What the planner is sent: the request; an early message (long set) first, as the user's earlier words */
const plannerInput = (task: CodingTask): string =>
  task.early
    ? `<earlier-user-words>\n${task.early.message}\n</earlier-user-words>\n\n${task.prompt}`
    : task.prompt

/**
 * The goal-shaped step before the goal: the planner drafts, the user reviews once (the simulated user, with
 * its facts; a task without hidden facts accepts the draft as it is), and the accepted draft becomes the
 * goal text after the request.
 */
async function shapeGoal(
  app: E2EApp,
  events: EventRecorder,
  projectId: string,
  task: CodingTask,
  sim: SimUser | undefined,
  debug: (l: string) => void
): Promise<{ shape: ShapeRecord; messages: Msg[] }> {
  const { run, messages } = await runPlanner(app, events, projectId, plannerInput(task), debug)
  const plain = fitObjective(task.prompt)
  const shape: ShapeRecord = {
    planner: run,
    reviewBy: 'none',
    reviewSeconds: 0,
    shown: '',
    objective: plain.text,
    truncatedChars: plain.truncatedChars
  }
  const draft = run.draft
  if (!draft || draft.verdict === 'ready') return { shape, messages }
  shape.shown = reviewText(draft)
  if (!shape.shown) return { shape, messages }
  const factIds = task.user?.facts.map((f) => f.id) ?? []
  let review: DraftReview | undefined
  if (sim && factIds.length) {
    const t0 = Date.now()
    const r = await sim.review(shape.shown)
    shape.reviewSeconds = Math.round((Date.now() - t0) / 1000)
    if (r.review) {
      review = r.review
      shape.review = r.review
    } else shape.reviewError = r.error
  }
  shape.reviewBy = review ? 'sim' : 'accept'
  shape.applied = applyReview(draft, review, factIds)
  const fit = fitObjective(goalTextShaped(task.prompt, shape.applied.accepted))
  shape.objective = fit.text
  shape.truncatedChars = fit.truncatedChars
  debug(
    `shaped: review by ${shape.reviewBy}, facts in ${JSON.stringify(shape.applied.facts)}, ${shape.objective.length} chars${fit.truncatedChars ? ` (${fit.truncatedChars} cut)` : ''}`
  )
  return { shape, messages }
}

/** one line for the run's agent notes */
const plannerNote = (p: PlannerRun): string =>
  `planner ${p.md}: identity "${p.identity}", thinking ${p.thinkingLevel || '?'}, tools ${p.tools.join(', ') || '?'}`

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
  /** messages into sub-sessions that carried the user's own words, and how many words they quoted in all */
  userWordsAttached: { sends: number; words: number }
  user?: UserReport
  /** compaction summaries in the tree's transcripts */
  compactions: number
  /** the root's context window as it really ran (0 = unknown) */
  contextWindow: number
  goal?: GoalRun
  /** goal-shaped and planner arms: the planner's draft, what the user made of it, the goal text it gave */
  shape?: ShapeRecord
  error?: string
}

/** What came of a goal (goal arms) */
interface GoalRun {
  /** the text set as the goal (goal: the request; goal-oracle and goal-shaped: longer, see the header) */
  objective: string
  /** characters cut to fit the goal's 4000-character limit */
  truncatedChars: number
  /** `goalAct` set refused: the goal never started */
  setError?: string
  /** the goal's status when the probe stopped watching; `none` = no goal (cleared, or never set) */
  status: GoalStatus | 'none'
  pauseReason?: string
  /** the judge's last verdict and why */
  verdict?: string
  reason?: string
  /** continuations the host started for the goal */
  turns: number
  /** from setting the goal until it ended, or until the probe gave up */
  wallSeconds: number
  /** the goal had not ended (or a verdict was still pending) when PROBE_GOAL_TIMEOUT_MIN ran out */
  timedOut: boolean
  /** the judge's not-met reasons on the way, from the `<goal-continue>` notices in the root's transcript */
  notMet: string[]
  /** the judge's first check: its verdict, and the repo as it saw it, graded */
  first?: FirstCheck
}

/** The judge's first check of a goal run */
interface FirstCheck {
  /** the first verdict (recorded `goal` events; else rebuilt from the end state); absent = none came */
  verdict?: GoalVerdictKind
  reason?: string
  nextStep?: string
  /** where the verdict came from */
  verdictFrom: 'events' | 'end state' | 'none'
  /** the repo copied when that check began; absent = no copy (see note) */
  snapshot?: {
    atSeconds: number
    sound: boolean
    note: string
    pass: boolean
    core: { passed: number; total: number }
    visible: { pass: number; fail: number }
    /** core checks the copied state failed */
    failing: string[]
    /** tasks with hidden facts: the facts whose checks all passed in the copied state */
    facts?: { met: string[]; total: number }
    graderError?: string
  }
  note?: string
}

/** What came of the judge's first check, against the grade of what it judged */
type TrapClass =
  | 'clean'
  | 'caught'
  | 'caught-not-fixed'
  | 'false-met'
  | 'over-strict'
  | 'impossible'
  | 'no-verdict'
  | 'no-snapshot'

function trapClassOf(r: RunRecord): TrapClass | undefined {
  const f = r.goal?.first
  if (!r.goal) return undefined
  if (!f?.verdict) return 'no-verdict'
  if (f.verdict === 'impossible') return 'impossible'
  if (!f.snapshot) return 'no-snapshot'
  if (f.snapshot.pass) return f.verdict === 'met' ? 'clean' : 'over-strict'
  if (f.verdict === 'met') return 'false-met'
  return r.grade.pass ? 'caught' : 'caught-not-fixed'
}

/** the goal is over: met, impossible or paused, with no verdict pending (null = no goal any more) */
const goalOver = (v: GoalView | null): boolean =>
  v === null ||
  (!v.judging && (v.status === 'met' || v.status === 'impossible' || v.status === 'paused'))

/** "Not met yet. Checker: <reason>" of each continuation notice, unescaped */
function notMetReasons(msgs: Msg[]): string[] {
  const unescape = (t: string): string =>
    t
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  return msgs
    .filter((m) => (m.role === 'user' || m.isNotice) && m.content.includes('<goal-continue'))
    .map((m) => m.content.match(/Not met yet\. Checker: (.*)/)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(unescape)
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

/** the planner arm does no work: its record carries this instead of a grade */
const NOT_GRADED: Grade = {
  pass: false,
  core: { passed: 0, total: 0 },
  extra: { passed: 0, total: 0 },
  constraints: { kept: 0, total: 0 },
  checks: [],
  visible: { pass: 0, fail: 0 },
  suite: { pass: 0, fail: 0, command: '' },
  tampered: { tests: [], testScript: false },
  testsExtended: [],
  diff: { files: [], untracked: [] },
  graderError: 'not graded: the planner arm does no work'
}

/** runs that did the work (every arm but planner): the tables about the code read only these */
const worked = (): RunRecord[] => records.filter((r) => r.arm !== 'planner')

function renderSummary(): string {
  const goalArms = ARMS.some(isGoalArm) || (SET === 's1' && S1_CONTROLS === 'full')
  const lines = [
    `# Coding probe: ${SET} set (${LANG}${MD_DIR ? `, drafts from ${MD_DIR}` : ''}${AUTO_REVIEW ? ', auto-review on' : ''}` +
      `${CONTEXT_WINDOW !== undefined ? `, context window ${CONTEXT_WINDOW} asked` : ''}` +
      `${goalArms ? `, goal limits ${JSON.stringify(GOAL_LIMITS)} (unset = product defaults), goal timeout ${GOAL_TIMEOUT_MS / 60_000} min` : ''}` +
      `${records.some((r) => r.shape) ? `, planner ${PLANNER_MD_PATH}` : ''})`,
    ''
  ]
  // aggregate per model × arm
  lines.push(
    '| model | arm | runs | pass | core checks | visible tests | tokens in (mean) | out (mean) | requests (mean) | seconds (mean) |'
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const groups = new Map<string, RunRecord[]>()
  for (const r of worked())
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
  lines.push(...goalSummary())
  lines.push(...trapSummary())
  lines.push(...s1Summary())
  lines.push('', '## Runs', '')
  lines.push(
    '| model | arm | task | # | pass | core | extra | visible | tampered | tests added | changed (+/−) | in / out tokens | req | s | calls | hand-offs | skim | verbatim | decoy mentioned | root cause mentioned | asks |'
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of worked()) {
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
    lines.push(...shapeDetails(r))
    if (r.arm === 'planner') continue
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
      `Sessions: ${r.sessions.map((s) => `${s.profile ?? 'base'}${s.parent ? ' (sub)' : ''}`).join(', ')}; tools: ${Object.entries(
        r.toolCalls
      )
        .map(([n, c]) => `${n}×${c}`)
        .join(' ')}; explore: ${r.exploreCalls}; follow-ups: ${r.followUps}`,
      `Agents: ${r.agents.join('; ') || 'builtin'}`,
      `User words attached to sub-session messages: ${r.userWordsAttached.words} in ${r.userWordsAttached.sends} message(s)`,
      `Compactions: ${r.compactions}; context window: ${r.contextWindow || 'unknown'}`
    )
    if (r.goal) {
      const g = r.goal
      if (r.arm !== 'goal')
        lines.push(
          '',
          `Goal text (${g.objective.length} chars${g.truncatedChars ? `, ${g.truncatedChars} cut` : ''}):`,
          '',
          '```text',
          g.objective,
          '```'
        )
      lines.push(
        '',
        g.setError
          ? `Goal: not set — ${g.setError}`
          : `Goal: ${g.status}${g.pauseReason ? ` (${g.pauseReason})` : ''}${g.timedOut ? ', still running when the probe gave up' : ''}; ` +
              `${g.turns} continuation(s), ${g.wallSeconds} s` +
              `${g.verdict ? `; last verdict ${g.verdict}: ${g.reason}` : ''}`
      )
      for (const [i, reason] of g.notMet.entries()) lines.push(`  ${i + 1}. not met: ${reason}`)
      const f = g.first
      if (f) {
        const s = f.snapshot
        lines.push(
          `First check (${trapClassOf(r)}): verdict ${f.verdict ?? 'none'} (from ${f.verdictFrom})` +
            `${f.reason ? `: ${f.reason}` : ''}${f.nextStep ? ` — next: ${f.nextStep}` : ''}`,
          s
            ? `  state it judged (copied ${s.atSeconds} s after the goal was set, ${s.sound ? 'sound' : 'NOT sound'}: ${s.note}): ` +
                `${s.pass ? 'passes' : 'fails'}, core ${s.core.passed}/${s.core.total}, visible ${s.visible.pass}/${s.visible.pass + s.visible.fail}` +
                `${s.facts ? `, facts ${s.facts.met.length}/${s.facts.total} ${s.facts.met.join(',') || '—'}` : ''}` +
                `${s.failing.length ? `; failing: ${s.failing.join('; ')}` : ''}${s.graderError ? `; grader failed: ${s.graderError}` : ''}`
            : `  ${f.note ?? 'no copy'}`
        )
      }
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
    lines.push('', 'Final reply:', '', '```text', r.finalReply.slice(0, 3000), '```')
  }
  return lines.join('\n')
}

/** The ambig set's tables: what each run cost the user and what came of the facts it held */
function userSummary(): string[] {
  const rs = worked().filter((r) => r.user)
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

/** The long set and the goal arm: rules kept, compactions, and what came of each goal */
function goalSummary(): string[] {
  const rs = worked().filter((r) => r.goal || r.grade.constraints.total > 0)
  if (!rs.length) return []
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0)
  const out = [
    '',
    '## Goals, rules and compaction',
    '',
    'rules kept = checks of the rules the user stated only in the early message (C1, C2 per task), apart from pass; ' +
      'all kept = runs that kept every rule; ' +
      'goal columns (goal arm only): status when it ended, continuations the host started, seconds from setting it to its end.',
    '',
    '| model | arm | runs | pass | rules kept | all kept | compactions (mean) | window | goal: met / impossible / paused / other | continuations (mean) | goal s (mean) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const groups = new Map<string, RunRecord[]>()
  for (const r of rs)
    groups.set(`${r.model}|${r.arm}`, [...(groups.get(`${r.model}|${r.arm}`) ?? []), r])
  for (const [key, g] of groups) {
    const [model, arm] = key.split('|')
    const kept = g.reduce((t, r) => t + r.grade.constraints.kept, 0)
    const total = g.reduce((t, r) => t + r.grade.constraints.total, 0)
    const goals = g.flatMap((r) => (r.goal ? [r.goal] : []))
    const count = (s: string): number => goals.filter((x) => x.status === s).length
    const other = goals.length - count('met') - count('impossible') - count('paused')
    const windows = [...new Set(g.map((r) => r.contextWindow || 0))].map((w) => (w ? k(w) : '?'))
    out.push(
      `| ${model} | ${arm} | ${g.length} | ${g.filter((r) => r.grade.pass).length}/${g.length} | ${total ? `${kept}/${total}` : '—'} | ` +
        `${total ? `${g.filter((r) => r.grade.constraints.kept === r.grade.constraints.total).length}/${g.length}` : '—'} | ` +
        `${mean(g.map((r) => r.compactions)).toFixed(1)} | ${windows.join(', ')} | ` +
        `${goals.length ? `${count('met')} / ${count('impossible')} / ${count('paused')} / ${other}` : '—'} | ` +
        `${goals.length ? mean(goals.map((x) => x.turns)).toFixed(1) : '—'} | ` +
        `${goals.length ? Math.round(mean(goals.map((x) => x.wallSeconds))) : '—'} |`
    )
  }
  out.push(
    '',
    '| model | arm | task | # | pass | rules | compactions | window | goal | pause reason | continuations | goal s | last verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  for (const r of rs) {
    const rules = r.grade.checks
      .filter((c) => c.constraint)
      .map((c) => `${c.constraint} ${c.pass ? '✅' : '❌'}`)
      .join(' ')
    const g = r.goal
    out.push(
      `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${r.grade.pass ? '✅' : '❌'}${r.error ? ' ⚠️' : ''} | ${rules || '—'} | ${r.compactions} | ` +
        `${r.contextWindow ? k(r.contextWindow) : '?'} | ` +
        (g
          ? `${g.setError ? 'not set' : g.status}${g.timedOut ? ' (timed out)' : ''} | ${g.pauseReason ?? '—'} | ${g.turns} | ${g.wallSeconds} | ` +
            `${g.verdict ? cell(`${g.verdict}: ${g.reason ?? ''}`).slice(0, 200) : '—'} |`
          : '— | — | — | — | — |')
    )
  }
  return out
}

/**
 * Did the agent declare done too early, and did the goal's judge catch it? Direct runs: the final state is
 * what the agent declared done. Goal runs: the state the judge's first check saw, graded, against its verdict.
 */
function trapSummary(): string[] {
  const rs = worked().filter((r) => r.arm !== 'work')
  if (!rs.length || (SET !== 'trap' && !rs.some((r) => r.goal?.first))) return []
  const goalArm = (arm: string): boolean => isGoalArm(arm as Arm)
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0)
  const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const CLASSES: TrapClass[] = ['clean', 'caught', 'caught-not-fixed', 'false-met', 'over-strict']
  /** the agent's first "done" failed the grader: direct = its final state; goal = the state the first check saw */
  const stoppedShort = (r: RunRecord): boolean | undefined =>
    goalArm(r.arm)
      ? r.goal?.first?.snapshot
        ? !r.goal.first.snapshot.pass
        : undefined
      : !r.grade.pass
  const traps = TASKS.filter((t) => t.trap && rs.some((r) => r.task === t.id))
  const out = [
    '',
    '## Trap: declared done vs the end condition',
    '',
    'stopped short = the state the agent first called done fails the grader (direct: its final state; goal: the state the judge’s first check saw, copied when the check began). ' +
      'Goal runs by the first verdict against that state: clean = passes and met; caught = fails, not_met, and the final state passes; caught-not-fixed = fails, not_met, final fails; ' +
      'false-met = fails yet met; over-strict = passes yet not_met; other = impossible, no verdict, or no copy. Seconds = the whole run.',
    ...(traps.length ? ['', ...traps.map((t) => `- ${t.id}: ${t.trap}`)] : []),
    '',
    '| model | arm | runs | pass | stopped short | clean | caught | caught-not-fixed | false-met | over-strict | other | continuations (mean) | seconds (mean) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  const groups = new Map<string, RunRecord[]>()
  for (const r of rs)
    groups.set(`${r.model}|${r.arm}`, [...(groups.get(`${r.model}|${r.arm}`) ?? []), r])
  for (const [key, g] of groups) {
    const [model, arm] = key.split('|')
    const short = g.map(stoppedShort).filter((x): x is boolean => x !== undefined)
    const classes = g.map(trapClassOf)
    const n = (c: TrapClass): string =>
      goalArm(arm) ? String(classes.filter((x) => x === c).length) : '—'
    const other = classes.filter((c) => c !== undefined && !CLASSES.includes(c)).length
    out.push(
      `| ${model} | ${arm} | ${g.length} | ${g.filter((r) => r.grade.pass).length}/${g.length} | ` +
        `${short.length ? `${short.filter(Boolean).length}/${short.length}` : '—'} | ` +
        `${CLASSES.map(n).join(' | ')} | ${goalArm(arm) ? other : '—'} | ` +
        `${goalArm(arm) ? mean(g.map((r) => r.goal?.turns ?? 0)).toFixed(1) : '—'} | ` +
        `${Math.round(mean(g.map((r) => r.seconds)))} |`
    )
  }
  out.push(
    '',
    '| model | arm | task | # | final | first “done” state | its failed checks | first verdict | class | continuations | s | first verdict reason |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of rs) {
    const f = r.goal?.first
    const s = f?.snapshot
    const final = `${r.grade.pass ? '✅' : '❌'} ${r.grade.core.passed}/${r.grade.core.total}${r.error ? ' ⚠️' : ''}`
    const first = goalArm(r.arm)
      ? s
        ? `${s.pass ? '✅' : '❌'} ${s.core.passed}/${s.core.total} (${s.atSeconds} s${s.sound ? '' : ', not sound'})`
        : (f?.note ?? 'no copy')
      : `${r.grade.pass ? '✅' : '❌'} (declared done)`
    const failed = goalArm(r.arm)
      ? (s?.failing ?? []).join('; ')
      : r.grade.checks
          .filter((c) => c.core && !c.constraint && !c.pass)
          .map((c) => c.name)
          .join('; ')
    out.push(
      `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${final} | ${cell(first)} | ${cell(failed) || '—'} | ` +
        `${goalArm(r.arm) ? (f?.verdict ?? 'none') : '—'} | ${goalArm(r.arm) ? trapClassOf(r) : r.grade.pass ? 'done' : 'stopped short'} | ` +
        `${r.goal ? r.goal.turns : '—'} | ${r.seconds} | ${f?.reason ? cell(f.reason).slice(0, 240) : '—'} |`
    )
  }
  return out
}

/** A run's planner step in full: its verdict, the draft as the user read it, the review, the goal text */
function shapeDetails(r: RunRecord): string[] {
  const sh = r.shape
  if (!sh) return []
  const p = sh.planner
  const calls = Object.entries(p.toolCalls)
    .map(([n, c]) => `${n}×${c}`)
    .join(' ')
  const out = [
    `Planner: ${p.verdict}${p.error ? ` — ${p.error}` : ''}; ${p.seconds} s; ` +
      `thinking ${p.thinkingLevel || '?'}; tools ${p.tools.join(', ') || '?'}; calls ${calls || 'none'}` +
      `${p.asks ? `; ${p.asks} permission ask(s) refused` : ''}`
  ]
  for (const v of p.violations) out.push(`  - contract: ${v}`)
  if (sh.shown) out.push('', 'Draft as the user read it:', '', '```text', sh.shown, '```')
  const a = sh.applied
  if (a) {
    const facts = Object.entries(a.facts).map(([f, how]) => `${f} (${how})`)
    out.push(
      '',
      `Review by ${sh.reviewBy}${sh.reviewError ? ` (the review failed: ${sh.reviewError})` : ''}, ${sh.reviewSeconds} s: ` +
        `decisions with a fact ${a.decisionsWithFact}, noise ${a.noiseDecisions}; facts in the accepted text: ${facts.join(', ') || 'none'}`
    )
    const rv = sh.review
    if (rv) {
      for (const d of rv.decisions)
        out.push(`  - ${d.id} → ${d.answer} [${d.facts.join(',') || '—'}]`)
      for (const e of rv.edits)
        out.push(
          `  - ${e.id} ${e.action}${e.text ? `: ${e.text}` : ''} [${e.facts.join(',') || '—'}]`
        )
      for (const x of rv.additions)
        out.push(
          `  - added to ${x.section} (about ${x.about}): ${x.text} [${x.facts.join(',') || '—'}]`
        )
      if (rv.alreadyRight.length) out.push(`  - already right: ${rv.alreadyRight.join(', ')}`)
    }
    for (const x of a.ignored) out.push(`  - not applied: ${x}`)
  }
  if (r.arm === 'planner')
    out.push(
      '',
      `Goal text it would set (${sh.objective.length} chars${sh.truncatedChars ? `, ${sh.truncatedChars} cut` : ''}):`,
      '',
      '```text',
      sh.objective,
      '```',
      '',
      'Planner’s last message:',
      '',
      '```text',
      p.finalText.slice(0, 6000),
      '```'
    )
  out.push('')
  return out
}

const S1_ARMS: Arm[] = ['direct', 'goal', 'goal-oracle', 'goal-shaped']

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/**
 * Measurement S1 of the goal spec-shaping proposal: on the tasks with hidden facts, how many facts each arm
 * meets (direct = the user stays and corrects; goal = set and leave on the request; goal-oracle = the facts
 * written into the goal; goal-shaped = the planner's draft as the user reviewed it); what the planner did; the
 * controls; the four thresholds.
 */
function s1Summary(): string[] {
  if (!records.some((r) => r.arm === 'goal-oracle' || r.shape)) return []
  const taskById = new Map(TASKS.map((t) => [t.id, t]))
  const factTask = (r: RunRecord): boolean => {
    const t = taskById.get(r.task)
    return t !== undefined && hasFacts(t)
  }
  const factRuns = records.filter((r) => S1_ARMS.includes(r.arm) && factTask(r) && r.user)
  const planned = records.filter((r) => r.shape)
  const models = [...new Set(records.map((r) => r.model))]
  const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((t, x) => t + f(x), 0)
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0)
  const pct = (a: number, b: number): string =>
    b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : '—'
  const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const factTaskIds = TASKS.filter((t) => hasFacts(t) && factRuns.some((r) => r.task === t.id)).map(
    (t) => t.id
  )
  const CLASSES: TrapClass[] = ['clean', 'caught', 'caught-not-fixed', 'false-met', 'over-strict']
  const out = [
    '',
    '## S1: does shaping recover what a vague goal loses?',
    '',
    'Tasks with hidden facts only (catval, long and trap are the controls, below). facts met = facts whose grader checks all pass at the end. ' +
      'direct = the user stays: answers questions and corrects the completion report; goal = set and leave on the request (ask cards answered, nothing corrected); ' +
      'goal-oracle = the request plus every fact as "done when"; goal-shaped = the request plus the planner’s draft as the simulated user reviewed it. ' +
      'First check: the judge’s first verdict against the graded state it saw (false-met = it said met while a check, a fact’s included, failed).',
    '',
    '| model | arm | runs | pass | facts met | per task | first check: clean / caught / caught-not-fixed / false-met / over-strict / other | continuations (mean) | seconds (mean) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const model of models) {
    for (const arm of S1_ARMS) {
      const g = factRuns.filter((r) => r.model === model && r.arm === arm)
      if (!g.length) continue
      const u = g.map((r) => r.user as UserReport)
      const perTask = factTaskIds
        .map((id) => {
          const x = g.filter((r) => r.task === id).map((r) => r.user as UserReport)
          return x.length
            ? `${id} ${sum(x, (y) => y.met.length)}/${sum(x, (y) => y.facts.length)}`
            : ''
        })
        .filter(Boolean)
        .join(', ')
      const classes = g.map(trapClassOf)
      const other = classes.filter((c) => c !== undefined && !CLASSES.includes(c)).length
      out.push(
        `| ${model} | ${arm} | ${g.length} | ${g.filter((r) => r.grade.pass).length}/${g.length} | ` +
          `${pct(
            sum(u, (x) => x.met.length),
            sum(u, (x) => x.facts.length)
          )} | ${perTask} | ` +
          `${isGoalArm(arm) ? `${CLASSES.map((c) => classes.filter((x) => x === c).length).join(' / ')} / ${other}` : '—'} | ` +
          `${isGoalArm(arm) ? mean(g.map((r) => r.goal?.turns ?? 0)).toFixed(1) : '—'} | ` +
          `${Math.round(mean(g.map((r) => r.seconds)))} |`
      )
    }
  }

  // the planner on the tasks with hidden facts
  const withFacts = planned.filter(factTask)
  if (withFacts.length) {
    out.push(
      '',
      'The planner on the tasks with hidden facts. facts in = facts the accepted draft states before any work, and how they got there (the simulated user’s account): ' +
        'answering a decision / correcting an item that contradicted one / added where an item touched its point / already right in the draft. ' +
        'noise = decisions that touched no fact. review: sim = reviewed, accept = taken as it is (the review failed). cut = runs whose goal text was cut to 4000 characters.',
      '',
      '| model | arm | runs | ready / shape / error | decisions: with a fact / noise | criteria · assumptions · non-goals (mean) | facts in before work | decision / corrected / added / already | review: sim / accept | entries not applied | cut | planner s (median) | review s (median) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    )
    for (const model of models) {
      for (const arm of ['goal-shaped', 'planner'] as Arm[]) {
        const g = withFacts.filter((r) => r.model === model && r.arm === arm)
        if (!g.length) continue
        const sh = g.map((r) => r.shape as ShapeRecord)
        const verdicts = (v: PlannerRun['verdict']): number =>
          sh.filter((x) => x.planner.verdict === v).length
        const entries = sh.flatMap((x) => Object.values(x.applied?.facts ?? {}))
        const how = (h: FactEntry): number => entries.filter((x) => x === h).length
        const drafts = sh.flatMap((x) => (x.planner.draft ? [x.planner.draft] : []))
        out.push(
          `| ${model} | ${arm} | ${g.length} | ${verdicts('ready')} / ${verdicts('shape')} / ${verdicts('planner-error')} | ` +
            `${sum(sh, (x) => x.applied?.decisionsWithFact ?? 0)} / ${sum(sh, (x) => x.applied?.noiseDecisions ?? 0)} | ` +
            `${mean(drafts.map((d) => d.criteria.length)).toFixed(1)} · ${mean(drafts.map((d) => d.assumptions.length)).toFixed(1)} · ${mean(drafts.map((d) => d.nonGoals.length)).toFixed(1)} | ` +
            `${pct(
              entries.length,
              sum(g, (r) => taskById.get(r.task)?.user?.facts.length ?? 0)
            )} | ` +
            `${how('decision')} / ${how('corrected')} / ${how('added')} / ${how('already')} | ` +
            `${sh.filter((x) => x.reviewBy === 'sim').length} / ${sh.filter((x) => x.reviewBy === 'accept').length} | ` +
            `${sum(sh, (x) => x.applied?.ignored.length ?? 0)} | ${sh.filter((x) => x.truncatedChars > 0).length} | ` +
            `${median(sh.map((x) => x.planner.seconds))} | ` +
            `${median(sh.filter((x) => x.reviewBy !== 'none').map((x) => x.reviewSeconds))} |`
        )
      }
    }
  }

  // the controls: everything said, or an end condition stated — the planner should say ready
  const controls = planned.filter((r) => !factTask(r))
  const decisionsAsked = (r: RunRecord): number =>
    r.shape?.planner.verdict === 'shape' ? (r.shape.planner.draft?.decisions.length ?? 0) : 0
  if (controls.length) {
    out.push(
      '',
      'Controls (catval, long, trap: fully specified or with a stated end condition). decisions = what a shape verdict would ask the user (a ready verdict asks nothing).',
      '',
      '| model | runs | ready | shape | error | decisions (mean) | planner s (median) |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    )
    for (const model of models) {
      const g = controls.filter((r) => r.model === model)
      if (!g.length) continue
      const n = (v: PlannerRun['verdict']): number =>
        g.filter((r) => r.shape?.planner.verdict === v).length
      out.push(
        `| ${model} | ${g.length} | ${pct(n('ready'), g.length)} | ${n('shape')} | ${n('planner-error')} | ` +
          `${mean(g.map(decisionsAsked)).toFixed(2)} | ${median(g.map((r) => r.shape?.planner.seconds ?? 0))} |`
      )
    }
  }

  if (planned.length) {
    out.push(
      '',
      '| model | arm | task | # | verdict | decisions (fact / noise) | criteria | assumptions | non-goals | facts in | s | notes |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    )
    for (const r of planned) {
      const sh = r.shape as ShapeRecord
      const p = sh.planner
      const d = p.draft
      const notes = [
        p.error ?? '',
        p.violations.length ? `${p.violations.length} contract breach(es)` : '',
        sh.reviewError ? `review failed: ${sh.reviewError}` : '',
        sh.truncatedChars ? `${sh.truncatedChars} chars cut` : ''
      ]
        .filter(Boolean)
        .join('; ')
      out.push(
        `| ${r.model} | ${r.arm} | ${r.task} | ${r.run} | ${p.verdict} | ` +
          `${d ? `${d.decisions.length} (${sh.applied?.decisionsWithFact ?? 0} / ${sh.applied?.noiseDecisions ?? d.decisions.length})` : '—'} | ` +
          `${d?.criteria.length ?? '—'} | ${d?.assumptions.length ?? '—'} | ${d?.nonGoals.length ?? '—'} | ` +
          `${
            Object.entries(sh.applied?.facts ?? {})
              .map(([f, how]) => `${f} ${how}`)
              .join(', ') || '—'
          } | ${p.seconds} | ${cell(notes).slice(0, 200) || '—'} |`
      )
    }
  }

  // the thresholds, per model and over all of them
  out.push('', '### S1 thresholds', '')
  for (const model of models.length > 1 ? [...models, 'all models'] : models) {
    const mine = (rs: RunRecord[]): RunRecord[] =>
      model === 'all models' ? rs : rs.filter((r) => r.model === model)
    const rate = (arm: Arm): { met: number; total: number; r: number } | undefined => {
      const u = mine(factRuns)
        .filter((r) => r.arm === arm)
        .map((r) => r.user as UserReport)
      const total = sum(u, (x) => x.facts.length)
      if (!total) return undefined
      const met = sum(u, (x) => x.met.length)
      return { met, total, r: met / total }
    }
    const show = (x: { met: number; total: number }): string => pct(x.met, x.total)
    const goal = rate('goal')
    const oracle = rate('goal-oracle')
    const shaped = rate('goal-shaped')
    const lines: string[] = []
    // (i)
    if (goal && oracle)
      lines.push(
        `- (i) the goal arm loses facts against goal-oracle: ${goal.r < oracle.r ? 'PASS' : 'FAIL'} — goal ${show(goal)} vs goal-oracle ${show(oracle)}`
      )
    else
      lines.push(
        '- (i) the goal arm loses facts against goal-oracle: n/a — needs goal and goal-oracle runs'
      )
    // (ii)
    if (goal && oracle && shaped) {
      const gap = oracle.r - goal.r
      const need = goal.r + gap / 2
      lines.push(
        gap > 0
          ? `- (ii) goal-shaped recovers at least half of the gap: ${shaped.r >= need - 1e-9 ? 'PASS' : 'FAIL'} — goal-shaped ${show(shaped)}; ` +
              `needs ≥ ${Math.round(need * 100)}% (goal ${Math.round(goal.r * 100)}% + half of the ${Math.round(gap * 100)}-point gap); recovered ${Math.round(((shaped.r - goal.r) / gap) * 100)}% of the gap`
          : `- (ii) goal-shaped recovers at least half of the gap: n/a — no gap (goal ${show(goal)}, goal-oracle ${show(oracle)}); goal-shaped ${show(shaped)}`
      )
    } else
      lines.push(
        '- (ii) goal-shaped recovers at least half of the gap: n/a — needs goal, goal-oracle and goal-shaped runs'
      )
    // (iii)
    const ctl = mine(controls)
    if (ctl.length) {
      const ready = ctl.filter((r) => r.shape?.planner.verdict === 'ready').length
      const asked = mean(ctl.map(decisionsAsked))
      const ok = ready / ctl.length >= 6 / 7 - 1e-9 && asked <= 1
      lines.push(
        `- (iii) controls: the planner says ready on ≥ 6/7 and asks ≤ 1 decision per run on average: ${ok ? 'PASS' : 'FAIL'} — ` +
          `ready ${pct(ready, ctl.length)} (needs ≥ 86%), ${asked.toFixed(2)} decision(s) per run`
      )
    } else lines.push('- (iii) controls: n/a — no planner runs on catval, long or trap')
    // (iv)
    const times = mine(planned)
      .map((r) => r.shape?.planner.seconds ?? 0)
      .filter((x) => x > 0)
    lines.push(
      times.length
        ? `- (iv) median shaping (planner) time ≤ 90 s: ${median(times) <= 90 ? 'PASS' : 'FAIL'} — median ${median(times)} s over ${times.length} planner run(s) (max ${Math.max(...times)} s)`
        : '- (iv) median shaping (planner) time ≤ 90 s: n/a — no timed planner run'
    )
    out.push(`**${model}**`, '', ...lines, '')
  }
  return out
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

/** The planner arm: the planner and the user's review alone — no working session, no goal, not graded */
async function runPlannerArm(modelName: string, task: CodingTask, run: number): Promise<void> {
  const arm: Arm = 'planner'
  const label = `${modelName}-${arm}-${task.id}-r${run}`
  const debug = makeDebug(OUT)
  const model = modelOf(modelName)
  const started = Date.now()
  // only a user with hidden facts reviews the draft (catval's has none: its draft is accepted as it is)
  const { sim, simKey } = hasFacts(task) ? simUserFor(task) : {}
  let error: string | undefined
  let agents: string[] = []
  let shape: ShapeRecord | undefined
  let messages: Msg[] = []
  const app = await launchApp({
    autoReview: AUTO_REVIEW,
    env: { ...OFFLINE_ENV, SHUVIX_E2E_STAGED_RESOURCES: (stage as PackagedStage).resources }
  })
  const repo = join(app.home, 'code', basename(SETS[task.set].repo))
  mkdirSync(join(app.home, 'code'), { recursive: true })
  prepareRepo(task, repo)
  try {
    const prep = await prepareInstance(app, arm, model, repo)
    agents = prep.agents
    const shaped = await shapeGoal(app, prep.events, prep.projectId, task, sim, (l) =>
      debug(`${label}: ${l}`)
    )
    shape = shaped.shape
    messages = shaped.messages
    agents.push(plannerNote(shape.planner))
  } catch (e) {
    error = String((e as Error)?.message ?? e)
    debug(`${label}: ${error}`)
  }
  await app.stop({ keepHome: true })
  rmSync(app.home, { recursive: true, force: true })
  const redact = (t: string): string =>
    [model.key, simKey ?? ''].filter(Boolean).reduce((acc, k) => acc.split(k).join('<redacted>'), t)
  if (shape) {
    writeFileSync(
      join(OUT, `${label}.planner.md`),
      redact(plannerTranscript(label, shape.planner, messages))
    )
  }
  if (sim)
    writeFileSync(
      join(OUT, `${label}.user.json`),
      redact(JSON.stringify({ review: shape?.review, calls: sim.log }, null, 2))
    )
  const record: RunRecord = {
    model: modelName,
    modelId: model.modelId,
    arm,
    task: task.id,
    run,
    seconds: Math.round((Date.now() - started) / 1000),
    grade: NOT_GRADED,
    sessions: [],
    requests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCalls: shape?.planner.toolCalls ?? {},
    rootToolCalls: 0,
    skimBeforeDispatch: 0,
    rootEdits: 0,
    dispatches: [],
    exploreCalls: 0,
    settle: {
      questions: 0,
      permissions: shape?.planner.asks ?? 0,
      refused: shape?.planner.asks ?? 0,
      unansweredSubQuestions: 0
    },
    followUps: 0,
    finalReply: shape?.planner.finalText ?? '',
    agents,
    userWordsAttached: { sends: 0, words: 0 },
    compactions: 0,
    contextWindow: 0,
    ...(shape ? { shape } : {}),
    error: error ?? shape?.planner.error
  }
  records.push(record)
  writeFileSync(join(OUT, 'summary.md'), redact(renderSummary()))
  writeFileSync(join(OUT, 'summary.json'), redact(JSON.stringify(records, null, 2)))
  console.log(`[${label}] ${shapeLine(record)} → ${OUT}`)
}

/** the planner's transcript, apart from the run's */
function plannerTranscript(label: string, p: PlannerRun, messages: Msg[]): string {
  return transcriptMd(
    `${label} — goal planner (${p.md})`,
    [{ id: p.sessionId, title: 'goal planner', agentProfile: 'goal-planner' }],
    new Map([[p.sessionId, messages]])
  )
}

/** the planner's verdict and what came of the review, in one line (console) */
function shapeLine(r: RunRecord): string {
  const sh = r.shape
  if (!sh) return 'planner did not run'
  const p = sh.planner
  const d = p.draft
  const facts = sh.applied ? Object.keys(sh.applied.facts) : []
  return (
    `planner ${p.verdict}${p.error ? ` (${p.error})` : ''} in ${p.seconds} s` +
    `${d ? `, ${d.decisions.length} decision(s) ${d.criteria.length} criteria` : ''}` +
    `${sh.applied ? `, review by ${sh.reviewBy}: ${sh.applied.decisionsWithFact} decision(s) with a fact, facts in ${facts.join(',') || 'none'}` : ''}` +
    `${sh.truncatedChars ? `, ${sh.truncatedChars} chars cut` : ''}`
  )
}

async function runOne(modelName: string, arm: Arm, task: CodingTask, run: number): Promise<void> {
  if (arm === 'planner') return runPlannerArm(modelName, task, run)
  const label = `${modelName}-${arm}-${task.id}-r${run}`
  const debug = makeDebug(OUT)
  const { spec, key, modelId } = modelOf(modelName)
  const started = Date.now()
  const stats: SettleStats = { questions: 0, permissions: 0, refused: 0, unansweredSubQuestions: 0 }
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
  /** goal arm: when the goal was set and when it was seen over; what refused setting it */
  let goalSetAt: number | undefined
  let goalEndedAt: number | undefined
  let goalSetError: string | undefined
  /** goal arm: watches for the judge's first check and copies the repo then */
  let firstWatch: ReturnType<typeof watchFirstCheck> | undefined
  /** goal arms: the text set as the goal */
  let objective = { text: task.prompt, truncatedChars: 0 }
  /** goal-shaped: the planner's draft and the review, and the planner's transcript */
  let shape: ShapeRecord | undefined
  let plannerMessages: Msg[] = []

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
    // goal-shaped: the planner drafts and the user reviews it, before the working session exists
    if (arm === 'goal-shaped') {
      const shaped = await shapeGoal(app, events, prep.projectId, task, sim, (l) =>
        debug(`${label}: ${l}`)
      )
      shape = shaped.shape
      plannerMessages = shaped.messages
      agents.push(plannerNote(shape.planner))
    }
    objective =
      arm === 'goal-oracle'
        ? fitObjective(goalTextOracle(task))
        : arm === 'goal-shaped' && shape
          ? { text: shape.objective, truncatedChars: shape.truncatedChars }
          : { text: task.prompt, truncatedChars: 0 }
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
      // the goal text (the request, or longer) becomes the goal; the host sends it as the user's message and
      // keeps the session going
      await installGoalRecorder(app, rootId)
      goalSetAt = Date.now()
      firstWatch = watchFirstCheck(app, rootId, repo, goalSetAt, (l) => debug(`${label}: ${l}`))
      const action = {
        type: 'set',
        objective: objective.text,
        ...(Object.keys(GOAL_LIMITS).length > 0 ? { limits: GOAL_LIMITS } : {})
      }
      const set = await app.main.eval<GoalActResult>(
        `window.api.agent.goalAct(${JSON.stringify({ sessionId: rootId, action })})`
      )
      if (!set.ok) {
        goalSetError = set.error
        throw new Error(`goal not set: ${set.error}`)
      }
      debug(`${label}: goal set`)
      await settleTree(
        app,
        events,
        rootId,
        stats,
        (l) => debug(`${label}: ${l}`),
        20_000,
        answerCard,
        {
          timeoutMs: GOAL_TIMEOUT_MS,
          done: async () => {
            const view = await withTimeout(goalViewOf(app, rootId), 8000)
            if (!goalOver(view)) return false
            goalEndedAt = Date.now()
            return true
          }
        }
      )
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
    debug(`${label}: ${error}`)
  }
  const firstSnap = await firstWatch?.stop()

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
  // goal arms: the goal as it stands now (also after a timeout or an error)
  let goal: GoalRun | undefined
  if (isGoalArm(arm)) {
    const view =
      rootId && goalSetError === undefined
        ? await withTimeout(goalViewOf(app, rootId), 8000).catch(() => undefined)
        : undefined
    const end = goalEndedAt ?? Date.now()
    const notMet = notMetReasons(bySession.get(rootId) ?? [])
    goal = {
      objective: objective.text,
      truncatedChars: objective.truncatedChars,
      ...(goalSetError !== undefined ? { setError: goalSetError } : {}),
      status: view ? view.status : 'none',
      ...(view?.pauseReason ? { pauseReason: view.pauseReason } : {}),
      ...(view?.lastVerdict
        ? { verdict: view.lastVerdict.verdict, reason: view.lastVerdict.reason }
        : {}),
      turns: view?.turns ?? 0,
      wallSeconds: goalSetAt === undefined ? 0 : Math.round((end - goalSetAt) / 1000),
      timedOut: goalSetAt !== undefined && goalSetError === undefined && goalEndedAt === undefined,
      notMet
    }
    if (goalSetAt !== undefined && goalSetError === undefined) {
      // the first verdict: as the renderer recorded it; else what the end state still shows of it
      const seen = await goalSeen(app).catch(() => undefined)
      const fromEnd =
        view?.lastVerdict && (view.turns ?? 0) === 0
          ? view.lastVerdict
          : notMet.length > 0
            ? { verdict: 'not_met' as const, reason: notMet[0], nextStep: undefined }
            : undefined
      const v = seen?.verdict ?? fromEnd
      goal.first = {
        ...(v
          ? {
              verdict: v.verdict,
              reason: v.reason,
              ...(v.nextStep ? { nextStep: v.nextStep } : {})
            }
          : {}),
        verdictFrom: seen?.verdict ? 'events' : fromEnd ? 'end state' : 'none'
      }
    }
  }
  // the repo lives in the fake HOME: keep it until it is graded
  await app.stop({ keepHome: true })
  const redact = (t: string): string =>
    [key, simKey ?? ''].filter(Boolean).reduce((acc, k) => acc.split(k).join('<redacted>'), t)
  writeFileSync(join(OUT, `${label}.md`), redact(transcriptMd(label, sessions, bySession)))
  if (shape) {
    writeFileSync(
      join(OUT, `${label}.planner.md`),
      redact(plannerTranscript(label, shape.planner, plannerMessages))
    )
  }
  if (sim) {
    writeFileSync(
      join(OUT, `${label}.user.json`),
      redact(
        JSON.stringify(
          { conversation: conv, rounds, review: shape?.review, calls: sim.log },
          null,
          2
        )
      )
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
  // goal arm: grade the repo as the judge's first check saw it
  if (firstSnap) {
    try {
      if (goal?.first) {
        const at = gradeRepo(task, firstSnap.path, startSha)
        const factIds = task.user?.facts.map((f) => f.id) ?? []
        goal.first.snapshot = {
          atSeconds: firstSnap.atSeconds,
          sound: firstSnap.sound,
          note: firstSnap.note,
          pass: at.pass,
          core: at.core,
          visible: { pass: at.visible.pass, fail: at.visible.fail },
          failing: at.checks.filter((c) => c.core && !c.constraint && !c.pass).map((c) => c.name),
          ...(factIds.length
            ? { facts: { met: factsMet(factIds, at), total: factIds.length } }
            : {}),
          ...(at.graderError ? { graderError: at.graderError } : {})
        }
      }
    } catch (e) {
      if (goal?.first) goal.first.note = `grading the copy failed: ${String(e)}`
    } finally {
      rmSync(dirname(firstSnap.path), { recursive: true, force: true })
    }
  } else if (goal?.first) {
    goal.first.note = 'no copy: the first check was never seen'
  }
  // facts the user stated before any work: in its own script, or (goal-oracle, goal-shaped) in the goal text
  const factIds = task.user?.facts.map((f) => f.id) ?? []
  const stated =
    arm === 'goal-oracle'
      ? factIds
      : arm === 'goal-shaped'
        ? Object.keys(shape?.applied?.facts ?? {})
        : (task.user?.scripted ?? [])
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
    userWordsAttached: (() => {
      const quoted = sessions
        .filter((s) => s.id !== rootId)
        .flatMap((s) => bySession.get(s.id) ?? [])
        .filter((m) => m.role === 'user' && m.quoted > 0)
      return { sends: quoted.length, words: quoted.reduce((n, m) => n + m.quoted, 0) }
    })(),
    ...(user ? { user } : {}),
    compactions: all.filter((m) => m.compaction).length,
    contextWindow,
    ...(goal ? { goal } : {}),
    ...(shape ? { shape } : {}),
    error
  }
  records.push(record)
  writeFileSync(join(OUT, 'summary.md'), redact(renderSummary()))
  writeFileSync(join(OUT, 'summary.json'), redact(JSON.stringify(records, null, 2)))
  console.log(
    `[${label}] ${grade.pass ? 'PASS' : 'FAIL'} core ${grade.core.passed}/${grade.core.total}` +
      `${grade.constraints.total ? `, rules ${grade.constraints.kept}/${grade.constraints.total}` : ''}` +
      `${goal ? `, goal ${goal.status}${goal.pauseReason ? ` (${goal.pauseReason})` : ''} after ${goal.turns} continuations` : ''}` +
      `${goal?.first ? `, first check ${goal.first.verdict ?? 'no verdict'} on a ${goal.first.snapshot ? (goal.first.snapshot.pass ? 'passing' : 'failing') : 'missing'} state (${trapClassOf(record)})` : ''}` +
      `${user && factIds.length ? `, facts ${user.met.length}/${factIds.length}` : ''}${shape ? `; ${shapeLine(record)}` : ''} → ${OUT}`
  )
}

// ─────────────────────────── entry ───────────────────────────

const selected = TASKS.filter((t) => inSet(t) && TASK_IDS.includes(t.id))

/**
 * The arms a task runs. s1: the tasks with hidden facts take PROBE_ARMS; the controls (catval, long, trap) take
 * the planner arm, or goal-shaped with PROBE_S1_CONTROLS=full.
 */
const armsFor = (task: CodingTask): Arm[] =>
  SET === 's1' && !hasFacts(task) ? [S1_CONTROLS === 'full' ? 'goal-shaped' : 'planner'] : ARMS

for (const task of selected) {
  for (const arm of armsFor(task)) {
    // a user who speaks on its own (prelude, mid-task) is not one who set a goal and left
    if ((isGoalArm(arm) || arm === 'planner') && (task.user?.prelude || task.user?.midTask))
      throw new Error(
        `the ${arm} arm sets a goal and leaves; ${task.id} has a scripted user (the handoff set), which it cannot run`
      )
    if (arm === 'goal-oracle' && !task.user)
      throw new Error(
        `goal-oracle writes the hidden facts into the goal; ${task.id} has none (use the ambig set or s1)`
      )
  }
}

/** The goal-shaped machinery without a model: planner md, parsers, review, renderers, oracle texts */
function selfCheckShaping(): void {
  // the planner md: an agent md with the read-only tools, no ask, thinking declared
  const md = parseAgentDefinitionFile(readFileSync(PLANNER_MD_PATH, 'utf8'), 'goal-planner')
  expect(md, `${PLANNER_MD_PATH} parses as an agent md`).toBeTruthy()
  expect(md?.name).toBe('goal-planner')
  expect([...(md?.tools ?? [])].sort()).toEqual(['glob', 'grep', 'ls', 'read'])
  expect(md?.thinkingLevel, 'shuvix-thinking declared').toBeTruthy()
  expect(asUserAgent(readFileSync(PLANNER_MD_PATH, 'utf8'), 'work')).toMatch(/^name: work$/m)

  // the planner's answer: the last json fence wins; prose and other fences around it are fine
  const example: PlannerDraft = {
    verdict: 'shape',
    criteria: [
      {
        text: '默认表格不再列出 60 天没出过货的商品',
        proof: '用 seed 数据跑 `stockroom report lowstock`'
      },
      { text: '`npm test` 全部通过，且有新用例覆盖新规则', proof: '`npm test` 的输出' }
    ],
    decisions: [
      {
        question: '怎样算「常年不动」？',
        options: ['最近 60 天没出过货', '最近 30 天没出过货', '最近 90 天没出过货'],
        recommended: '最近 60 天没出过货',
        why: '决定哪些商品会被藏起来'
      },
      {
        question: '库存还够用多久就不必显示？',
        options: ['超过 14 天', '超过 7 天', '不按天数'],
        recommended: '超过 14 天',
        why: '决定「马上补货」的边界'
      }
    ],
    assumptions: ['加一个 `--all`，显示和现在完全一样的表格'],
    nonGoals: ['`--json` 的输出和 `GET /reports/lowstock` 的返回']
  }
  const answer = [
    '我看了 `src/report/lowstock.js`。',
    '```js\nconst x = { a: 1 }\n```',
    '```json',
    JSON.stringify({
      ...example,
      verdict: 'ready',
      criteria: [],
      decisions: [],
      assumptions: [],
      nonGoals: []
    }),
    '```',
    '改一下，最终版本：',
    '```json',
    JSON.stringify(example, null, 2),
    '```'
  ].join('\n')
  const parsed = parsePlannerAnswer(answer)
  expect(parsed).toEqual({ ok: true, draft: example, violations: [] })
  // no fence: the last {...} that parses
  expect(extractJson(`结论如下 {"verdict":"ready"} 完`)).toBe('{"verdict":"ready"}')
  expect(parsePlannerAnswer('{"verdict": "ready", "criteria": []}')).toMatchObject({
    ok: true,
    draft: { verdict: 'ready' },
    violations: []
  })
  // what is an error, and what is mended
  expect(parsePlannerAnswer('没有 JSON')).toMatchObject({ ok: false })
  expect(parsePlannerAnswer('```json\n{"verdict": "maybe"}\n```')).toMatchObject({ ok: false })
  expect(parsePlannerAnswer('```json\n{"verdict": "shape", \n```')).toMatchObject({ ok: false })
  const over = parsePlannerAnswer(
    JSON.stringify({
      verdict: 'SHAPE',
      criteria: [...Array(10).keys()].map((i) =>
        i === 0 ? `c${i}` : { text: `c${i}`, proof: 'p' }
      ),
      decisions: [
        ...[...Array(4).keys()].map((i) => ({
          question: `q${i}`,
          options: ['a', 'b', 'c', 'd', 'e'],
          recommended: i === 0 ? 'z' : 'b',
          why: 'w'
        })),
        { question: 'no options', options: [] }
      ],
      assumptions: [...Array(7).keys()].map((i) => `s${i}`),
      nonGoals: 'not a list'
    })
  )
  expect(over.ok).toBe(true)
  if (over.ok) {
    expect(over.draft.verdict).toBe('shape')
    expect(over.draft.criteria).toHaveLength(DRAFT_LIMITS.criteria)
    expect(over.draft.criteria[0]).toEqual({ text: 'c0', proof: '' })
    expect(over.draft.decisions).toHaveLength(DRAFT_LIMITS.decisions)
    expect(over.draft.decisions[0].options).toEqual(['a', 'b', 'c', 'd'])
    expect(over.draft.decisions[0].recommended).toBe('a')
    expect(over.draft.assumptions).toHaveLength(DRAFT_LIMITS.assumptions)
    expect(over.draft.nonGoals).toEqual([])
    console.log(`[shaping] contract breaches mended: ${over.violations.join('; ')}`)
    expect(over.violations.length).toBeGreaterThanOrEqual(6)
  }
  expect(
    parsePlannerAnswer(JSON.stringify({ verdict: 'shape' })),
    'shape with an empty draft is kept, and flagged'
  ).toMatchObject({
    ok: true,
    violations: ['shape with an empty draft (the goal is the request alone)']
  })

  // the review form, a review, and the goal text (quiet: F1 30 days, F2 14 days, F3 --json / HTTP, F4 --all)
  const quiet = TASKS.find((t) => t.id === 'quiet') as CodingTask
  const shown = reviewText(example)
  expect(shown.split('\n').map((l) => l.slice(0, 3))).toEqual([
    '需要你',
    'D1.',
    'D2.',
    '替你定',
    'S1.',
    '做到这',
    'A1.',
    'A2.',
    '不要动',
    'N1.'
  ])
  const raw = JSON.stringify({
    decisions: [
      { id: 'd1', answer: '最近 30 天一件都没出过货的不显示', facts: ['F1', 'F9'] },
      { id: 'D2', answer: '超过 14 天', facts: ['F2'] },
      { id: 'D7', answer: '?', facts: [] }
    ],
    edits: [
      { id: 'A1', action: 'change', text: '默认表格不再列出 30 天没出过货的商品', facts: ['F1'] },
      { id: 'X1', action: 'change', text: '?', facts: [] },
      { id: 'S9', action: 'drop', facts: [] }
    ],
    additions: [
      { section: 'nonGoals', text: '只改给人看的表格', about: 'N1', facts: ['F3'] },
      { section: 'criteria', text: '顺手加个导出', about: '', facts: [] },
      { section: 'nowhere', text: '?', about: 'A1', facts: [] }
    ],
    alreadyRight: ['F4', 'F3']
  })
  const review = parseReview(`好的：\n${raw}`, quiet.user?.facts ?? []) as DraftReview
  expect(review).toBeTruthy()
  expect(review.decisions[0]).toEqual({
    id: 'D1',
    answer: '最近 30 天一件都没出过货的不显示',
    facts: ['F1']
  })
  expect(review.additions).toHaveLength(2)
  const applied = applyReview(example, review, ['F1', 'F2', 'F3', 'F4'])
  expect(applied.facts).toEqual({ F1: 'decision', F2: 'decision', F3: 'added', F4: 'already' })
  expect(applied.decisionsWithFact).toBe(2)
  expect(applied.noiseDecisions).toBe(0)
  expect(applied.accepted.criteria[0].text).toBe('默认表格不再列出 30 天没出过货的商品')
  expect(applied.accepted.criteria[0].proof).toBe(example.criteria[0].proof)
  expect(applied.accepted.nonGoals).toEqual([...example.nonGoals, '只改给人看的表格'])
  expect(applied.ignored).toHaveLength(4)
  const text = goalTextShaped(quiet.prompt, applied.accepted)
  expect(
    text.startsWith(`${quiet.prompt}\n\n已定的决定：\n1. 怎样算「常年不动」？ → 最近 30 天`)
  ).toBe(true)
  const order = ['已定的决定：', '替你定的：', '做到这些算完：', '不要动：'].map((h) =>
    text.indexOf(h)
  )
  expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true)
  console.log(`[shaping] quiet, the proposal's example draft as the user reads it:\n${shown}`)
  console.log(`[shaping] quiet, after the review (goal text, ${text.length} chars):\n${text}`)
  // no review (no hidden facts, or the review failed): accepted as it is, recommended options, all noise
  const plain = applyReview(example, undefined, [])
  expect(plain.accepted.decisions.map((d) => d.answer)).toEqual([
    '最近 60 天没出过货',
    '超过 14 天'
  ])
  expect(plain.noiseDecisions).toBe(2)
  expect(plain.facts).toEqual({})
  expect(
    goalTextShaped('只是请求', { decisions: [], assumptions: [], criteria: [], nonGoals: [] })
  ).toBe('只是请求')

  // the 4000-character limit (trimmed length)
  expect(fitObjective(`  ${'x'.repeat(4000)}  `)).toEqual({
    text: 'x'.repeat(4000),
    truncatedChars: 0
  })
  const cut = fitObjective('y'.repeat(4100))
  expect(cut.text.length).toBe(4000)
  expect(cut.text.endsWith('…')).toBe(true)
  expect(cut.truncatedChars).toBe(101)
  const longest = goalTextShaped('z'.repeat(500), {
    decisions: [...Array(3).keys()].map(() => ({
      question: 'q'.repeat(300),
      answer: 'a'.repeat(300)
    })),
    assumptions: [...Array(5).keys()].map(() => 's'.repeat(300)),
    criteria: [...Array(8).keys()].map(() => ({ text: 'c'.repeat(200), proof: 'p'.repeat(100) })),
    nonGoals: [...Array(5).keys()].map(() => 'n'.repeat(300))
  })
  expect(fitObjective(longest).text.length).toBeLessThanOrEqual(4000)

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
    expect(o.length).toBeLessThanOrEqual(4000)
    console.log(`[shaping] goal-oracle ${t.id}: ${o.length} chars, ${items.length} item(s)`)
  }

  // the report on made-up records: every table renders, and the thresholds come out as the numbers say
  const facts = ['F1', 'F2', 'F3', 'F4']
  const fake = (
    arm: Arm,
    task: string,
    met: string[],
    more: Partial<RunRecord> = {}
  ): RunRecord => {
    const grade: Grade = {
      ...NOT_GRADED,
      graderError: undefined,
      pass: met.length === facts.length,
      core: { passed: met.length, total: facts.length },
      checks: facts.map((f) => ({ name: f, core: true, fact: f, pass: met.includes(f) }))
    }
    const goal: GoalRun = {
      objective: quiet.prompt,
      truncatedChars: 0,
      status: 'met',
      turns: 0,
      wallSeconds: 90,
      timedOut: false,
      notMet: [],
      first: {
        verdict: 'met',
        verdictFrom: 'events',
        snapshot: {
          atSeconds: 80,
          sound: true,
          note: 'made up',
          pass: grade.pass,
          core: grade.core,
          visible: { pass: 22, fail: 0 },
          failing: [],
          facts: { met, total: facts.length }
        }
      }
    }
    return {
      model: 'm',
      modelId: 'm',
      arm,
      task,
      run: 1,
      seconds: 100,
      grade: arm === 'planner' ? NOT_GRADED : grade,
      sessions: [],
      requests: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolCalls: {},
      rootToolCalls: 0,
      skimBeforeDispatch: 0,
      rootEdits: 0,
      dispatches: [],
      exploreCalls: 0,
      settle: { questions: 0, permissions: 0, refused: 0, unansweredSubQuestions: 0 },
      followUps: 0,
      finalReply: '',
      agents: [],
      userWordsAttached: { sends: 0, words: 0 },
      ...(arm === 'planner' || task !== 'quiet'
        ? {}
        : { user: userReport(facts, [], grade, [], [], false, []) }),
      compactions: 0,
      contextWindow: 0,
      ...(isGoalArm(arm) ? { goal } : {}),
      ...more
    }
  }
  const planner = (verdict: 'ready' | 'shape', seconds: number): PlannerRun => ({
    md: PLANNER_MD_PATH,
    sessionId: 's',
    input: quiet.prompt,
    verdict,
    violations: [],
    draft: verdict === 'ready' ? { ...example, verdict, decisions: [] } : example,
    seconds,
    thinkingLevel: 'medium',
    tools: ['read', 'ls', 'grep', 'glob'],
    identity: 'made up',
    toolCalls: { read: 2 },
    asks: 0,
    finalText: ''
  })
  const shapeOf = (p: PlannerRun, a?: AppliedReview): ShapeRecord => ({
    planner: p,
    reviewBy: a ? 'sim' : 'none',
    reviewSeconds: a ? 10 : 0,
    ...(a ? { review, applied: a } : {}),
    shown: a ? shown : '',
    objective: a ? text : quiet.prompt,
    truncatedChars: 0
  })
  records.push(
    fake('goal', 'quiet', ['F4']),
    fake('goal-oracle', 'quiet', facts),
    fake('goal-shaped', 'quiet', ['F1', 'F2', 'F4'], {
      shape: shapeOf(planner('shape', 50), applied)
    }),
    fake('planner', 'orders', [], { shape: shapeOf(planner('ready', 40)) }),
    fake('planner', 'avgcost', [], { shape: shapeOf(planner('shape', 120)) })
  )
  try {
    const report = renderSummary()
    const s1 = report.slice(report.indexOf('## S1'))
    for (const want of [
      '| m | goal | 1 | 0/1 | 1/4 (25%) | quiet 1/4 |',
      '| m | goal-oracle | 1 | 1/1 | 4/4 (100%) | quiet 4/4 |',
      '| m | goal-shaped | 1 | 0/1 | 3/4 (75%) | quiet 3/4 |',
      '- (i) the goal arm loses facts against goal-oracle: PASS',
      '- (ii) goal-shaped recovers at least half of the gap: PASS',
      'recovered 67% of the gap',
      '- (iii) controls: the planner says ready on ≥ 6/7 and asks ≤ 1 decision per run on average: FAIL',
      'ready 1/2 (50%)',
      '- (iv) median shaping (planner) time ≤ 90 s: PASS — median 50 s over 3 planner run(s)'
    ])
      expect(s1, want).toContain(want)
    // the planner arm stays out of the tables about the code
    expect(report.slice(0, report.indexOf('## S1'))).not.toContain('| m | planner |')
    console.log(`[shaping] S1 section on made-up records:\n${s1.slice(0, s1.indexOf('\n## Runs'))}`)
  } finally {
    records.length = 0
  }
}

if (SELFCHECK) {
  it('self-check goal-shaped: planner md, planner-answer parser, review, renderers, oracle texts', () =>
    selfCheckShaping())
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
        for (const arm of armsFor(task)) {
          // the early message is one more settle; a goal runs until it ends (or PROBE_GOAL_TIMEOUT_MIN); the
          // planner (goal-shaped, planner) runs first, until it ends (or PROBE_PLANNER_TIMEOUT_MIN)
          const extra = task.early ? TURN_TIMEOUT_MS : 0
          const planner = runsPlanner(arm) ? PLANNER_TIMEOUT_MS + 5 * 60 * 1000 : 0
          it(
            `${modelName} / ${arm} / ${task.id} / #${run}`,
            () => runOne(modelName, arm, task, run),
            arm === 'planner'
              ? planner
              : (isGoalArm(arm) ? GOAL_TIMEOUT_MS + TURN_TIMEOUT_MS * 2 : TURN_TIMEOUT_MS * 3) +
                  extra +
                  planner
          )
        }
      }
    }
  }
}
