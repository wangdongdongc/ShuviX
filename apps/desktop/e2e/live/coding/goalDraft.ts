/**
 * Goal text for the coding probe's goal arms beyond the plain request — measurement S1 of the goal
 * spec-shaping proposal, built on the probe side only (no product code):
 *
 *   goal-oracle  the request plus the task's hidden facts as an explicit "done when" list (the upper bound)
 *   goal-shaped  the request plus a draft the goal planner (`md/goal-planner.md`) wrote and the user reviewed
 *
 * The planner's final message ends with a JSON block (contract S5): `verdict` ready | shape, `criteria` ≤ 8
 * ({text, proof}), `decisions` ≤ 3 ({question, options 2–4, recommended, why}), `assumptions` ≤ 5,
 * `nonGoals` ≤ 5. This module parses it defensively, renders it the way the user reviews it (ids D1 / S1 /
 * A1 / N1, decisions first with the recommended answer filled in), applies the user's review, and renders
 * the accepted draft into the goal text in the order of S6: decisions (resolved), assumptions, done when
 * (criteria with their proofs), do not touch. Everything is trimmed to the goal's 4000-character limit.
 * No model, no app: the probe's self-check runs all of it.
 *
 * The section headings are Chinese because every task's request is (the goal text reads as the user's).
 */
import { GOAL_OBJECTIVE_MAX_CHARS } from '@shuvix/chat-protocol/types/goal'
import type { CodingTask } from './tasks'

export const DRAFT_LIMITS = {
  criteria: 8,
  decisions: 3,
  minOptions: 2,
  maxOptions: 4,
  assumptions: 5,
  nonGoals: 5
} as const

export interface Criterion {
  text: string
  /** the command, file or output that shows it */
  proof: string
}

export interface Decision {
  question: string
  options: string[]
  /** one of `options` */
  recommended: string
  why: string
}

export interface PlannerDraft {
  verdict: 'ready' | 'shape'
  criteria: Criterion[]
  decisions: Decision[]
  assumptions: string[]
  nonGoals: string[]
}

export type ParsedPlan =
  | {
      ok: true
      draft: PlannerDraft
      /** what the answer broke of the contract and how it was mended (clipped, defaulted, dropped) */
      violations: string[]
    }
  | { ok: false; error: string }

const FENCE = /```[ \t]*([A-Za-z]*)[ \t]*\r?\n([\s\S]*?)```/g

/**
 * The JSON object the planner's answer ends with: the last fenced block that holds an object (a `json`
 * block preferred), else the largest `{…}` that parses and ends at the text's last `}`.
 */
export function extractJson(text: string): string | undefined {
  const blocks = [...text.matchAll(FENCE)]
    .map((m) => ({ lang: m[1].toLowerCase(), body: m[2].trim() }))
    .filter((b) => b.body.startsWith('{'))
  const json = blocks.filter((b) => b.lang === 'json')
  const pick = (json.length ? json : blocks).at(-1)
  if (pick) return pick.body
  const end = text.lastIndexOf('}')
  for (let i = text.indexOf('{'); i !== -1 && i < end; i = text.indexOf('{', i + 1)) {
    const candidate = text.slice(i, end + 1)
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      /* try the next opening brace */
    }
  }
  return undefined
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''

/** A string, or an object's `text` (models sometimes wrap list items) */
const itemText = (v: unknown): string =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? str((v as Record<string, unknown>).text)
    : str(v)

function listOf(raw: Record<string, unknown>, key: string, violations: string[]): unknown[] {
  const v = raw[key]
  if (v === undefined || v === null) return []
  if (Array.isArray(v)) return v
  violations.push(`${key} is not a list (ignored)`)
  return []
}

function clip<T>(xs: T[], max: number, key: string, violations: string[]): T[] {
  if (xs.length <= max) return xs
  violations.push(`${key}: ${xs.length} given, the first ${max} kept`)
  return xs.slice(0, max)
}

/** The planner's final message → its draft. A missing or unreadable block, or a bad verdict, is an error. */
export function parsePlannerAnswer(text: string): ParsedPlan {
  const json = extractJson(text)
  if (json === undefined) return { ok: false, error: 'no JSON block in the answer' }
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { ok: false, error: 'the JSON block is not an object' }
    raw = parsed as Record<string, unknown>
  } catch (e) {
    return { ok: false, error: `the JSON block does not parse: ${String((e as Error).message)}` }
  }
  const verdict = str(raw.verdict).toLowerCase()
  if (verdict !== 'ready' && verdict !== 'shape')
    return {
      ok: false,
      error: `verdict must be ready or shape, got ${JSON.stringify(raw.verdict)}`
    }
  const violations: string[] = []

  const criteria: Criterion[] = []
  for (const [i, v] of listOf(raw, 'criteria', violations).entries()) {
    const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    const text = itemText(v)
    if (!text) {
      violations.push(`criterion ${i + 1} has no text (dropped)`)
      continue
    }
    const proof = str(o.proof)
    if (!proof) violations.push(`criterion ${i + 1} names no proof`)
    criteria.push({ text, proof })
  }

  const decisions: Decision[] = []
  for (const [i, v] of listOf(raw, 'decisions', violations).entries()) {
    const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
    const question = str(o.question)
    const options = [
      ...new Set((Array.isArray(o.options) ? o.options : []).map(itemText).filter(Boolean))
    ]
    if (!question || options.length === 0) {
      violations.push(`decision ${i + 1} has no question or no options (dropped)`)
      continue
    }
    if (options.length < DRAFT_LIMITS.minOptions)
      violations.push(`decision ${i + 1} has ${options.length} option(s)`)
    const kept = clip(options, DRAFT_LIMITS.maxOptions, `decision ${i + 1} options`, violations)
    let recommended = str(o.recommended)
    if (!kept.includes(recommended)) {
      const near = kept.find(
        (x) => recommended && (x.startsWith(recommended) || recommended.startsWith(x))
      )
      violations.push(
        `decision ${i + 1}: recommended ${JSON.stringify(recommended)} is not one of the options (${near ? 'matched by prefix' : 'the first option taken'})`
      )
      recommended = near ?? kept[0]
    }
    const why = str(o.why)
    if (!why) violations.push(`decision ${i + 1} says no why`)
    decisions.push({ question, options: kept, recommended, why })
  }

  const strings = (key: 'assumptions' | 'nonGoals'): string[] =>
    clip(
      listOf(raw, key, violations).map(itemText).filter(Boolean),
      DRAFT_LIMITS[key],
      key,
      violations
    )
  const draft: PlannerDraft = {
    verdict,
    criteria: clip(criteria, DRAFT_LIMITS.criteria, 'criteria', violations),
    decisions: clip(decisions, DRAFT_LIMITS.decisions, 'decisions', violations),
    assumptions: strings('assumptions'),
    nonGoals: strings('nonGoals')
  }
  const items =
    draft.criteria.length +
    draft.decisions.length +
    draft.assumptions.length +
    draft.nonGoals.length
  if (verdict === 'ready' && items > 0)
    violations.push(`ready with ${items} draft item(s) (the goal is the request alone)`)
  if (verdict === 'shape' && items === 0)
    violations.push('shape with an empty draft (the goal is the request alone)')
  return { ok: true, draft, violations }
}

// ─────────────────────────── the user's review ───────────────────────────

/** Item ids as the user sees them: D decisions, S assumptions, A criteria (done when), N do-not-touch */
const ID = { decisions: 'D', assumptions: 'S', criteria: 'A', nonGoals: 'N' } as const

/** The draft as the user reviews it (S6): decisions first with the recommended answer filled in */
export function reviewText(d: PlannerDraft): string {
  const out: string[] = []
  if (d.decisions.length) {
    out.push('需要你定（已填推荐，不同意就改）：')
    for (const [i, x] of d.decisions.entries()) {
      const others = x.options.filter((o) => o !== x.recommended)
      out.push(
        `${ID.decisions}${i + 1}. ${x.question} → 推荐：${x.recommended}` +
          `${others.length ? `（备选：${others.join(' / ')}）` : ''}${x.why ? `。为什么要定：${x.why}` : ''}`
      )
    }
  }
  if (d.assumptions.length) {
    out.push('替你定的：')
    for (const [i, x] of d.assumptions.entries()) out.push(`${ID.assumptions}${i + 1}. ${x}`)
  }
  if (d.criteria.length) {
    out.push('做到这些算完：')
    for (const [i, x] of d.criteria.entries())
      out.push(`${ID.criteria}${i + 1}. ${x.text}${x.proof ? `（证明：${x.proof}）` : ''}`)
  }
  if (d.nonGoals.length) {
    out.push('不要动：')
    for (const [i, x] of d.nonGoals.entries()) out.push(`${ID.nonGoals}${i + 1}. ${x}`)
  }
  return out.join('\n')
}

/** What the user did with the draft (the simulated user's review, validated by simUser.ts) */
export interface DraftReview {
  /** one per decision: the answer (an option verbatim, or the user's own words) and the facts it used */
  decisions: Array<{ id: string; answer: string; facts: string[] }>
  /** items changed or dropped because they contradict a fact; items not listed stay as they are */
  edits: Array<{
    id: string
    action: 'change' | 'drop'
    text?: string
    proof?: string
    facts: string[]
  }>
  /** facts added because an item or decision (`about`) touches the point and leaves the fact out */
  additions: Array<{
    section: 'assumptions' | 'criteria' | 'nonGoals'
    text: string
    proof?: string
    about: string
    facts: string[]
  }>
  /** facts the draft already stated correctly */
  alreadyRight: string[]
}

export interface AcceptedDraft {
  decisions: Array<{ question: string; answer: string }>
  assumptions: string[]
  criteria: Criterion[]
  nonGoals: string[]
}

/** How a fact got into the accepted text */
export type FactEntry = 'decision' | 'corrected' | 'added' | 'already'

export interface AppliedReview {
  accepted: AcceptedDraft
  /** each fact in the accepted text, and how it got there (first of: decision, corrected, added, already) */
  facts: Record<string, FactEntry>
  /** decisions whose answer used a fact */
  decisionsWithFact: number
  /** decisions that touched no fact (noise); with no review, every decision */
  noiseDecisions: number
  /** review entries the probe did not apply: unknown ids, unanswered decisions, additions not anchored */
  ignored: string[]
}

/**
 * Apply the user's review to the draft. No review (a task without hidden facts, or a failed review): the
 * draft is accepted as it is, each decision answered with its recommended option.
 */
export function applyReview(
  d: PlannerDraft,
  review: DraftReview | undefined,
  factIds: string[]
): AppliedReview {
  const known = new Set(factIds)
  const facts: Record<string, FactEntry> = {}
  const enter = (ids: string[], how: FactEntry): void => {
    for (const f of ids) if (known.has(f) && !facts[f]) facts[f] = how
  }
  const ignored: string[] = []
  const accepted: AcceptedDraft = {
    decisions: d.decisions.map((x) => ({ question: x.question, answer: x.recommended })),
    assumptions: [...d.assumptions],
    criteria: d.criteria.map((c) => ({ ...c })),
    nonGoals: [...d.nonGoals]
  }
  if (!review) {
    return {
      accepted,
      facts,
      decisionsWithFact: 0,
      noiseDecisions: d.decisions.length,
      ignored
    }
  }
  let decisionsWithFact = 0
  for (const [i] of d.decisions.entries()) {
    const id = `${ID.decisions}${i + 1}`
    const r = review.decisions.find((x) => x.id === id)
    if (!r || !r.answer.trim()) {
      ignored.push(`${id} not answered (recommended taken)`)
      continue
    }
    accepted.decisions[i].answer = r.answer.trim()
    const used = r.facts.filter((f) => known.has(f))
    if (used.length) decisionsWithFact++
    enter(used, 'decision')
  }
  for (const r of review.decisions)
    if (!/^D\d+$/.test(r.id) || Number(r.id.slice(1)) > d.decisions.length)
      ignored.push(`answer to unknown decision ${r.id}`)

  // edits: by id, on the draft's own numbering; drops last so indexes hold while changing
  type Section = 'assumptions' | 'criteria' | 'nonGoals'
  const sectionOf = (id: string): { section: Section; index: number } | undefined => {
    const m = /^([SAN])(\d+)$/.exec(id)
    if (!m) return undefined
    const section: Section = m[1] === 'S' ? 'assumptions' : m[1] === 'A' ? 'criteria' : 'nonGoals'
    const index = Number(m[2]) - 1
    return index >= 0 && index < d[section].length ? { section, index } : undefined
  }
  const drops: Record<Section, Set<number>> = {
    assumptions: new Set(),
    criteria: new Set(),
    nonGoals: new Set()
  }
  for (const e of review.edits) {
    const at = sectionOf(e.id)
    if (!at) {
      ignored.push(`edit of unknown item ${e.id}`)
      continue
    }
    if (e.action === 'drop') {
      drops[at.section].add(at.index)
      continue
    }
    const text = (e.text ?? '').trim()
    if (!text) {
      ignored.push(`change of ${e.id} without text`)
      continue
    }
    if (at.section === 'criteria')
      accepted.criteria[at.index] = {
        text,
        proof: (e.proof ?? '').trim() || accepted.criteria[at.index].proof
      }
    else accepted[at.section][at.index] = text
    enter(e.facts, 'corrected')
  }
  for (const a of review.additions) {
    const anchored =
      sectionOf(a.about) !== undefined ||
      (/^D\d+$/.test(a.about) &&
        Number(a.about.slice(1)) <= d.decisions.length &&
        Number(a.about.slice(1)) >= 1)
    if (!anchored || !a.text.trim()) {
      ignored.push(
        `addition not anchored to a draft item (${a.about || 'no about'}): ${a.text.slice(0, 80)}`
      )
      continue
    }
    if (a.section === 'criteria')
      accepted.criteria.push({ text: a.text.trim(), proof: (a.proof ?? '').trim() })
    else accepted[a.section].push(a.text.trim())
    enter(a.facts, 'added')
  }
  enter(review.alreadyRight, 'already')
  accepted.assumptions = accepted.assumptions.filter((_, i) => !drops.assumptions.has(i))
  accepted.criteria = accepted.criteria.filter((_, i) => !drops.criteria.has(i))
  accepted.nonGoals = accepted.nonGoals.filter((_, i) => !drops.nonGoals.has(i))
  return {
    accepted,
    facts,
    decisionsWithFact,
    noiseDecisions: d.decisions.length - decisionsWithFact,
    ignored
  }
}

// ─────────────────────────── goal text ───────────────────────────

/** The accepted draft as goal text, after the request (S6 order); nothing accepted = the request alone */
export function goalTextShaped(request: string, a: AcceptedDraft): string {
  const out: string[] = []
  if (a.decisions.length) {
    out.push('已定的决定：')
    for (const [i, x] of a.decisions.entries()) out.push(`${i + 1}. ${x.question} → ${x.answer}`)
  }
  if (a.assumptions.length) {
    out.push('替你定的：')
    for (const x of a.assumptions) out.push(`- ${x}`)
  }
  if (a.criteria.length) {
    out.push('做到这些算完：')
    for (const [i, x] of a.criteria.entries())
      out.push(`${ID.criteria}${i + 1}. ${x.text}${x.proof ? `（证明：${x.proof}）` : ''}`)
  }
  if (a.nonGoals.length) {
    out.push('不要动：')
    for (const x of a.nonGoals) out.push(`- ${x}`)
  }
  return out.length ? `${request.trim()}\n\n${out.join('\n')}` : request.trim()
}

/**
 * The goal-oracle arm's text: the request, then "done when" with one item per hidden fact and the request's
 * own end condition last.
 */
export function goalTextOracle(task: CodingTask): string {
  const items = [
    ...(task.user?.facts ?? []).map((f) => f.text),
    ...(task.endCondition ? [task.endCondition] : [])
  ]
  if (!items.length) return task.prompt.trim()
  return [
    task.prompt.trim(),
    '',
    '做完的标准（每一条都要做到）：',
    ...items.map((t, i) => `${i + 1}. ${t}`)
  ].join('\n')
}

/** The goal's text cut to the product's limit (trimmed length ≤ 4000); `truncatedChars` = what was cut */
export function fitObjective(text: string): { text: string; truncatedChars: number } {
  const t = text.trim()
  if (t.length <= GOAL_OBJECTIVE_MAX_CHARS) return { text: t, truncatedChars: 0 }
  const kept = t.slice(0, GOAL_OBJECTIVE_MAX_CHARS - 1).trimEnd()
  return { text: `${kept}…`, truncatedChars: t.length - kept.length }
}
