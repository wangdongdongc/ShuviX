/**
 * SecurityContext —— PEP 门面。各工具调用点唯一入口：
 * 内部固定「装配 → 评估 →（enforce 时）执行 + 决策日志」的流水。
 * 客体属性文档在此构造（PEP 约定：该 type 的已知属性全部给值 —— strict 语义
 * 只用于跨 type 的误引用，见 celMatch.ts）。
 *
 * 实例可整会话复用：内部全是 getter（provider 的 grants/vars/用户策略每次现取），
 * 无任何快照 —— 会话中途开「免询问」或「允许并记住」落库后立即可见（禁缓存红线）。
 */
import { assembleRules } from './assemble'
import { projectCommandFacts, type CommandFactAttrs } from './commandFacts'
import { evaluate } from './evaluate'
import { executeDecision } from './enforce'
import { buildPolicyVars } from './policyVars'
import type {
  AccessMode,
  CommandObjectInput,
  EnforceOpts,
  EnforceOutcome,
  SecurityContext,
  SecurityDecision,
  SecurityEnvironment,
  SecurityHostProvider,
  SecurityObject,
  SecuritySubject
} from './types'

/** 结构属性的惰性挂载键 —— 与 commandFacts.ts 的投影字段一一对应 */
const COMMAND_FACT_KEYS = ['parsed', 'commands', 'writes'] as const

/**
 * 构造命令客体：`command` / `channel` 是即取的标量，结构属性走**惰性 + 记忆化** getter。
 *
 * 惰性：没有任何策略引用 `object.commands` 时，解析器一次都不会被调用。
 * 记忆化：cel-js 每次属性访问都会重新触发 getter，一条规则里多次引用不能重复解析。
 * 非枚举：让 JSON.stringify 看不到它们 —— 决策日志不该因为记录一次判定就把整棵树
 * 的抽取结果拖进日志，也不该因为序列化而反过来触发解析。
 */
function buildCommandObject(
  input: CommandObjectInput,
  provider: SecurityHostProvider
): SecurityObject {
  const object: SecurityObject = {
    type: 'command',
    command: input.command,
    channel: input.channel
  }
  let cached: CommandFactAttrs | null = null
  const facts = (): CommandFactAttrs => {
    if (!cached) {
      let analyzed
      try {
        analyzed = provider.shellParser?.analyze(input.command)
      } catch (err) {
        provider.logger?.warn(
          `shell 解析抛错，命令按未解析处理：${err instanceof Error ? err.message : String(err)}`
        )
      }
      cached = projectCommandFacts(analyzed, input.cwd, provider.pathSep)
    }
    return cached
  }
  for (const key of COMMAND_FACT_KEYS) {
    Object.defineProperty(object, key, { enumerable: false, get: () => facts()[key] })
  }
  return object
}

export function createSecurityContext(
  subject: SecuritySubject,
  environment: SecurityEnvironment,
  provider: SecurityHostProvider
): SecurityContext {
  const evaluateInternal = (
    action: string,
    object: SecurityObject,
    includeForceAllow: boolean,
    tool?: { name: string; operation?: string }
  ): SecurityDecision => {
    // 一次现取，装配（lets）与求值（match）共用同一份 —— 两处各取一次会给出
    // 不一致的授权视图，且 vars.granted* 缺席时授权会静默失效（见 policyVars.ts）
    const vars = buildPolicyVars(provider)
    const rules = assembleRules(provider, vars)
    return evaluate(
      rules,
      { subject, action, tool, object, environment },
      {
        includeForceAllow,
        // match 上下文的 vars 与 fail-safe 告警出口
        vars,
        warn: (msg) => provider.logger?.warn(msg)
      }
    )
  }

  const enforce = async (
    action: string,
    object: SecurityObject,
    opts: EnforceOpts
  ): Promise<EnforceOutcome> => {
    const t0 = Date.now()
    // 工具维度自动填充：每个 PEP 都带 opts.toolName（match 里的 tool.name 因此对全客体可用）
    const tool = { name: opts.toolName, operation: opts.operation }
    const decision = evaluateInternal(action, object, true, tool)
    return executeDecision({
      provider,
      request: { subject, action, tool, object, environment },
      decision,
      opts,
      evaluateMs: Date.now() - t0
    })
  }

  return {
    evaluate: (action, object, opts) =>
      evaluateInternal(action, object, opts?.includeForceAllow !== false),

    // 被动 UI 判定：includeForceAllow 缺省 false（per-path 授权不放宽 UI 范围），不记日志
    evaluateReadOnly: (action, object, opts) =>
      evaluateInternal(action, object, opts?.includeForceAllow === true).effect === 'allow',

    async enforcePath(mode: AccessMode, resolvedPath: string, opts: EnforceOpts): Promise<void> {
      await enforce(
        mode,
        { type: 'path', path: resolvedPath, displayPath: opts.displayPath ?? resolvedPath },
        opts
      )
    },

    async enforceCommand(object, opts): Promise<EnforceOutcome> {
      // 解析本身是同步的，wasm 初始化是异步的 —— 求值前先确保就绪。
      // 失败只记日志、不阻断：解析器仍未就绪时客体呈现为「未解析」，结构化规则
      // 不命中，命令落回 ask-on-command（解析器是进程级单例，若别处已初始化成功，
      // 这里的失败不影响解析）。wasm 加载不上属于开发期就该暴露的程序问题，
      // 不为它设计运行时兜底。
      try {
        await provider.shellParser?.ensureReady()
      } catch (err) {
        provider.logger?.warn(
          `shell 解析器初始化失败，命令按未解析处理：${err instanceof Error ? err.message : String(err)}`
        )
      }
      return enforce('execute', buildCommandObject(object, provider), opts)
    },

    // L1 全工具门：**allow 即非事件**（默认放行 / autoAllow force-allow / 静态 allow 同待遇）——
    // 跳过 executeDecision（不弹窗不记日志）。此门每次工具调用都过，若 allow 也记录，
    // 免询问会话会以每调用一条的速度刷爆 ring buffer；L1 的日志只留 ask/deny 的真实拦截信号
    async enforceInvocation(opts): Promise<EnforceOutcome> {
      const object = { type: 'invocation' } as const
      const probe = evaluateInternal('execute', object, true, {
        name: opts.toolName,
        operation: opts.operation
      })
      if (probe.effect === 'allow') return { status: 'allowed' }
      return enforce('execute', object, opts)
    },

    async enforceGitOp(object, opts): Promise<void> {
      await enforce(
        'execute',
        {
          type: 'gitTool',
          gitAction: object.gitAction,
          command: object.command,
          force: object.force,
          delete: object.delete
        },
        opts
      )
    },

    enforceDatabase: (object, opts) =>
      enforce(
        'execute',
        {
          type: 'database',
          sql: object.sql,
          credential: object.credential,
          dbType: object.dbType,
          readonly: object.readonly
        },
        opts
      )
  }
}
