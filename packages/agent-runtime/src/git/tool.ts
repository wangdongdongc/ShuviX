/**
 * git multiplex 工具 —— 单一工具承载全部本地 git 操作（两端共享，isomorphic-git 单后端）。
 *
 * 形态对照 browser/tool.ts：action 枚举 + 扁平可选参数超集，每个 action 一行描述；
 * 长尾细节走 action:"help"；参数错误只回该 action 的 usage。
 * 两端能力同集 → schema / description 为静态生成（无 caps 裁剪）。
 */
import { Type, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { GitToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { GitCache, GitEnv, GitOpOutput } from './env'
import { GIT_OPS, type GitAction, type GitOpParams, type GitOpSpec, type GitParamKey } from './ops'
import { buildGitHelp, GIT_HELP_TOPICS } from './help'
import {
  statusOp,
  logOp,
  showOp,
  addOp,
  unstageOp,
  commitOp,
  branchOp,
  checkoutOp,
  restoreOp,
  initOp
} from './gitOps'
import { diffOp } from './diffOps'

export const GIT_TOOL_NAME = 'git'

/** execute 收到的参数形状 */
interface GitToolParams extends GitOpParams {
  action: GitAction
}

/** 参数 schema（typebox）：action Literal Union + 扁平参数超集（静态，无 caps） */
export function buildGitParamsSchema(): TSchema {
  return Type.Object({
    action: Type.Union(
      GIT_OPS.map((op) => Type.Literal(op.name)),
      { description: 'The git operation to perform. Use "help" for the full manual.' }
    ),
    dir: Type.Optional(
      Type.String({
        description:
          'Repository directory (absolute, or relative to the working directory). Omit to use the working directory.'
      })
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Repo-relative paths — add/unstage/restore targets, or status filter. add supports ["."] for all changes.'
      })
    ),
    path: Type.Optional(Type.String({ description: 'Single file or directory filter — log/diff' })),
    message: Type.Optional(Type.String({ description: 'Commit message' })),
    ref: Type.Optional(
      Type.String({
        description: 'Branch or commit — log (default HEAD), show, checkout, restore (default HEAD)'
      })
    ),
    from: Type.Optional(Type.String({ description: 'diff: base commit' })),
    to: Type.Optional(Type.String({ description: 'diff: target commit (omit = worktree)' })),
    staged: Type.Optional(
      Type.Boolean({ description: 'diff: show index vs HEAD instead of worktree vs index' })
    ),
    depth: Type.Optional(Type.Number({ description: 'log: max commits to return (default 20)' })),
    name: Type.Optional(
      Type.String({ description: 'branch: name to create (and switch to) or delete' })
    ),
    delete: Type.Optional(
      Type.Boolean({ description: 'branch: delete the branch "name" instead of creating it' })
    ),
    force: Type.Optional(
      Type.Boolean({ description: 'checkout: overwrite conflicting local changes (DISCARDS them)' })
    ),
    authorName: Type.Optional(
      Type.String({ description: 'commit: author name (must be paired with authorEmail)' })
    ),
    authorEmail: Type.Optional(Type.String({ description: 'commit: author email' })),
    topic: Type.Optional(
      Type.Union(
        GIT_HELP_TOPICS.map((t) => Type.Literal(t)),
        { description: 'help topic (omit for the full manual)' }
      )
    )
  })
}

/** 工具 description：action 一行式清单 + 铁律 */
export function buildGitToolDescription(): string {
  const lines = GIT_OPS.map((op) => `${op.usage} — ${op.description}`)
  return `Local git version control — one tool, many actions. Set "action" plus the parameters that action needs. Prefer this tool over shell git for local repository operations.

Actions:
${lines.join('\n')}

Rules:
- Local operations only — no clone/fetch/pull/push (network git is out of scope).
- Operates on the working directory by default; pass "dir" to target another repository.
- restore and checkout(force:true) DISCARD local changes; commit first when unsure.
- On large repos pass paths/path filters to keep status/diff output small.`
}

export interface CreateGitToolOptions {
  /** 每次 execute 调用取最新环境（桌面 workingDirectory 可变；扩展可返回缓存实例） */
  getEnv: () => GitEnv | Promise<GitEnv>
  /**
   * 解析 "dir" 参数为仓库目录（归一 + 权限检查），未注入时工具拒绝带 dir 的调用。
   * mutates 为该 action 的读/写语义（写操作宿主应按写权限判定，如触发路径审批）；
   * 拒绝时 throw（错误文本回流给模型）。
   */
  resolveDir?: (
    requested: string,
    opts: { action: GitAction; mutates: boolean; toolCallId: string }
  ) => Promise<string>
  /** abort 时抛出的错误文案（桌面 'Aborted'，扩展 'TOOL_ABORTED'）；默认 'Aborted' */
  abortError?: string
  /** 工具显示名（宿主可传本地化值）；默认 'Git' */
  label?: string
}

type Result = AgentToolResult<GitToolDetails>

function toResult(action: string, out: GitOpOutput): Result {
  return {
    content: [{ type: 'text', text: out.text ?? '' }],
    details: { type: 'git', action, ...(out.details ?? {}) } as GitToolDetails
  }
}

function usageError(action: string, message: string, usage?: string): Result {
  const usageLine = usage ? `\n\nUsage: ${usage}` : ''
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${message}${usageLine}\n(Use action:"help" for the full manual.)`
      }
    ],
    details: { type: 'git', action, error: message }
  }
}

/** 校验必选参数（空字符串/空数组视为缺失） */
function missingParams(spec: GitOpSpec, params: GitToolParams): GitParamKey[] {
  const record = params as unknown as Record<string, unknown>
  return spec.required.filter((k) => {
    const v = record[k]
    return v == null || v === '' || (Array.isArray(v) && v.length === 0)
  })
}

async function dispatch(
  env: GitEnv,
  cache: GitCache,
  action: GitAction,
  params: GitToolParams
): Promise<GitOpOutput> {
  switch (action) {
    case 'status':
      return statusOp(env, cache, params)
    case 'log':
      return logOp(env, cache, params)
    case 'show':
      return showOp(env, cache, params)
    case 'diff':
      return diffOp(env, cache, params)
    case 'add':
      return addOp(env, cache, params)
    case 'unstage':
      return unstageOp(env, cache, params)
    case 'commit':
      return commitOp(env, cache, params)
    case 'branch':
      return branchOp(env, cache, params)
    case 'checkout':
      return checkoutOp(env, cache, params)
    case 'restore':
      return restoreOp(env, cache, params)
    case 'init':
      return initOp(env, cache, params)
    default:
      throw new Error(`Unhandled git action "${action}"`)
  }
}

export function createGitTool(opts: CreateGitToolOptions): AgentTool<TSchema, GitToolDetails> {
  const { getEnv, resolveDir, abortError = 'Aborted', label = 'Git' } = opts
  const specs = new Map(GIT_OPS.map((s) => [s.name, s]))
  /** isomorphic-git 共享缓存：工具实例（=会话）内按仓库目录隔离复用 */
  const caches = new Map<string, GitCache>()
  const cacheFor = (dir: string): GitCache => {
    let cache = caches.get(dir)
    if (!cache) {
      cache = {}
      caches.set(dir, cache)
    }
    return cache
  }

  return {
    name: GIT_TOOL_NAME,
    label,
    description: buildGitToolDescription(),
    parameters: buildGitParamsSchema(),
    async execute(toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<Result> {
      if (signal?.aborted) throw new Error(abortError)
      const params = rawParams as GitToolParams
      const action = params.action

      const spec = specs.get(action)
      if (!spec) {
        return usageError(
          String(action),
          `Unknown action "${String(action)}". Available: ${[...specs.keys()].join(', ')}.`
        )
      }

      if (spec.name === 'help') {
        return toResult('help', { text: buildGitHelp(params.topic) })
      }

      const missing = missingParams(spec, params)
      if (missing.length > 0) {
        return usageError(
          spec.name,
          `Missing required parameter${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} for ${spec.name}.`,
          spec.usage
        )
      }
      // spec 上表达不了的交叉约束：branch(delete:true) 必须带 name
      if (spec.name === 'branch' && params.delete && !params.name) {
        return usageError(spec.name, '"name" is required when delete:true.', spec.usage)
      }

      let env = await getEnv()
      if (params.dir) {
        if (!resolveDir) {
          return usageError(
            spec.name,
            'The "dir" parameter is not supported in this environment; omit it to operate on the working directory.'
          )
        }
        try {
          env = {
            ...env,
            dir: await resolveDir(params.dir, {
              action: spec.name,
              mutates: spec.mutates,
              toolCallId
            })
          }
        } catch (err) {
          if (signal?.aborted || (err instanceof Error && err.message === abortError)) throw err
          const message = err instanceof Error ? err.message : String(err)
          return usageError(spec.name, `Cannot access repository dir "${params.dir}": ${message}`)
        }
      }
      const out = await dispatch(env, cacheFor(env.dir), spec.name, params)
      if (signal?.aborted) throw new Error(abortError)
      return toResult(spec.name, out)
    }
  }
}
