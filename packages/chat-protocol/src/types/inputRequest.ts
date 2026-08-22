/**
 * 统一的"用户输入请求"模型 — main / preload / renderer 共用
 *
 * 设计原则:
 * - **判别联合**:同一 `requestUserInput()` 方法接受所有 kind,前后端按 kind 分支
 * - **永不超时**:Promise 只能由用户响应或 abort 触发 resolve
 * - **extra 字段**:工具自定义副作用(如 `rememberPath`),由工具响应回调消费
 *
 * 扩展新 kind 只需:
 * 1. 加一个 `XxxInputRequest` + `XxxResponse` 接口
 * 2. 加进 `InputRequest` / `InputResponse` 联合
 * 3. 工具调用点 + 前端表单组件加一个分支
 */

// ─── SshCredential 字段(沿用 tools/types.ts 中的旧定义,这里 mirror 一份避免循环依赖) ──

export interface SshCredentialPayload {
  host: string
  port: number
  username: string
  /** 密码认证 */
  password?: string
  /** 私钥认证:私钥内容(PEM 格式) */
  privateKey?: string
  /** 私钥口令(如果私钥有加密) */
  passphrase?: string
}

// ─── 请求侧 ──────────────────────────────────────────

export type InputRequestKind = 'ask' | 'choice' | 'sshCredentials'

interface InputRequestBase {
  /** 与 toolCallId 一致,作为路由 key */
  id: string
  kind: InputRequestKind
  toolName: string
  createdAt: number
}

/**
 * 「预览询问」的 diff 载荷 —— write/edit 在**写入之前**把即将发生的改动摊给用户看。
 *
 * ⚠️ 一致性契约:这里的 `diff` 与工具执行后 `EditToolDetails/WriteToolDetails.diff`
 * 必须是**同一个字符串**。实现上由 applyEdit/applyWrite 在文件锁内算一次(截断也只做一次),
 * 再分别交给询问请求与 tool result —— 不允许两侧各算一遍,那样文件在两次之间被改动就会分歧。
 */
export interface AskDiffPreview {
  kind: 'diff'
  /** 展示用文件路径(与询问 command 里的路径同源) */
  path: string
  /** 与 tool result details.diff 同一份 */
  diff: string
  /** 目标文件此前不存在(整份内容都是新增) */
  isNewFile?: boolean
}

export type AskPreview = AskDiffPreview

/**
 * 命中的安全策略给出的提示语（策略 md 里规则的 `prompt`）。
 *
 * 与 `description` 刻意分开：description 是**工具自己**的说明（如 git 操作的文案），
 * 这一条是**策略在说话** —— 卡片上单独一栏并署名，用户才知道该去改哪份策略。
 * 询问场景下它只到这里为止，不进 agent 上下文。
 */
export interface AskPolicyPrompt {
  text: string
  /** 贡献该文本的策略显示名（去重，按装配序）；可能多份策略同时命中 */
  policies: string[]
}

export interface AskInputRequest extends InputRequestBase {
  kind: 'ask'
  command: string
  description?: string
  /** 命中策略的提示语（有则卡片多渲染一栏） */
  policyPrompt?: AskPolicyPrompt
  /**
   * 路径询问时,提示前端"此路径是目录"。
   * - 前端据此调整 UI:目录不提供单次放行,「允许此目录」按钮固定携带
   *   `extra.rememberPath: true`(目录授权天然持久),后端走普通"记住"分支写入 allowList
   * - 仅对 read 模式有意义
   */
  pathIsDirectory?: boolean
  /** 预览询问载荷:有则前端渲染预览(如 write/edit 的 diff)而非光秃秃的路径 */
  preview?: AskPreview
}

export interface ChoiceInputRequest extends InputRequestBase {
  kind: 'choice'
  question: string
  detail?: string
  options: Array<{ label: string; description: string }>
  allowMultiple: boolean
}

export interface SshCredentialsInputRequest extends InputRequestBase {
  kind: 'sshCredentials'
  /** 可选预填字段(host/user 等) */
  prefill?: { host?: string; port?: number; username?: string }
}

export type InputRequest = AskInputRequest | ChoiceInputRequest | SshCredentialsInputRequest

// ─── 响应侧 ──────────────────────────────────────────

interface InputResponseBase {
  /** 工具自定义副作用字段(如 {rememberPath: true}),由工具响应回调消费 */
  extra?: Record<string, unknown>
}

export interface AskResponse extends InputResponseBase {
  kind: 'ask'
  allowed: boolean
  reason?: string
}

export interface ChoiceResponse extends InputResponseBase {
  kind: 'choice'
  selections: string[]
}

export interface SshCredentialsResponse extends InputResponseBase {
  kind: 'sshCredentials'
  credentials: SshCredentialPayload
}

/**
 * "其它"响应:用户拒绝按工具预期填写,转而提交一段自由文本反馈给 AI。
 *
 * 工具收到该响应时**不应执行任何副作用**(不跑命令、不连接 SSH、不返回选项),
 * 而是把 `text` 包装成正常的 tool result 返回,让 AI 看到用户的反馈再决定下一步。
 *
 * 设计意图:替代旧的"用户主动取消"动作 — 用户必须给出原因/反馈,
 * 不允许"沉默拒绝"。如果用户真的想中止整个流程,应使用 agent.abort。
 */
export interface OtherResponse extends InputResponseBase {
  kind: 'other'
  text: string
}

/**
 * 取消响应:仅由后端在 agent.abort 时主动产生,前端 UI 不暴露此动作。
 * 工具收到该响应时通常应 throw,中断当前 turn。
 */
export interface CancelResponse extends InputResponseBase {
  kind: 'cancel'
  reason: 'aborted'
}

export type InputResponse =
  | AskResponse
  | ChoiceResponse
  | SshCredentialsResponse
  | OtherResponse
  | CancelResponse
