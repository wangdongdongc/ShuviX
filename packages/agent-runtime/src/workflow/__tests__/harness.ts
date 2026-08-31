/**
 * Workflow 引擎测试的共享夹具（**非 .test.ts —— 不被 vitest 收集**）。
 *
 * engine.test.ts / engineLanes.test.ts / engineInvoke.test.ts 共用同一套 fake deps：
 * 三份各自 copy-paste 的 fake 引擎迟早会漂移，而「AsyncFunction 引擎的语义等价于
 * node:vm 包装」这条前提一旦在其中一份里悄悄变了，另外两份的结论就不可比。
 *
 * 观测面约定：meta 记录在 fire/invoke 的**同步段**落盘（startRun 首个 await 之前），
 * 所以「fire 后立即断言 meta 有无」是确定性的，负向用例不需要等待；end 记录异步落盘，
 * 用 waitEnd 轮询。
 */
import { expect, vi } from 'vitest'
import { createWorkflowEngine, type WorkflowEngineDeps, type WorkflowScriptEngine } from '../engine'
import type { TriggerPayloadMap } from '../triggerPoints'
import type { ParsedWorkflowFile, WorkflowConcurrency } from '../workflowFile'
import type { WorkflowRegistryEntry } from '../engine'
import type { RunTaskParams, SubAgentManager } from '../../subagent/manager'
import type { InProcessAgentType } from '../../subagent/types'

/** AsyncFunction 引擎：api 键作形参、脚本串作函数体 —— 顶层 await/return 语义与 vm 包装一致 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...vals: unknown[]) => Promise<unknown>

export const scriptEngine: WorkflowScriptEngine = {
  compile: () => ({ ok: true }),
  execute: async (source, api) =>
    new AsyncFunction(...Object.keys(api), source)(...Object.values(api))
}

export const PROFILE: InProcessAgentType = {
  name: 'worker',
  displayName: 'Worker',
  description: '',
  tools: ['read', 'grep', 'mcp:MyServer'],
  systemPrompt: 'S'
}
export const MODEL = { provider: 'p', model: 'm', capabilities: {} }

export const fileOf = (over: Partial<ParsedWorkflowFile> = {}): ParsedWorkflowFile => ({
  name: 'wf',
  displayName: 'wf',
  description: '',
  bindings: [{ trigger: 'session.prompt-accepted', when: undefined, params: {} }],
  vars: {},
  limits: {},
  concurrency: 'skip' as WorkflowConcurrency,
  script: 'return 1',
  prompts: {},
  schemas: {},
  ...over
})

export const entryOf = (
  file: ParsedWorkflowFile,
  over: Partial<WorkflowRegistryEntry> = {}
): WorkflowRegistryEntry => ({ file, source: 'builtin', ...over })

export const payload = (
  over: Partial<TriggerPayloadMap['session.prompt-accepted']> = {}
): TriggerPayloadMap['session.prompt-accepted'] => ({
  sessionId: 's1',
  profileName: 'default',
  title: 'T',
  isDefaultTitle: false,
  promptText: 'hi',
  ...over
})

export interface RecordedRec {
  name: string
  runId: string
  rec: Record<string, unknown>
}

export interface EngineHarness {
  engine: ReturnType<typeof createWorkflowEngine>
  records: RecordedRec[]
  logs: string[]
  runTask: ReturnType<typeof vi.fn>
  /** 脚本引擎的 execute 间谍 —— 「脚本根本没被执行」这类断言的唯一可靠面 */
  execute: ReturnType<typeof vi.fn>
  waitEnd: (n?: number) => Promise<void>
  ends: () => Array<Record<string, unknown>>
  metas: () => Array<Record<string, unknown>>
  /** meta 记录里的 lane 字段（分道断言的高频取值） */
  lanes: () => Array<unknown>
}

export function makeEngine(
  opts: {
    entries?: WorkflowRegistryEntry[]
    listWorkflows?: () => WorkflowRegistryEntry[]
    runTask?: (p: RunTaskParams) => Promise<{ result: string; structured?: unknown }>
    resolveAgentProfile?: WorkflowEngineDeps['resolveAgentProfile']
    resolveRunModel?: WorkflowEngineDeps['resolveRunModel']
    /** 附件回读接缝；不传 = 宿主没有这个能力（引擎应当忽略 attach 并留一条 log） */
    resolveAttachments?: WorkflowEngineDeps['resolveAttachments']
    onRecord?: (name: string, runId: string, rec: Record<string, unknown>) => void
    script?: WorkflowScriptEngine
  } = {}
): EngineHarness {
  const records: RecordedRec[] = []
  const logs: string[] = []
  const runTask = vi.fn(opts.runTask ?? (async () => ({ result: 'ok' })))
  const base = opts.script ?? scriptEngine
  const execute = vi.fn(base.execute)
  const engine = createWorkflowEngine({
    manager: { runTask } as unknown as SubAgentManager,
    script: { compile: base.compile, execute },
    listWorkflows: opts.listWorkflows ?? ((): WorkflowRegistryEntry[] => opts.entries ?? []),
    resolveAgentProfile: opts.resolveAgentProfile ?? ((ref) => (ref === 'worker' ? PROFILE : null)),
    resolveRunModel: opts.resolveRunModel ?? (async () => MODEL),
    ...(opts.resolveAttachments ? { resolveAttachments: opts.resolveAttachments } : {}),
    onRecord: (name, runId, rec) => {
      records.push({ name, runId, rec })
      opts.onRecord?.(name, runId, rec)
    },
    env: { host: 'desktop', platform: 'darwin' },
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m)
    }
  })
  const ends = (): Array<Record<string, unknown>> =>
    records.filter((r) => r.rec.type === 'end').map((r) => r.rec)
  const metas = (): Array<Record<string, unknown>> =>
    records.filter((r) => r.rec.type === 'meta').map((r) => r.rec)
  return {
    engine,
    records,
    logs,
    runTask,
    execute,
    ends,
    metas,
    lanes: () => metas().map((m) => m.lane),
    waitEnd: (n = 1) =>
      vi.waitFor(() => {
        expect(ends().length).toBeGreaterThanOrEqual(n)
      })
  }
}

/** gate 版 runTask：每次调用挂起，测试端显式放行（skip/queue/parallel 用） */
export function gatedRunTask(): {
  runTask: (p: RunTaskParams) => Promise<{ result: string }>
  gates: Array<{ prompt: string; params: RunTaskParams; release: () => void }>
} {
  const gates: Array<{ prompt: string; params: RunTaskParams; release: () => void }> = []
  return {
    gates,
    runTask: (p) =>
      new Promise((resolve) =>
        gates.push({ prompt: p.prompt, params: p, release: () => resolve({ result: 'ok' }) })
      )
  }
}
