/**
 * 智能体安全模块 —— 核心类型（宿主无关，Node-free）。
 *
 * 所有权限判定收敛为一个统一评估：`evaluate(rules, request) → SecurityDecision`。
 * 请求按 主体(subject) / 操作(action) / 工具(tool) / 客体(object) / 环境(environment)
 * 建模；客体是**开放属性文档**（{ type } + 属性），规则匹配是**单条 CEL 表达式**
 * 对整份请求文档求值（见 celMatch.ts）—— 引擎不含任何逐要素/逐客体种类的匹配代码，
 * 新客体类型（database / url / mcp…）= PEP 上报属性 + 策略写一条 match，引擎零改动。
 * 决策三态 `allow | ask | deny`，`ask` 经既有 requestUserInput 挂起原语走用户询问。
 *
 * ⚠️ 这不是沙箱：强制点在本进程的 TS 层，校验的是「工具入参」，属于 access control
 * 而非 isolation。被授权执行的子进程(bash/ssh)运行在本层之外，拥有与主进程同等权限。
 * 真正的隔离边界需要 OS 级机制(macOS sandbox-exec / Linux Landlock+seccomp / 容器)。
 *
 * 规则来源三层（assemble 时装配）：
 *   - builtin  内置策略 md（security/builtinPolicies/，随包内联）
 *   - user     用户策略 md（桌面 ~/.shuvix/policies/<name>.md，同名覆盖内置）
 *   - derived  宿主代码级派生规则（仅限无法 md 化的宿主特例；桌面/扩展当前都不供给）
 * 会话授权（免询问开关 / "允许并记住"）不再是独立一层：条目经 buildPolicyVars 变成
 * `vars.autoAllow` / `vars.grantedRead` / `vars.grantedWrite`，由内置的 session-auto-allow
 * 与 session-path-grants 两份策略 md 用 `effect: force-allow` 表达（见 policyVars.ts）。
 *
 * 结算优先序（tier，见 evaluate.ts）：deny → force-ask → force-allow → ask → static-allow → default。
 */
import type {
  AskPreview,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeLogger } from '../types'
import type { ShellFacts } from './shell/types'

/** 判决输出的三态 —— PEP 看到的结果 */
export type SecurityEffect = 'allow' | 'ask' | 'deny'

/**
 * 策略 md 里可声明的 effect —— 三个基础值加两个 `force-` 升级档。
 *
 * **强弱只有两条规则加一个特例**（新人读到名字就该知道谁压过谁）：
 *   1. 带 `force-` 的压过不带的；
 *   2. 同档内按基础强弱 deny > ask > allow；
 *   3. `deny` 恒在顶 —— 拒绝没有「更强的拒绝」，所以没有 force-deny。
 *
 * 于是梯子是：deny > force-ask > force-allow > ask > allow > 默认放行。
 *   - `force-allow` 效果同 allow，但压得过询问门（出厂用它表达免询问开关与
 *     「允许并记住」这类「用户明示同意」）；
 *   - `force-ask` 效果同 ask，但连 force-allow 都压不过它 —— 「这道门不接受
 *     会话级同意」，用于始终要过目的少数对象。
 *
 * 为什么把强度编进 effect 名字而不是拆一个独立的 strength 字段：TIER_EFFECT
 * （见 evaluate.ts）本就是 tier 的全函数，两者不是正交的两根轴 —— 拆成两个键既冗余，
 * 又造出 `deny + strength` 这类必须额外校验的非法组合。装配时归一为 {tier, effect}
 * 两个内部字段（见 assemble.ts TIER_BY_EFFECT），SecurityRule 的形状不受影响。
 */
export type PolicyEffect = SecurityEffect | 'force-allow' | 'force-ask'

/** 访问模式（路径类客体的 action 取值） */
export type AccessMode = 'read' | 'write'

/**
 * 结算层级 —— 不是简单的 deny→ask→allow：
 * 用户明示同意（force-allow）必须压过静态 ask 规则（否则「免询问」开关失效），
 * force-ask 又必须压过它（「这道门不接受同意」），而任何 deny 压过全部。
 * 名字与 md 的 effect 一一对应，只有 static-allow 例外（它对应裸 `allow`，
 * 叫 static 是为了和「默认放行」区分开：一个是规则命中，一个是没有规则）。
 */
export type RuleTier = 'deny' | 'force-ask' | 'force-allow' | 'ask' | 'static-allow'

/** 策略变量表的值类型（vars.*）—— 布尔用于 autoAllow 这类开关 */
export type PolicyVarValue = string | string[] | boolean

// ─────────────────────────── 请求五要素 ───────────────────────────

/**
 * 主体：谁在操作。多主体模型 ——
 *   'agent'  LLM 智能体的工具调用（内置防护策略只作用于它）
 *   'user'   用户亲手的 UI 操作（笔记本自动保存、预览面板取文件…）
 *   开放扩展：未来如 'external'（入站 MCP 客户端）等
 */
export interface SecuritySubject {
  /** 主体类型（match 里的 subject.kind） */
  kind: 'agent' | 'user' | (string & {})
  sessionId: string
  /** agent 档案名（default / widget / 用户自定义…）；非 agent 主体或未知时省略 */
  profileName?: string
  /** 会话根 agent 还是派发出的子 agent；非 agent 主体省略 */
  agentKind?: 'root' | 'spawned'
  /** 派发深度（root=0）；未知时省略 */
  depth?: number
}

/** 环境：在哪里操作（快照仅供规则条件与决策日志） */
export interface SecurityEnvironment {
  host: 'desktop' | 'extension'
  /** process.platform（'darwin' | 'win32' | 'linux'…）；扩展端省略 */
  platform?: string
  /** 会话工作目录（已解析绝对路径）；无项目会话为 temp workspace */
  workspaceDir?: string
}

/** 客体属性的标量取值 */
export type AttrScalar = string | number | boolean

/**
 * 客体属性的取值类型（进 CEL 上下文，须可被表达式消费）。
 *
 * 允许「一层扁平记录的列表」（如命令客体的 `commands`），但**不再往下嵌套** ——
 * cel-js 的列表是强类型的（`[null,'x']` 直接报 type mismatch），层级越深越容易
 * 写出求值期才炸的表达式，而 deny 规则求值失败会 fail-safe 成命中。
 */
export type AttrValue = AttrScalar | string[] | Record<string, AttrScalar | string[]>[]

/**
 * 客体：操作对象 —— **开放属性文档**。`type` 只是粗分类标签（询问材料推导、
 * 决策日志、UI 展示用），引擎匹配不按 type 分派 —— 规则用 `object.type == '…'`
 * 自行守卫。既有 type 与属性约定（PEP 构造时该 type 的已知属性全部给值）：
 *   { type:'invocation' }                                   L1 全工具门（执行前，无资源事实）
 *   { type:'path', path, displayPath }                      文件类工具触达的路径
 *   { type:'command', command, channel, parsed, commands, writes }
 *                                                           bash/ssh 命令（channel: 'bash'|'ssh'；
 *                                                           后三项是解析层贡献的结构属性，
 *                                                           惰性求值，见 commandFacts.ts）
 *   { type:'gitTool', gitAction, command, force, delete }   内置 git 工具操作
 *   { type:'database', sql, credential, dbType, readonly }  远程库查询（readonly = 连接模式）
 * 未来扩展（url / mcp…）：PEP 上报新 type + 属性即可，引擎零改动。
 */
export type SecurityObject = { type: string } & Record<string, AttrValue | undefined>

/**
 * 一次待判定操作 —— 统一评估函数的输入（五要素）：
 * 主体（谁）× 操作（做什么）× 工具（经由哪个工具）× 客体（对什么资源）× 环境（在哪里）。
 */
export interface SecurityRequest {
  subject: SecuritySubject
  /** 'read' | 'write' | 'execute' | …（开放字符串，新客体种类可带新 action） */
  action: string
  /**
   * 经由的工具（PEP 已知则填充；operation = 多路复用工具的动作参数，如 ssh 的 action）。
   * 被动 UI 等非工具路径省略 —— match 上下文里恒有 tool 命名空间（空串缺省），
   * `tool.name == 'ssh'` 对非工具路径求 false 而非报错。
   */
  tool?: { name: string; operation?: string }
  object: SecurityObject
  environment: SecurityEnvironment
}

// ─────────────────────────── 匹配上下文与规则模型 ───────────────────────────

/**
 * match 表达式的求值文档（由 evaluate 从 SecurityRequest 构建）。
 * subject/tool/env 是固定命名空间（缺省补空串 —— 恒可访问）；object 是开放属性文档
 * （缺失属性访问按 strict 语义报错 → fail-safe）；策略级 lets 以顶层名字额外注入。
 */
export interface MatchContext {
  subject: { kind: string; agentKind: string; profile: string; sessionId: string; depth: number }
  action: string
  tool: { name: string; operation: string }
  object: Record<string, AttrValue>
  env: { host: string; platform: string }
  vars: Record<string, PolicyVarValue>
}

/** 装配后的一条规则（评估的直接输入） */
export interface SecurityRule {
  /** 稳定标识：'<policyName>#<n>' / 'derived:<name>' */
  id: string
  /** 判决效果（md 的 force-allow/force-ask 在装配时归一为 allow/ask + 对应 tier） */
  effect: SecurityEffect
  tier: RuleTier
  /**
   * 匹配谓词；省略 = 恒命中（无条件无 match 的规则）。
   * 策略规则 = 结构化条件原生谓词 AND CEL 编译产物（+ lets 注入）；derived = 原生谓词。
   * 运行时数据（用户路径等）**绝不拼进 CEL 源码**（转义/注入隐患）—— 一律经 vars
   * 以数据绑定进入求值上下文，表达式本身是策略 md 里的固定文本。
   * 抛错由 evaluate 按 effect fail-safe 处置（deny/ask 命中，allow 不命中）。
   */
  matches?: (ctx: MatchContext) => boolean
  /** CEL 原文（展示/日志回链）；纯条件规则与原生谓词规则省略 */
  matchExpr?: string
  /** 有效结构化条件（scope ∩ 规则字段）—— 展示/日志用；将来按维度建索引也取这里 */
  conditions?: PolicyConditions
  /** 命中时给人看的提示语（md 的 rule.prompt 原样透传）；投递面见 SecurityDecision.prompt */
  prompt?: string
  /** 规则出处（决策日志与检视 UI 的回链；displayName 供询问卡片署名，按界面语言本地化） */
  source: {
    kind: 'builtin' | 'user' | 'session' | 'derived'
    policy?: string
    policyDisplayName?: string
  }
}

// ─────────────────────────── 决策 ───────────────────────────

export interface SecurityDecision {
  effect: SecurityEffect
  /** 全部命中规则 id（按 tier 序）；空 = 未命中走默认 */
  matched: string[]
  /** 胜出规则 id；未命中默认时为 'default:<objectType>' */
  winning: string
  reason?: string
  /**
   * 命中规则声明的提示语（见 evaluate 的 collectPrompt）。**仅 ask / deny 收集**：
   * allow（含 force-allow）放行的操作不带话 —— 每次工具调用都往上下文/界面塞一段是纯噪音。
   * 投递面按 effect 分：deny 拼进抛出的工具错误（agent 与用户都看得到），
   * ask 只上询问卡片（不进 agent 上下文 —— 用户拒绝/反馈的文案保持原样）。
   */
  prompt?: {
    /** 胜出 tier 内全部命中规则的 prompt，去重后按装配序拼接 */
    text: string
    /** 贡献文本的规则 id（决策归因） */
    rules: string[]
    /** 贡献文本的策略显示名（去重，按装配序）—— 询问卡片的署名 */
    policies: string[]
  }
  /** effect === 'ask' 时交给执行层的材料 */
  ask?: {
    /** 询问卡片展示文本（路径类为 allowList 条目字面值，命令类为命令原文） */
    command: string
    /**
     * 勾选「允许并记住」时写入 allowList 的条目；缺省 = 不可记住。
     * 当前仅路径类客体给出（allowList 只有 Read/Write 条目形态；命令类没有
     * 对应的记忆机制 —— 用户想放宽命令可自写 allow 策略，含 matches() 正则）。
     */
    rememberEntry?: string
  }
}

// ─────────────────────────── 宿主注入面 ───────────────────────────

/**
 * 结构化条件字段的键 —— **键即 CEL 路径**（`object.type: [path]` ≡ match 里的
 * `object.type == 'path'`）。只收「每个请求都必然具备的身份标签」；资源自身的属性
 * （path/command/sql/gitAction…）一律留在 match（语义与理由见 conditions.ts）。
 */
export type ConditionKey = 'subject.kind' | 'action' | 'object.type' | 'env.host' | 'tool.name'

/** 一组结构化条件：列表内 OR、字段之间 AND、再与 match AND；省略 = 不约束；`'*'` = 任意 */
export type PolicyConditions = Partial<Record<ConditionKey, string[]>>

/** 用户/内置策略 md 里的一条规则（见 policyFile.ts） */
export interface PolicyRuleSpec {
  effect: PolicyEffect
  /**
   * 结构化条件（md 里是与 effect/match 平级的扁平键，如 `action: [read]`）。
   * 与策略级 scope 取交后与 match AND。省略 = 该维度不约束。
   */
  conditions?: PolicyConditions
  /**
   * CEL 匹配表达式（解析时经 compileMatch 语法校验；语法错 → 整份文件非法）。
   * 省略 = 结构化条件即全部条件（write/ask-on-command 这类策略的 match 为空）。
   */
  match?: string
  /**
   * 命中时给人看的一句话（可选，纯人读面，不参与匹配、不影响判决）。
   *
   * 定位提示用途，允许不写也允许每条都写。投递面决定了它该写给谁看 ——
   * 这是内置策略的书写约定（引擎不强制）：
   *   - `ask`  → 只上询问卡片，读者是**用户**：写这一步的风险（放行之后会发生什么），
   *              不进 agent 上下文；
   *   - `deny` → 拼进抛出的工具错误，读者是 **agent**：写被拒的原因（必要时给出
   *              该走的替代路径），用户在工具块里看到的是同一段；
   *   - `allow` / `force-allow` → 不投递，但依然合法：策略页的规则卡片会显示它，
   *              那里它就是这条规则的说明文字。
   */
  prompt?: string
}

export interface ParsedPolicyFile {
  name: string
  /** 显示名（`shuvix-displayName`，对齐 agent md）；缺省 = name。内置策略按界面语言本地化 */
  displayName: string
  description: string
  /**
   * 策略级共同条件（`shuvix-policy-scope`）—— **AND 进本策略每条规则**，
   * 不是独立的前置门：策略头部可见地参与每条规则的条件，没有隐藏的过滤。
   * 与规则同键取交，空交集 = 该规则死代码 → 整份文件非法（见 conditions.ts）。
   */
  scope?: PolicyConditions
  /**
   * 策略级 let 绑定：名字 → CEL 值表达式（上下文 {vars}），装配时求值一次、
   * 以顶层名字注入本策略所有规则的 match 上下文 —— 取代旧 {{var}} 展开与 YAML 锚点
   * （多条规则共享一份路径清单等）。名字不得与内置命名空间冲突（policyFile 校验）。
   */
  lets?: Record<string, string>
  rules: PolicyRuleSpec[]
  /** 正文 —— 纯人读说明（rationale/示例），引擎不评估 */
  body: string
}

/**
 * 宿主注入 seam。全部成员按「每次评估现取」设计：桌面的 getSessionGrants 直连 SQLite、
 * getUserPolicies 现扫策略目录 —— 刻意不缓存（会话中途开「免询问」或「允许并记住」
 * 落库后，复用的 context 必须立即看到新值，否则反复弹询问）。
 */
export interface SecurityHostProvider {
  host: 'desktop' | 'extension'
  /** 路径分隔符（Node-free：桌面注入 path.sep，扩展 '/'）—— inDir 与 allowList 匹配绑定 */
  pathSep: string
  /**
   * 策略变量表（match/lets 里的 `vars.*`）：workspace / toolResultsBase / skillsDirs / memoryDirs /
   * home / systemDirs…。每次装配现取。宿主应为内置策略引用的变量恒供给取值
   * （无该概念时给空串/空数组 —— inDir 对空串恒不命中；缺失的键按 strict 报错走 fail-safe）。
   */
  getVars(): Record<string, PolicyVarValue>
  /** 会话授权（force-allow 层来源）。每次评估现读，禁缓存。 */
  getSessionGrants(): { autoAllow: boolean; allowList: string[] }
  /**
   * 界面语言（i18next.language 形态，如 'zh' / 'zh-CN'）—— 仅影响内置策略的
   * description/body 人读面（决策日志/检视 UI）；规则本体恒取 en（安全语义
   * 与语言无关）。省略 = en。
   */
  getLanguage?(): string
  /** 用户策略 md（同名覆盖内置）；无文件系统的宿主省略 */
  getUserPolicies?(): ParsedPolicyFile[]
  /** 宿主代码级派生规则 —— 仅限无法 md 化的特例（原生谓词） */
  derivedRules?(): SecurityRule[]
  /** 是否目录（read 询问的 UX 区分；可异步）。省略 = 恒 false */
  isDirectory?(path: string): boolean | Promise<boolean>
  /** 询问通过且勾选「记住」时持久化 allow 条目 */
  persistGrant?(mode: AccessMode, path: string): void
  /**
   * bash/ssh 命令的结构解析（见 security/shell）。桌面注入；没有命令类工具的宿主省略。
   *
   * 省略时（或初始化失败且解析器确实未就绪时）命令客体的结构属性呈现为「未解析」
   * （`parsed:false` + 空列表），结构化规则因此不命中，命令落回 ask-on-command ——
   * 这是自然降级，不是兜底设计：wasm 加载失败属于开发期就该暴露的程序问题，记 error 即可。
   */
  shellParser?: {
    /** 首次使用前完成 wasm 初始化；失败只记日志，不得阻断命令执行 */
    ensureReady(): Promise<void>
    /** 同步解析（CEL 求值是同步的，解析必须在求值前就绪） */
    analyze(command: string): ShellFacts
  }
  /** 已共享的挂起/恢复原语；无前端时按 EnforceOpts.missingChannel 处置 */
  requestUserInput?(req: InputRequest): Promise<InputResponse>
  logger?: RuntimeLogger
}

// ─────────────────────────── 执行层（enforce） ───────────────────────────

export interface EnforceOpts {
  toolCallId: string
  toolName: string
  /** 报错/展示用路径（相对/展示路径） */
  displayPath?: string
  /** 询问描述（如 git 操作的 i18n 文案） */
  description?: string
  /** 取消时抛出的错误文案（桌面 'Aborted' / 扩展 'TOOL_ABORTED'） */
  abortError?: string
  /** 多路复用工具的动作参数（填充 request.tool.operation，如 ssh 的 action） */
  operation?: string
  /** 预览载荷（write/edit 的 diff）—— 只有 apply 层算得出，见 fileToolSuite */
  preview?: AskPreview
  /** 命令将作为后台任务运行 —— 询问卡片据此标注（见 AskInputRequest.background） */
  background?: boolean
  /**
   * 用户选「其它」（提交反馈文本而非允许/拒绝）时的处置：
   * 'throw'（默认，路径/git 类）或 'return'（bash/ssh：反馈作为正常 tool result 返回）。
   */
  onOther?: 'throw' | 'return'
  /**
   * ask 且无 requestUserInput 通道时的处置。缺省 'deny'（fail-closed）；
   * 'allow' 仅供确知无需询问的调用方显式声明。
   */
  missingChannel?: 'deny' | 'allow'
}

export type EnforceOutcome = { status: 'allowed' } | { status: 'feedback'; text: string }

/** enforceCommand 的入参（object 属性文档由门面构造） */
export interface CommandObjectInput {
  channel: 'bash' | 'ssh'
  command: string
  /**
   * 命令的工作目录 —— 用于把重定向目标解析成绝对路径。
   * ssh 的远端 cwd 不可知，省略即可（相对目标此时保持原样）。
   */
  cwd?: string
}

/** enforceGitOp 的入参（对应 {type:'gitTool'} 客体的属性） */
export interface GitObjectInput {
  gitAction: string
  command: string
  force: boolean
  delete: boolean
}

/** enforceDatabase 的入参（对应 {type:'database'} 客体的属性） */
export interface DatabaseObjectInput {
  /** SQL 原文（询问卡片展示 + 策略可 matches() 匹配） */
  sql: string
  /** 凭据名（用户在设置里登记的连接） */
  credential: string
  /** 'mysql' | 'postgresql' 等 */
  dbType: string
  /** 连接是否只读（凭据配置；只读连接由 DB 服务端强制，无副作用可能） */
  readonly: boolean
}

/** PEP 门面 —— 各工具调用点唯一入口（见 context.ts） */
export interface SecurityContext {
  /** 评估（不执行、不弹窗、不记日志）。includeForceAllow 缺省 true。 */
  /**
   * ⚠️ 命令客体请走 enforceCommand：它是唯一会挂上结构属性（parsed/commands/writes）的
   * 构造点。手工构造的 `{type:'command'}` 缺这些属性时，引用它们的规则按 strict 语义
   * 求值报错，deny 规则会 fail-safe 成「命中」—— 即全部拒绝。
   */
  evaluate(
    action: string,
    object: SecurityObject,
    opts?: { includeForceAllow?: boolean }
  ): SecurityDecision
  /**
   * 同步只读判定 —— 永不弹询问、不记日志，被动 UI（预览面板等）专用。
   * includeForceAllow 缺省 **false**（工具级 per-path 授权不应静默放宽 UI 范围）。
   */
  evaluateReadOnly(
    action: string,
    object: SecurityObject,
    opts?: { includeForceAllow?: boolean }
  ): boolean
  /** 路径守卫：allow 返回 / deny、拒绝、取消 throw / ask 挂起询问 */
  enforcePath(mode: AccessMode, resolvedPath: string, opts: EnforceOpts): Promise<void>
  /** 命令守卫：'other' 反馈按 onOther 返回 feedback 结果 */
  enforceCommand(object: CommandObjectInput, opts: EnforceOpts): Promise<EnforceOutcome>
  /** git 逐操作守卫（每个 git 工具操作都会评估；内置 git-safety 只对破坏性组合 ask） */
  enforceGitOp(object: GitObjectInput, opts: EnforceOpts): Promise<void>
  /**
   * 数据库查询守卫（每次查询都评估；内置 ask-on-database 对可写连接 ask，
   * 只读连接放行）。'other' 反馈按 onOther 返回 feedback 结果，同 enforceCommand。
   */
  enforceDatabase(object: DatabaseObjectInput, opts: EnforceOpts): Promise<EnforceOutcome>
  /**
   * L1 全工具门守卫（wrapToolOutput 咽喉）：客体 = `{type:'invocation'}`（调用本身），
   * 工具名/动作走 request.tool 维度（取自 opts.toolName / opts.operation）。
   * **allow 即非事件**：无论默认放行、force-allow（免询问）还是静态 allow，
   * 放行的调用不弹窗、不记日志 —— 每次工具调用都过此门，记录 allow 会淹没决策日志；
   * 只有 ask/deny 产生记录。
   */
  enforceInvocation(opts: EnforceOpts): Promise<EnforceOutcome>
}

// ─────────────────────────── 决策日志 ───────────────────────────

export interface SecurityDecisionRecord {
  ts: number
  sessionId: string
  toolCallId: string
  toolName: string
  subject: { kind: string; profileName?: string; agentKind?: 'root' | 'spawned' }
  /** 工具维度（请求携带时记录；operation = 多路复用工具的动作） */
  tool?: { name: string; operation?: string }
  action: string
  /** 客体 type（'path' / 'command' / 'gitTool' / 'invocation' / …） */
  objectKind: string
  /** 摘要：路径全量 / 命令截断 200 字符（防超长脚本刷爆日志） */
  objectSummary: string
  effect: SecurityEffect
  matched: string[]
  winning: string
  userResponse?: 'allowed' | 'allowed_remember' | 'denied' | 'feedback' | 'cancel'
  evaluateMs: number
  /** 含挂起等待的总耗时（仅 ask 路径有意义） */
  totalMs?: number
}
