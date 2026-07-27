/**
 * @shuvix/agent-runtime —— 宿主无关的 Agent 编排核心。
 *
 * 消费 @earendil-works/pi-agent-core + pi-ai，把 AgentEvent 转成 @shuvix/chat-protocol 的
 * ChatEvent，并通过注入接口（persistence / event sink / env）脱离 Node/Electron。
 * 桌面端与 Chrome 扩展共享同一套编排逻辑。
 */
export * from './types'
export { RuntimeAgent, type RuntimeAgentDeps } from './runtimeAgent'
export {
  AgentRegistry,
  agentIdOf,
  type AgentRegistryEntry,
  type AgentRegistryEntryInput
} from './agentRegistry'
export { createEphemeralPersistence } from './ephemeralPersistence'
// 会话运行时生命周期簿记（Map + 懒创建 + 失效/销毁）—— 桌面/扩展共享，构造与清理经注入
export {
  SessionManager,
  type SessionManagerDeps,
  type SessionDisposeReason
} from './sessionManager'
export {
  forwardAgentEvent,
  type SessionEventState,
  type SessionEventHandlerContext
} from './eventHandler'
export {
  resolveModel,
  BUILTIN_ENV_MAP,
  type ResolveModelParams,
  type ResolveModelProviderInfo
} from './modelResolver'
export { buildCustomProviderCompat } from './providerCompat'
export { resolveInitialThinkingLevel } from './thinkingLevel'
export { isAssistantMessage, isUserMessage, isToolResultMessage } from './messageGuards'
export {
  McpManager,
  type McpStore,
  type McpManagerOptions,
  type McpDiscoveredTool
} from './mcpManager'
export {
  createAskTool,
  AskParamsSchema,
  ASK_DESCRIPTION,
  type CreateAskToolOptions
} from './askTool'
// 工具定义枚举共享机制（各端自举内置工具 → 设置页只读展示）
export { toBuiltinToolDefinitions, type ToolDefinitionEntry } from './tools/toolDefinitions'
// 文件工具共享内核（端口注入 File API；桌面 Node fs / 扩展 FSA）
export type { FileSystemPort, FileStat, DirEntry, FileGuards } from './fileTools/port'
export { readTextContent, readDirContent, type ReadTextParams } from './fileTools/read'
export { applyWrite, type WriteParams } from './fileTools/write'
export { applyEdit, type EditParams } from './fileTools/edit'
export { buildTree } from './fileTools/ls'
export {
  previewFile,
  extOfPath,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_HEX_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_EBOOK_MAX_BYTES
} from './fileTools/preview'
export { parseImagePixelSize, type ImagePixelSize } from './fileTools/imageSize'
// CDP 浏览器自动化共享内核（注入 CdpTransport；桌面 webContents.debugger / 扩展 chrome.debugger）
export type { CdpTransport } from './cdp/transport'
export { CdpController, type AXNode } from './cdp/controller'
// 统一浏览器工具（multiplex）：操作目录 + 后端契约 + per-tab CDP 管理 + 手册
export {
  BROWSER_ACTIONS,
  BROWSER_OPS,
  opsForCaps,
  type BrowserAction,
  type BrowserOpSpec,
  type BrowserParamKey
} from './browser/ops'
export type {
  BrowserBackend,
  BrowserCaps,
  BrowserOpOutput,
  NavKind,
  ScrollDirection
} from './browser/backend'
export {
  createBrowserTool,
  buildBrowserParamsSchema,
  buildBrowserToolDescription,
  BROWSER_TOOL_NAME,
  type CreateBrowserToolOptions
} from './browser/tool'
export { buildBrowserHelp, HELP_TOPICS, type HelpTopic } from './browser/help'
export {
  CdpAttachManager,
  TabCdpSession,
  type CdpTabTransport,
  type CdpTabTransportFactory,
  type NetworkEntry,
  type ConsoleEntry,
  type RawEventEntry
} from './browser/attachManager'
export * as browserCdpOps from './browser/cdpOps'
export { type CdpSpill } from './browser/cdpOps'
export { blockedCdpReason, resolveUidMacros } from './browser/cdpPolicy'
export { KEY_DEFS, dispatchKey, type CdpSend } from './browser/keyboard'
export {
  extractPage,
  EXTRACT_PAGE_EXPR,
  htmlToMarkdown,
  formatReadPage,
  MAX_PAGE_MARKDOWN_CHARS,
  type ExtractedPage
} from './browser/readPage'
// 统一 git 工具（multiplex）：操作目录 + 注入环境 + isomorphic-git 单后端 + FSA fs 适配器
export {
  GIT_ACTIONS,
  GIT_OPS,
  type GitAction,
  type GitOpSpec,
  type GitOpParams,
  type GitParamKey
} from './git/ops'
export type {
  GitEnv,
  GitAuthor,
  GitCache,
  GitFsClient,
  GitFsPromises,
  GitFsStat,
  GitOpOutput
} from './git/env'
export {
  createGitTool,
  buildGitParamsSchema,
  buildGitToolDescription,
  GIT_TOOL_NAME,
  type CreateGitToolOptions
} from './git/tool'
export {
  createFsaFsClient,
  type FsaDirHandleLike,
  type FsaFileHandleLike,
  type FsaFileLike,
  type FsaWritableLike
} from './git/fsaFsClient'
export { buildGitHelp, GIT_HELP_TOPICS, type GitHelpTopic } from './git/help'
export { resolveAuthor, AUTHOR_MISSING_MESSAGE } from './git/author'
// 单 op 直用入口 —— 宿主自身的自动提交（如 widget 目录自举）复用同一套实现，不经工具壳，
// 因而也不经路径审批：调用方必须自己确保目标目录是它有权写的
export { initOp, addOp, commitOp, statusOp } from './git/gitOps'
// 工具输出后处理共享内核（截断 + 经注入 SpillSink 落盘）
export {
  processToolOutput,
  type SpillSink,
  type TruncateStrategy,
  type ProcessToolOutputOptions,
  type ProcessToolOutputResult
} from './toolOutput/spill'
// 路径审批后端共享核心（注入 ApprovalPolicy；复用已共享的 requestUserInput + 审批 UI）
export {
  assertPathApproved,
  type ApprovalPolicy,
  type AccessMode,
  type AssertPathApprovedOpts
} from './approval/policy'
// 工具基类 + 共享文件工具套件（read/write/edit 整条流程，注入端适配 API）
export { BaseTool } from './tools/baseTool'
export {
  createFileToolSuite,
  ReadParamsSchema,
  WriteParamsSchema,
  EditParamsSchema,
  type FileToolDeps,
  type FileToolSuite,
  type ReadDecoders
} from './tools/fileToolSuite'
// 共享 preview 工具内核（校验路径 → 分类判定 → 图表渲染验证 → 广播 file_preview；注入端适配）
export {
  createPreviewTool,
  PreviewParamsSchema,
  PREVIEW_DESCRIPTION,
  type PreviewToolDeps,
  type ChartValidation
} from './tools/previewTool'
// edit 内部的纯函数（行尾/BOM/diff、多级回退匹配链）—— 供桌面/扩展直接复用与单测
export {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  stripBom,
  generateDiffString,
  type FuzzyMatchResult,
  type EditDiffResult
} from './fileTools/editDiff'
export {
  replaceWithFallback,
  levenshtein,
  dedent,
  ExactReplacer,
  UnicodeNormalizedReplacer,
  LineTrimmedReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  BlockAnchorReplacer,
  type Replacer,
  type ReplacerMatch,
  type ReplaceResult
} from './fileTools/replacers'
export {
  truncateLine,
  truncateHead,
  truncateTail,
  truncateMiddle,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  MAX_LINE_LENGTH
} from './fileTools/truncate'
// 系统提示词卡片（内置定义 + 装配/视图）—— 内容来自共享 i18n，environment 由各端注入
export {
  BUILTIN_SECTION_ORDER,
  ENVIRONMENT_SECTION_ID,
  isBuiltinSectionId,
  isDynamicBuiltin,
  getBuiltinTitle,
  getStaticBuiltinContent,
  formatLanguageDisplay,
  type BuiltinSectionId,
  type BuiltinRenderCtx
} from './systemPrompt/builtinSections'
export {
  listBuiltinSections,
  previewBuiltinSection,
  renderSystemPromptSections,
  type SystemPromptDeps,
  type BuiltinSectionViewItem
} from './systemPrompt/render'
// 派生 agent：spawn 协调器 + 派发工具（注入注册表/工具解析/模型构建/事件广播，端无关）
export {
  createSubAgentManager,
  DEFAULT_MAX_AGENT_DEPTH,
  type SubAgentManager,
  type SubAgentManagerDeps,
  type SubAgentToolHelpers,
  type SpawnContext,
  type RunTaskParams,
  type AnyAgentTool
} from './subagent/manager'
// 内置子代理定义（硬编码，各端 registry 组装；用户同名定义可覆盖）
// （visualization 的图表文件契约常量在 @shuvix/chat-protocol/chartFileContract —— UI 与提示词共用）
export {
  COMPACT_AGENT,
  EXPLORE_AGENT,
  RESEARCH_AGENT,
  VISUALIZATION_AGENT,
  buildWidgetAgent,
  buildWikiAgent,
  WIKI_ENTRY_BANNER,
  type BuildWidgetAgentOptions,
  type BuildWikiAgentOptions
} from './subagent/builtinAgents'
export {
  createDispatchAgentTool,
  DispatchAgentTool,
  AgentParamsSchema,
  buildDescription as buildDispatchDescription,
  toInProcessAgentType,
  type DispatchAgentToolDeps
} from './subagent/dispatchTool'
export type {
  AgentDefinition,
  InProcessAgentType,
  SubAgentModelConfig,
  SubAgentRegistry
} from './subagent/types'
export {
  buildNotebookContextText,
  notebookTaskName,
  runNotebookTask,
  type NotebookTaskInputs
} from './subagent/notebookContext'
export { runUserDispatchTask, type UserDispatchInputs } from './subagent/userDispatch'
// transcript：ChatMessage ↔ AgentMessage 双向投影 + 面向 Agent 的转写门面
// （正向投影 = 两端共用的上下文恢复；反向投影使 chat-protocol 能力对任意 agent 生效）
export {
  agentMessagesToChatMessages,
  chatMessagesToAgentMessages,
  extractBase64,
  transcribeAgentMessages
} from './transcript'
// session 工具：压缩子代理读转写 / 原子压缩归档的共享内核（数据源 = Agent 上下文，
// 经 transcript/ 反向投影 + chat-protocol transcribeConversation 引擎按压缩档位渲染；
// 端只注入 ensure*Session 取数 / 落库失效广播适配）
export {
  createSessionTool,
  buildSummaryContent,
  contextFingerprint,
  verifyContextFingerprint,
  SessionTool,
  SessionToolParamsSchema,
  SESSION_TOOL_DESCRIPTION,
  type SessionToolDeps,
  type SessionToolParams,
  type SessionContextFingerprint
} from './sessionTool'
// 会话标题生成：宿主无关内核（端解析模型来源 + apiKey，触发策略在 chat-ui 共享）
export { generateSessionTitle, parseTitle, TITLE_GEN_SYSTEM_PROMPT } from './title/generateTitle'
// 内置 hook 引擎 + 可移植 builtins（各端共享；桌面 HookService 组合本引擎追加 command 层）
export {
  HookEngine,
  matchHook,
  makeBashAudit,
  findDangerousPattern,
  makeSessionStart,
  makeSessionStop,
  makePathSafety,
  type PathSafetyEnv
} from './hooks'
