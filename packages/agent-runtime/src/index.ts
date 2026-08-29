/**
 * @shuvix/agent-runtime —— 宿主无关的 Agent 编排核心。
 *
 * 消费 @earendil-works/pi-agent-core + pi-ai：AgentHarness 承载会话状态（entry 树），
 * harness/ 把 AgentHarnessEvent 转成 @shuvix/chat-protocol 的 ChatEvent，
 * 并通过注入接口（event sink / env）脱离 Node/Electron。
 * 桌面端与 Chrome 扩展共享同一套编排逻辑。
 */
export * from './types'
export {
  AgentRegistry,
  agentIdOf,
  type AgentRegistryEntry,
  type AgentRegistryEntryInput
} from './agentRegistry'
// 活跃 pi agent 运行时登记簿（业务无关：只存 AgentHarness/Session + 身份标签）——
// 登记点是 createAgent 单点，供监控等消费方按 pi 原生读取面取数
export {
  AgentRuntimeRegistry,
  agentRuntimeRegistry,
  type AgentRuntimeKind,
  type AgentRuntimePhase,
  type AgentRuntimeIdentity,
  type AgentRuntimeCounters,
  type AgentRuntimeSnapshot
} from './runtimeRegistry'
// 会话运行时生命周期簿记（Map + 懒创建 + 失效/销毁）—— 桌面/扩展共享，构造与清理经注入
export {
  SessionManager,
  type SessionManagerDeps,
  type SessionDisposeReason
} from './sessionManager'
// 进程内共享会话树缓存（单实例 + 在途去重 + LRU/钉住）—— 存储后端经 deps 注入
export {
  createSessionTreeRegistry,
  type SessionTreeRegistry,
  type SessionTreeRegistryDeps
} from './sessionTreeRegistry'
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
export type { FileSystemPort, FileStat, DirEntry, FileGuards, WriteAskHook } from './fileTools/port'
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
  type GitAskReason,
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
// 因而也不经路径询问：调用方必须自己确保目标目录是它有权写的
export { initOp, addOp, commitOp, statusOp } from './git/gitOps'
// 工具输出后处理共享内核（截断 + 经注入 SpillSink 落盘）
export {
  processToolOutput,
  type SpillSink,
  type TruncateStrategy,
  type ProcessToolOutputOptions,
  type ProcessToolOutputResult
} from './toolOutput/spill'
// 智能体安全模块 —— 统一评估函数（allow/ask/deny）+ 内置策略 md + PEP 门面。
// 请求按 主体/操作/客体/环境 建模；宿主经 SecurityHostProvider 注入平台细节。
export {
  createSecurityContext,
  evaluate as evaluateSecurity,
  assembleRules,
  mergePolicyFiles,
  executeDecision,
  parsePolicyDefinitionFile,
  serializePolicyDefinitionFile,
  POLICY_FILE_MARKER,
  POLICY_FILE_MARKER_KEY,
  buildBuiltinPolicies,
  BUILTIN_POLICY_SPECS,
  type BuiltinPolicySpec,
  recordDecision,
  getSessionDecisions,
  clearSessionDecisions,
  parseAllowEntry,
  buildAllowEntry,
  matchesPathEntry,
  isPathAllowedUnified,
  compileMatch,
  evaluateMatch,
  evaluateLet,
  type AllowToolType,
  type SecurityEffect,
  type AccessMode,
  type RuleTier,
  type SecuritySubject,
  type SecurityEnvironment,
  type SecurityObject,
  type AttrValue,
  type MatchContext,
  type SecurityRequest,
  type CommandObjectInput,
  type GitObjectInput,
  type SecurityRule,
  type SecurityDecision,
  type PolicyRuleSpec,
  type ParsedPolicyFile,
  type SecurityHostProvider,
  type EnforceOpts,
  type EnforceOutcome,
  type SecurityContext,
  type SecurityDecisionRecord,
  // bash 命令解析层（宿主注入 wasm 字节后同步解析；见 security/shell）
  initShellParser,
  isShellParserReady,
  analyzeShellCommand,
  type ShellFacts
} from './security'
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
  capDiffString,
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
// 派发结果契约：schema 收口的 next 工具（workflow run() 的结构化结果通道）
export {
  NextTool,
  NEXT_TOOL_NAME,
  NEXT_NUDGE_TEXT,
  buildResultContractNote,
  validateContractSchema,
  type ResultContract
} from './subagent/nextTool'
// Workflow：md 格式解析 / 类型化埋点注册表 / 引擎（设计见 docs/workflow-md-design.md）
export {
  parseWorkflowDefinitionFile,
  WORKFLOW_FILE_MARKER,
  WORKFLOW_FILE_MARKER_KEY,
  type ParsedWorkflowFile,
  type WorkflowTriggerBinding,
  type WorkflowLimits,
  type WorkflowConcurrency
} from './workflow/workflowFile'
export {
  TRIGGER_POINTS,
  getTriggerPoint,
  type TriggerId,
  type TriggerPayloadMap,
  type TriggerPointDef
} from './workflow/triggerPoints'
export {
  createWorkflowEngine,
  DEFAULT_WORKFLOW_LIMITS,
  type WorkflowEngine,
  type WorkflowEngineDeps,
  type WorkflowRegistryEntry,
  type WorkflowScriptEngine
} from './workflow/engine'
export {
  buildBuiltinWorkflows,
  BUILTIN_WORKFLOW_SPECS,
  BUILTIN_WORKFLOW_NAMES,
  AUTO_TITLE_WORKFLOW_SPEC,
  type BuiltinWorkflowDeps,
  type BuiltinWorkflowSpec
} from './workflow/builtinWorkflows'
// 内置档案（声明式 spec + 注入 t 的统一构建器；各端 registry 现算组装,用户同名定义可覆盖）
// （visualization 的图表文件契约常量在 @shuvix/chat-protocol/chartFileContract —— UI 与提示词共用）
export {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  BUILTIN_PROFILE_SPECS,
  BASE_PROFILE_NAMES,
  DEFAULT_PROFILE_NAME,
  DEFAULT_SPEC,
  NOTEBOOK_PROFILE_NAME,
  NOTEBOOK_SPEC,
  CODING_SPEC,
  EXPLORE_SPEC,
  VISUALIZATION_SPEC,
  WIDGET_SPEC,
  WIKI_SPEC,
  WIKI_WRITER_SPEC,
  TITLER_SPEC,
  WIKI_ENTRY_BANNER,
  WIKI_TOPIC_BANNER,
  type BuiltinProfileDeps,
  type BuiltinProfileSpec
} from './subagent/builtinAgents'
export {
  createDispatchAgentTool,
  DispatchAgentTool,
  DISPATCH_TOOL_NAME,
  AgentParamsSchema,
  buildDescription as buildDispatchDescription,
  toInProcessAgentType,
  type DispatchAgentToolDeps
} from './subagent/dispatchTool'
export type {
  AgentProfile,
  InProcessAgentType,
  SubAgentModelConfig,
  SubAgentRegistry
} from './subagent/types'

// ── Agent 档案体系：创建期变量表 / 注册表接口（统一创建管线的纯逻辑层） ──
export {
  renderProfileSystemPrompt,
  substitutePromptVars,
  formatLanguageDisplay,
  type AgentKind,
  type PromptVars,
  type PromptVarsCtx
} from './agentProfile/promptVars'
export { type AgentProfileRegistry } from './agentProfile/registry'
// agent 定义文件（<name>.md）的格式解析/序列化 —— 内置档案与用户档案共用同一套格式
export {
  parseAgentDefinitionFile,
  serializeAgentDefinitionFile,
  AGENT_FILE_MARKER,
  AGENT_FILE_MARKER_KEY,
  type ParsedAgentFile
} from './agentProfile/definitionFile'
// 项目记忆文件（<slug>.md）的格式解析/序列化 + 注入索引渲染
export {
  parseMemoryFile,
  serializeMemoryFile,
  MEMORY_FILE_MARKER,
  MEMORY_FILE_MARKER_KEY,
  type ParsedMemoryFile
} from './memory/memoryFile'
export { renderMemoryIndex } from './memory/memoryIndex'
export {
  createAgentFactory,
  type AgentFactory,
  type AgentHostAdapter,
  type CreateAgentParams,
  type CreatedAgent,
  type ToolResolveRequest
} from './agentProfile/createAgent'
export {
  notebookTaskName,
  runNotebookTask,
  type NotebookTaskInputs
} from './subagent/notebookContext'
// harness 接入层：会话状态的存储与上下文构建交给 pi AgentHarness。
// entry 树是唯一真理源，entriesToChatMessages 是它的「UI 视角」（唯一投影方向）。
export {
  HarnessSession,
  forwardHarnessEvent,
  createHarnessEventState,
  entriesToChatMessages,
  createModelsAdapter,
  createStubExecutionEnv,
  INSTRUCTION_CUSTOM_TYPE,
  INLINE_TOKENS_CUSTOM_TYPE,
  type InlineTokensSidecar,
  type HarnessSessionDeps,
  type HarnessEventContext,
  type HarnessEventDeps,
  type HarnessEventState,
  type ModelsAdapterDeps,
  type ToolCallGate
} from './harness'
// transcript：AgentMessage → ChatMessage 投影 + 面向 Agent 的转写门面
// （派生 agent 的内存上下文经这条路径渲染成可读转写 —— 面板/导出共用）
export { agentMessagesToChatMessages, extractBase64, transcribeAgentMessages } from './transcript'
// 会话标题生成：宿主无关内核（端解析模型来源 + apiKey）；
// SessionTitler 是两端共用的两阶段触发策略（quick 首轮 + refine 精修）
export { generateSessionTitle, parseTitle, TITLE_GEN_SYSTEM_PROMPT } from './title/generateTitle'
export {
  SessionTitler,
  type SessionTitlerDeps,
  type TitleSourceMessage
} from './title/sessionTitler'
// shuvix 契约 md 的解析器级校验（ChatApi shuvixMd.validate 的两端共用实现）
export { validateShuvixMdText } from './shuvixMdValidate'
// 契约 md 的写后处理（文件工具末尾：校验回执 + 缺省字段盖章）
export {
  reviewShuvixMdWrite,
  type ShuvixMdWriteContext,
  type ShuvixMdWriteOutcome
} from './shuvixMdWrite'
// 通知决策器：订阅一端的 ChatEvent 流，判定何时打扰用户（询问挂起 / 一轮跑完 / 一轮出错），
// 宿主只提供「怎么弹 + 用户在看哪」的端口。两端共用同一份策略。
export {
  createNotificationCenter,
  type NotificationCenter,
  type NotificationCenterDeps,
  type NotifierPort,
  type NotificationTranslate
} from './notification/notificationCenter'
