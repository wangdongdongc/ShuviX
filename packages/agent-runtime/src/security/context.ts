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
 * 无任何快照 —— 会话中途「允许并记住」落库后立即可见（禁缓存红线）。
 * 真实路径同理，每次评估现解析 —— 链接随时可能被改指向。
 */
import { assembleRules } from './assemble'
import { projectCommandFacts, projectPowerShellFacts, type CommandFactAttrs } from './commandFacts'
import { analyzePowerShellCommand } from './powershell/analyze'
import { isCommandRisk, pickCommandRisk } from './commandRisk'
import { evaluate } from './evaluate'
import { executeDecision } from './enforce'
import { buildPolicyVars } from './policyVars'
import type {
  AccessMode,
  CommandObjectInput,
  CommandRisk,
  Disposition,
  EnforceOpts,
  EnforceOutcome,
  GateVerdict,
  SecurityContext,
  SecurityDecision,
  SecurityEnvironment,
  SecurityHostProvider,
  SecurityObject,
  SecuritySubject,
  SecurityToolRef
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
  const sandboxed = input.sandboxed === true
  const object: SecurityObject = {
    type: 'command',
    command: input.command,
    channel: input.channel,
    // 恒有值：策略读它不必先 has() —— 宿主没说圈住，就是没圈住
    sandboxed,
    // 同样恒有值：圈住了为 ''；宿主没说原因时 ssh 记 remote、其余记 unavailable
    unconfinedReason: sandboxed
      ? ''
      : (input.unconfinedReason ?? (input.channel === 'ssh' ? 'remote' : 'unavailable'))
  }
  // 仅 ssh 有；bash / powershell 不写这个键，好让策略用 has(object.host) 区分远端与本地
  if (input.host) object.host = input.host
  let cached: CommandFactAttrs | null = null
  const facts = (): CommandFactAttrs => {
    if (!cached) {
      try {
        cached =
          input.channel === 'powershell'
            ? // PowerShell 走它自己的扫描器 —— bash 解析器读 PowerShell 会得出貌似合理的错事实
              // （反引号在 bash 里是命令替换、在 PowerShell 里是转义）。bash 解析器只用来读
              // 嵌在里面的 `bash -c '…'` 载荷
              projectPowerShellFacts(
                analyzePowerShellCommand(input.command, {
                  analyzeBash: provider.shellParser
                    ? (source) => {
                        try {
                          return provider.shellParser!.analyze(source)
                        } catch (err) {
                          // 扫描器会跳过这段载荷、保留其余事实；这里只负责留下痕迹
                          provider.logger?.warn(
                            `嵌套 bash 载荷解析抛错，该载荷按未解析处理：${err instanceof Error ? err.message : String(err)}`
                          )
                          throw err
                        }
                      }
                    : undefined
                }),
                input.cwd,
                provider.pathSep
              )
            : projectCommandFacts(
                provider.shellParser?.analyze(input.command),
                input.cwd,
                provider.pathSep
              )
      } catch (err) {
        provider.logger?.warn(
          `shell 解析抛错，命令按未解析处理：${err instanceof Error ? err.message : String(err)}`
        )
        cached = projectCommandFacts(undefined, input.cwd, provider.pathSep)
      }
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

/**
 * 问宿主要这条命令的风险分类（见 SecurityHostProvider.classifyCommand）。宿主不实现、回 null、抛错，
 * 或者回了个不完整的东西，都当作「这次没分类」—— 客体上不挂 risk，引用它的规则走严格语义的 fail-safe。
 * 回来的东西不完整、抛错各记一条告警（回 null 是宿主说「这次不分」，不记）。
 *
 * 和审查一样与 signal 赛跑：用户按了停止就不再等宿主（宿主可能根本不看 signal），静默交回 null ——
 * 后面的门（审查、询问）自己会看见 signal 落下、按中止收尾。
 */
async function classifyCommandSafely(
  provider: SecurityHostProvider,
  input: CommandObjectInput,
  signal: AbortSignal | undefined,
  toolCallId: string | undefined
): Promise<CommandRisk | null> {
  const classify = provider.classifyCommand
  if (!classify || signal?.aborted) return null
  let onAbort: (() => void) | undefined
  const aborted = new Promise<null>((resolve) => {
    onAbort = (): void => resolve(null)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const risk = await Promise.race([
      Promise.resolve().then(() => classify.call(provider, input, { signal, toolCallId })),
      aborted
    ])
    if (signal?.aborted || risk === null || risk === undefined) return null
    if (!isCommandRisk(risk)) {
      provider.logger?.warn('命令风险分类的结果不完整，按未分类处理')
      return null
    }
    return pickCommandRisk(risk)
  } catch (err) {
    if (signal?.aborted) return null
    provider.logger?.warn(
      `命令风险分类失败，按未分类处理：${err instanceof Error ? err.message : String(err)}`
    )
    return null
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** 降级的询问没有 reason，也可能没写 prompt：拒绝时给对方的固定一句 */
export const GATE_DOWNGRADED_MESSAGE =
  'A security policy asks before allowing this, and this check cannot ask anyone, so it is refused.'

/**
 * 放行却带着这个点位做不到的处置 → 按拒绝结算（见 EnforceOpts.supportedDispositions）。规则要求脱敏、
 * 执行点却只会放行，照放就是悄悄拆掉那道保护。做得到（或没有处置）原样返回。
 */
export function withDispositionSupport(
  decision: SecurityDecision,
  supported: readonly Disposition[]
): SecurityDecision {
  if (decision.effect !== 'allow' || !decision.dispositions) return decision
  const missing = decision.dispositions.filter((d) => !supported.includes(d))
  if (missing.length === 0) return decision
  const { dispositions: _dropped, ...rest } = decision
  return {
    ...rest,
    effect: 'deny',
    reason:
      `Security policy rule '${decision.winning}' asks for ` +
      `${missing.map((d) => `'${d}'`).join(', ')}, which this check cannot carry out`
  }
}

/** 结算 → 不能询问的点位的结论：ask（含 force-ask）降级为拒绝 */
export function gateVerdictOf(decision: SecurityDecision): GateVerdict {
  if (decision.effect === 'allow') return { allowed: true, decision, downgraded: false }
  const downgraded = decision.effect === 'ask'
  const message =
    decision.prompt?.text ??
    (downgraded ? GATE_DOWNGRADED_MESSAGE : (decision.reason ?? 'Refused by a security policy.'))
  return { allowed: false, decision, downgraded, message }
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
    tool: SecurityToolRef | undefined,
    realPath: ((path: string) => string) | undefined
  ): SecurityDecision => {
    // 一次现取，装配（lets）与求值（match）共用同一份 —— 两处各取一次会给出
    // 不一致的授权视图（见 policyVars.ts）
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

  /**
   * 评估入口的公共前半段：路径客体解析真实去处，再评估（被动 UI 与 enforce 同一条路），
   * 最后按这个点位能做的处置把做不到的放行改判为拒绝（缺省一个都做不了）。
   */
  const judge = (
    action: string,
    object: SecurityObject,
    includeForceAllow: boolean,
    tool?: SecurityToolRef,
    supportedDispositions: readonly Disposition[] = []
  ): { object: SecurityObject; decision: SecurityDecision } => {
    const realPath = realPathsForOneEvaluation()
    const resolved = atRealPath(object, realPath)
    return {
      object: resolved,
      decision: withDispositionSupport(
        evaluateInternal(action, resolved, includeForceAllow, tool, realPath),
        supportedDispositions
      )
    }
  }

  /** 工具维度：每个 PEP 都带 opts.toolName（match 里的 tool.name 因此对全客体可用）；还原了才带 restored */
  const toolOf = (opts: EnforceOpts): SecurityToolRef => ({
    name: opts.toolName,
    operation: opts.operation,
    ...(opts.restored?.length ? { restored: opts.restored } : {})
  })

  const enforce = async (
    action: string,
    object: SecurityObject,
    opts: EnforceOpts
  ): Promise<EnforceOutcome> => {
    const t0 = Date.now()
    const tool = toolOf(opts)
    // 询问卡片、「允许并记住」与决策日志都拿解析后的客体 —— 与策略判的是同一个位置
    const judged = judge(action, object, true, tool, opts.supportedDispositions)
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
      judge(
        action,
        object,
        opts?.includeForceAllow !== false,
        opts?.tool,
        opts?.supportedDispositions
      ).decision,

    // 被动 UI 判定：includeForceAllow 缺省 false（per-path 授权不放宽 UI 范围），不记日志
    evaluateReadOnly: (action, object, opts) =>
      judge(action, object, opts?.includeForceAllow === true).decision.effect === 'allow',

    // 不能询问的点位：先完整结算，再把 ask 降级为拒绝（见 types.ts SecurityContext.judgeGate）
    judgeGate: (action, object, opts) =>
      gateVerdictOf(judge(action, object, true, opts?.tool, opts?.supportedDispositions).decision),

    // enforcePath / enforceGitOp / enforceUrl / enforceSession 什么都不返回 —— 用户的「其它」反馈没有地方带回去，
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
      // PowerShell 命令也要等：嵌在里面的 `bash -c '…'` 载荷由它读（见 buildCommandObject）
      try {
        await provider.shellParser?.ensureReady()
      } catch (err) {
        provider.logger?.warn(
          `shell 解析器初始化失败，命令按未解析处理：${err instanceof Error ? err.message : String(err)}`
        )
      }
      const command = buildCommandObject(object, provider)
      const risk = await classifyCommandSafely(provider, object, opts.signal, opts.toolCallId)
      if (risk) command.risk = risk
      return enforce('execute', command, opts)
    },

    // L1 全工具门：**allow 即非事件**（默认放行 / force-allow / 静态 allow 同待遇）——
    // 跳过 executeDecision（不弹窗不记日志）。此门每次工具调用都过，若 allow 也记录，
    // 会以每调用一条的速度刷爆 ring buffer；L1 的日志只留 ask/deny 的真实拦截信号
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
      const probe = judge(
        'execute',
        object,
        true,
        toolOf(opts),
        opts.supportedDispositions
      ).decision
      if (probe.effect === 'allow') {
        return probe.dispositions
          ? { status: 'allowed', dispositions: probe.dispositions }
          : { status: 'allowed' }
      }
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

    async enforceSession(mode, object, opts): Promise<void> {
      await enforce(
        mode,
        {
          type: 'session',
          sessionId: object.sessionId,
          title: object.title,
          ownTurn: object.ownTurn,
          lastActiveAt: object.lastActiveAt ?? '',
          bot: object.bot ?? ''
        },
        { ...opts, onOther: 'throw' }
      )
    },

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
