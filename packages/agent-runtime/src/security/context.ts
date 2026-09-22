/**
 * SecurityContext —— PEP 门面。各工具调用点唯一入口：
 * 内部固定「（路径客体）解析真实去处 → 装配 → 评估 →（enforce 时）执行 + 决策日志」的流水。
 * 客体属性文档在此构造（PEP 约定：该 type 的已知属性全部给值 —— strict 语义
 * 只用于跨 type 的误引用，见 celMatch.ts）。
 *
 * **真实路径只在这里解析**（provider.realPath）：PEP 交来的是写法，策略要判的是位置。
 * 路径客体的 path 换成解析结果、requestedPath 留原样；同一个解析（带本次记忆）再递给
 * 评估，让 inDir 把它比较的目录也按位置比（见 types.ts SecurityHostProvider.realPath）。
 *
 * 实例可整会话复用：内部全是 getter（provider 的 grants/vars/用户策略每次现取），
 * 无任何快照 —— 会话中途开「免询问」或「允许并记住」落库后立即可见（禁缓存红线）。
 * 真实路径同理，每次评估现解析 —— 链接随时可能被改指向。
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
  // 仅 ssh 有；bash 不写这个键，好让策略用 has(object.host) 区分远端与本地
  if (input.host) object.host = input.host
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

/**
 * 路径客体换成它真正通向的地方：path = 解析结果（策略按它判、卡片按它问、授权按它记），
 * requestedPath = 调用方交来的原样（已带着的就保留 —— 重复解析幂等，不能把原样冲掉）。
 * 非路径客体原样返回：命令客体挂着惰性 getter，复制会把它们读出来。
 */
function atRealPath(
  object: SecurityObject,
  realPath: ((path: string) => string) | undefined
): SecurityObject {
  if (object.type !== 'path' || typeof object.path !== 'string') return object
  return {
    ...object,
    path: realPath ? realPath(object.path) : object.path,
    requestedPath: typeof object.requestedPath === 'string' ? object.requestedPath : object.path
  }
}

export function createSecurityContext(
  subject: SecuritySubject,
  environment: SecurityEnvironment,
  provider: SecurityHostProvider
): SecurityContext {
  /**
   * 一次评估用的真实路径解析：宿主 realPath 加本次的记忆表 —— 同一个目录被几条规则、几份
   * lets 引用只解析一次；解析结果也记成它自己（解析是幂等的），于是 inDir 拿客体已解析的
   * path 再来问时直接命中。**每次评估现建**，不跨评估缓存：链接随时可能被改指向。
   * 宿主没给解析器 → undefined（按写法比较）；解析抛错 → 该路径按原样比较并告警；
   * 给出空串或非字符串 → 按原样比较。
   */
  const realPathsForOneEvaluation = (): ((path: string) => string) | undefined => {
    if (!provider.realPath) return undefined
    const memo = new Map<string, string>()
    return (path) => {
      const known = memo.get(path)
      if (known !== undefined) return known
      let real = path
      try {
        const resolved = provider.realPath?.(path)
        if (typeof resolved === 'string' && resolved !== '') real = resolved
      } catch (err) {
        provider.logger?.warn(
          `realPath 解析抛错，该路径按原样比较：${path}（${err instanceof Error ? err.message : String(err)}）`
        )
      }
      memo.set(path, real)
      memo.set(real, real)
      return real
    }
  }

  const evaluateInternal = (
    action: string,
    object: SecurityObject,
    includeForceAllow: boolean,
    tool: { name: string; operation?: string } | undefined,
    realPath: ((path: string) => string) | undefined
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
        warn: (msg) => provider.logger?.warn(msg),
        // 与客体用的是同一个解析（同一张记忆表）：inDir 对客体已解析 path 的再解析直接命中
        realPath
      }
    )
  }

  /** 评估入口的公共前半段：路径客体解析真实去处，再评估（被动 UI 与 enforce 同一条路） */
  const judge = (
    action: string,
    object: SecurityObject,
    includeForceAllow: boolean,
    tool?: { name: string; operation?: string }
  ): { object: SecurityObject; decision: SecurityDecision } => {
    const realPath = realPathsForOneEvaluation()
    const resolved = atRealPath(object, realPath)
    return {
      object: resolved,
      decision: evaluateInternal(action, resolved, includeForceAllow, tool, realPath)
    }
  }

  const enforce = async (
    action: string,
    object: SecurityObject,
    opts: EnforceOpts
  ): Promise<EnforceOutcome> => {
    const t0 = Date.now()
    // 工具维度自动填充：每个 PEP 都带 opts.toolName（match 里的 tool.name 因此对全客体可用）
    const tool = { name: opts.toolName, operation: opts.operation }
    // 询问卡片、「允许并记住」与决策日志都拿解析后的客体 —— 与策略判的是同一个位置
    const judged = judge(action, object, true, tool)
    return executeDecision({
      provider,
      request: { subject, action, tool, object: judged.object, environment },
      decision: judged.decision,
      opts,
      evaluateMs: Date.now() - t0
    })
  }

  return {
    evaluate: (action, object, opts) =>
      judge(action, object, opts?.includeForceAllow !== false).decision,

    // 被动 UI 判定：includeForceAllow 缺省 false（per-path 授权不放宽 UI 范围），不记日志
    evaluateReadOnly: (action, object, opts) =>
      judge(action, object, opts?.includeForceAllow === true).decision.effect === 'allow',

    // enforcePath / enforceGitOp / enforceUrl 什么都不返回 —— 用户的「其它」反馈没有地方带回去，
    // 只能抛出。强制 onOther:'throw'：调用方误传 'return' 时，反馈不能被当成放行
    async enforcePath(mode: AccessMode, resolvedPath: string, opts: EnforceOpts): Promise<void> {
      await enforce(
        mode,
        { type: 'path', path: resolvedPath, displayPath: opts.displayPath ?? resolvedPath },
        { ...opts, onOther: 'throw' }
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
      // MCP 工具带着可判定的事实来（server/tool + 可信 server 的 annotations）；
      // 其余工具在这一刻确实只有「有人要调工具」这一件事可说。
      const object: SecurityObject = opts.mcp
        ? {
            type: 'invocation',
            mcpServer: opts.mcp.server,
            mcpTool: opts.mcp.tool,
            mcpTrusted: opts.mcp.trusted,
            readOnly: opts.mcp.readOnly,
            destructive: opts.mcp.destructive,
            idempotent: opts.mcp.idempotent,
            openWorld: opts.mcp.openWorld
          }
        : { type: 'invocation' }
      const probe = judge('execute', object, true, {
        name: opts.toolName,
        operation: opts.operation
      }).decision
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
        { ...opts, onOther: 'throw' }
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
      ),

    async enforceUrl(object, opts): Promise<void> {
      await enforce(
        'navigate',
        {
          type: 'url',
          url: object.url,
          scheme: object.scheme,
          host: object.host,
          origin: object.origin,
          browser: object.browser
        },
        { ...opts, onOther: 'throw' }
      )
    }
  }
}
