/**
 * @shuvix/agent-runtime —— 宿主无关的 Agent 编排核心。
 *
 * 基于 @earendil-works/pi-durable + pi-ai（pi 1.0）：会话状态与运行时交给 pi-durable，
 * 本包负责 agent 档案 / 工具 / 安全 / 提示词这些 ShuviX 自己的东西，并通过注入接口
 * （event sink / env / 存储 / 网络）脱离 Node/Electron。桌面端与 Chrome 扩展共享同一套编排逻辑。
 *
 * pi-durable 切换进行中（P1-01 起）：会话运行时尚在重建，未就绪的入口抛 `PhasePendingError`。
 */
export * from './types'
// 迁移期「这条路径还没实现」的统一标记（见 errors/phasePending.ts）
export { PhasePendingError, isPhasePendingError } from './errors/phasePending'
export {
  AgentRegistry,
  agentIdOf,
  type AgentRegistryEntry,
  type AgentRegistryEntryInput
} from './agentRegistry'
// 会话运行时生命周期簿记（Map + 懒创建 + 失效/销毁）—— 桌面/扩展共享，构造与清理经注入
export {
  SessionManager,
  type SessionManagerDeps,
  type SessionDisposeReason
} from './sessionManager'
export {
  resolveModel,
  BUILTIN_ENV_MAP,
  type ResolveModelParams,
  type ResolveModelProviderInfo
} from './modelResolver'
export { buildCustomProviderCompat } from './providerCompat'
export { resolveInitialThinkingLevel } from './thinkingLevel'
export { isAssistantMessage, isUserMessage, isToolResultMessage } from './messageGuards'
// 工具结果的界面文字化（实时广播与重开会话同一份）
export { toolResultText, imagePlaceholder } from './toolResultText'
export {
  McpManager,
  LAZY_CONNECT_TIMEOUT_MS,
  STDERR_TAIL_CHARS,
  type McpStore,
  type McpStderrSource,
  type McpCallMeta,
  type McpManagerOptions,
  type McpAgentToolMeta,
  type McpDiscoveredTool,
  type McpConnectResult
} from './mcpManager'
export {
  BuiltinMcpRegistry,
  type BuiltinMcpScope,
  type BuiltinMcpFactory
} from './builtinMcpRegistry'
export type { McpInvocationFacts } from './security/types'
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
// 浏览器自动化：后端契约 + per-tab CDP 管理（两端的后端各自实现，工具面在内置 MCP server）
export {
  PDF_PAGE_SIZES,
  PDF_SCALE_RANGE,
  type BrowserBackend,
  type BrowserCaps,
  type BrowserOpOutput,
  type NavKind,
  type PdfPageSize,
  type ScrollDirection
} from './browser/backend'
// 内置能力服务器 browser（逐动作的 MCP 工具，两端共用）
export {
  connectBrowserMcpServer,
  createBrowserMcpServerFactory,
  createBrowserTabQueue,
  BROWSER_MCP_SERVER_NAME,
  type BrowserTabQueue,
  type BrowserMcpGates,
  type BrowserGateContext,
  type BrowserSiteGateContext,
  type BrowserMcpServerOptions
} from './browser/mcpServer'
export { browserSiteOf } from './browser/site'
export {
  browserToolsForCaps,
  type BrowserMcpTool,
  type BrowserToolName,
  type BrowserToolAnnotations
} from './browser/mcpTools'
export {
  CdpAttachManager,
  TabCdpSession,
  type CdpTabTransport,
  type CdpTabTransportFactory,
  type TabCdpState,
  type NetworkEntry,
  type ConsoleEntry,
  type RawEventEntry
} from './browser/attachManager'
export * as browserCdpOps from './browser/cdpOps'
export { type CdpSpill } from './browser/cdpOps'
export { blockedCdpReason, resolveUidMacros } from './browser/cdpPolicy'
export { KEY_DEFS, dispatchKey, type CdpSend } from './browser/keyboard'
export {
  EXTRACT_PAGE_EXPR,
  htmlToMarkdown,
  formatReadPage,
  MAX_PAGE_MARKDOWN_CHARS,
  type ExtractedPage
} from './browser/readPage'
// 统一 git 工具（multiplex）：操作目录 + 注入环境 + isomorphic-git 单后端
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
export { buildGitHelp, GIT_HELP_TOPICS, type GitHelpTopic } from './git/help'
export { resolveAuthor, AUTHOR_MISSING_MESSAGE } from './git/author'
// 单 op 直用入口 —— 宿主自身的自动提交（如 widget 目录自举）复用同一套实现，不经工具壳，
// 因而也不经路径询问：调用方必须自己确保目标目录是它有权写的
export { initOp, addOp, commitOp, statusOp, unstageOp } from './git/gitOps'
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
  resolvePolicyFiles,
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
  clearReviewState,
  reviewSuspended,
  noteHumanFeedback,
  humanFeedbackOf,
  abortSessionReviews,
  reopenSessionReviews,
  takeReviewAllowed,
  type HumanFeedbackNote,
  type ReviewAllowedNote,
  REVIEW_CONSECUTIVE_DENIAL_LIMIT,
  REVIEW_TOTAL_DENIAL_LIMIT,
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
  type UrlObjectInput,
  urlObjectOf,
  type SecurityRule,
  type SecurityDecision,
  type PolicyRuleSpec,
  type ParsedPolicyFile,
  type UserPolicyFile,
  // 策略 md 的三个结构键（与 hook md 的 HOOK_ON_KEY 同理：契约常量，文档与守护用例按它断）
  POLICY_RULES_KEY,
  POLICY_LETS_KEY,
  POLICY_SCOPE_KEY,
  type SecurityHostProvider,
  type PermissionRequestEvent,
  type PermissionReviewAnswer,
  type UnconfinedReason,
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
export { BaseTool, type ToolReplay } from './tools/baseTool'
export { toolCallScope, type ToolCallScope } from './tools/toolCall'
export {
  backstopOutputLimits,
  OUTPUT_BACKSTOP_FACTOR,
  type DurableOutputLimits,
  type OutputDeclaration
} from './tools/outputLimits'
// 工具结果：durable 原生（BaseTool 子类交回 ToolResult，模板收成 durable 结果；抛错按 Q12 收口）
export {
  errorMessageOf,
  toolErrorResult,
  strictJsonDetails,
  toExecutionResult,
  type AnyTool,
  type ToolContent,
  type ToolResult,
  type ToolExecutionMode
} from './tools/toolResult'
// 旧形状工具（pi 0.80 的 AgentTool；ask / git / MCP 桥接层还在用）与它到 durable 的桥
// TODO(pi-durable p1): P1-05 改成 durable 原生之后删除
export {
  asToolRegistration,
  fromAgentTool,
  fromAgentToolResult,
  isLegacyAgentTool,
  type AgentTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type AnyLegacyAgentTool
} from './tools/toolResult'
export {
  createFileToolSuite,
  ReadParamsSchema,
  WriteParamsSchema,
  EditParamsSchema,
  type FileToolDeps,
  type FileToolSuite,
  type ReadDecoders
} from './tools/fileToolSuite'
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
  truncateKeepStart,
  truncateKeepEnd,
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
  type RunTaskOutcome,
  type AnyAgentTool,
  type SpawnedRuntime
} from './subagent/manager'
// 派发结果契约：schema 收口的 next 工具（运行时原语；目前没有生产调用方）
export {
  NextTool,
  NEXT_TOOL_NAME,
  NEXT_NUDGE_TEXT,
  buildResultContractNote,
  validateContractSchema,
  type ResultContract
} from './subagent/nextTool'
// Hook：md 格式解析 / 类型化埋点注册表 / runner（设计见 docs/hook-design.md）
export {
  parseHookDefinitionFile,
  HOOK_FILE_MARKER,
  HOOK_FILE_MARKER_KEY,
  HOOK_ON_KEY,
  HOOK_AGENT_KEY,
  type ParsedHookFile,
  type HookBinding
} from './hook/hookFile'
export {
  TRIGGER_POINTS,
  DECIDE_SPECS,
  getTriggerPoint,
  type TriggerId,
  type ObserveTriggerId,
  type DecideTriggerId,
  type DecideSpec,
  type TriggerPayloadMap,
  type TriggerResultMap,
  type TriggerPointDef,
  type PermissionRequestPayload
} from './hook/triggerPoints'
export { renderHookPrompt, HOOK_EVENT_TAG } from './hook/hookPrompt'
export {
  createHookRunner,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_DECIDE_TIMEOUT_MS,
  type HookDecision,
  type HookRunner,
  type HookRunnerDeps,
  type HookRegistryEntry,
  type HookRunInfo,
  type HookRunEvent,
  type HookSkipReason
} from './hook/hookRunner'
export {
  buildBuiltinHooks,
  BUILTIN_HOOK_SPECS,
  AUTO_TITLE_HOOK_SPEC,
  type BuiltinHookDeps,
  type BuiltinHookSpec
} from './hook/builtinHooks'
// Bot：md 格式解析 + 正文围栏。一个 bot = 身份 + 正文（人设与记忆），绑在一条有根会话上；
// **不内置任何 bot**（bot 会话的基座档案 `bot` 在下面的内置档案里）。
export {
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  BOT_FILE_MARKER,
  BOT_FILE_MARKER_KEY,
  BOT_FILE_MARKER_TYPE,
  BOT_RETIRED_PIPELINE_KEY,
  type ParsedBotFile
} from './bot/botFile'
export { renderBotContext, BOT_CONTEXT_TAG, type BotContextInput } from './bot/botContext'
// 内置档案（声明式 spec + 注入 t 的统一构建器；各端 registry 现算组装,用户同名定义可覆盖）
export {
  buildBuiltinProfile,
  buildBuiltinProfiles,
  BUILTIN_PROFILE_SPECS,
  BASE_PROFILE_NAMES,
  HOST_ONLY_PROFILE_NAMES,
  PERMISSION_REVIEWER_PROFILE_NAME,
  PERMISSION_REVIEWER_SPEC,
  WORK_PROFILE_NAME,
  WORK_SPEC,
  CHAT_PROFILE_NAME,
  CHAT_SPEC,
  NOTEBOOK_PROFILE_NAME,
  NOTEBOOK_SPEC,
  BOT_PROFILE_NAME,
  TAB_PROFILE_NAME,
  COEDIT_PROFILE_NAME,
  BOT_SPEC,
  CODING_SPEC,
  EXPLORE_SPEC,
  WIDGET_SPEC,
  TITLER_SPEC,
  builtinMdFileNames,
  type BuiltinMdReader,
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
// 档案共用的提示片段（各档案在正文里用 {{shuvix:*}} 占位符引入；宿主在变量表里供值）
export { renderVisualGuide, renderVisualCraft } from './agentProfile/fragments'
export { type AgentProfileRegistry } from './agentProfile/registry'
// 注册表 md 的同名裁决（agent / 策略 / hook / bot 共用；运行时与设置页列表走同一个函数）
export {
  registryFileBase,
  resolveShadowing,
  type ShadowCandidate,
  type ShadowResolved,
  type ShadowedBy
} from './registryShadowing'
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
// 知识库 v2（OKF）：编解码 / 概念与笔记 / 校验 / knowledge 工具 / 引导
export * from './knowledge'
export { splitFrontmatter, type FrontmatterSplit } from './markdownFrontmatter'
export {
  createAgentFactory,
  type AgentFactory,
  type AgentHostAdapter,
  type AgentRuntime,
  type CreateAgentParams,
  type CreatedAgent,
  type ToolResolveRequest
} from './agentProfile/createAgent'
// agent 规格的纯派生（初始模型 / 思考档位 / 工具名单 / 系统提示词 / root·spawned 差异）
export {
  deriveAgentSpec,
  assembleSystemPrompt,
  normalizeToolNames,
  resolveInitialModel,
  resolveThinkingLevel,
  runtimeDecisions,
  type AgentSpec,
  type AgentSpecHost,
  type AgentSpecParams,
  type AgentRuntimeDecisions
} from './durable/agentSpec'
export {
  fenceInstructionFile,
  fenceProjectPrompt,
  fenceProjectMemory,
  fenceKnowledgeBases
} from './durable/prompt/fences'
// 挂起的用户询问（ask / 确认卡片）—— 会话运行时「等人回答」的那一半
export { PendingInputRequests } from './durable/inputRequests'
// 历史 thinking 剥离（纯函数；pi-durable 切换后暂未接线，见文件头）
export {
  elideHistoricalThinking,
  type ThinkingElisionState,
  type ThinkingElisionOptions
} from './context/thinkingElision'
// 旧格式（harness-v3-jsonl）会话的只读读取 + 冻结投影：存储换代不迁移，旧会话靠它继续可看。
// 侧车常量随投影一并冻结在这里（旧会话树里写着它们）。
export {
  HarnessV3FormatError,
  harnessV3TextToChatMessages,
  readHarnessV3Transcript,
  entriesToChatMessages,
  INSTRUCTION_CUSTOM_TYPE,
  INLINE_TOKENS_CUSTOM_TYPE,
  SYSTEM_NOTICE_CUSTOM_TYPE,
  SIDECAR_CUSTOM_TYPES,
  type InlineTokensSidecar,
  type HarnessV3Entry,
  type HarnessV3Issue,
  type HarnessV3Transcript,
  type LegacyTranscriptView
} from './legacy/harnessV3'
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
// 后台任务枢纽：bash / 派生 agent / 子会话轮次共用的登记簿、等待器与通知中枢。
// 「前台 / 后台」在这里退化成 `join` 的两组参数（见 task/registry.ts 文件头）
export {
  createTaskRegistry,
  type TaskInfo,
  type TaskKind,
  type TaskStatus,
  type TaskSubject,
  type TaskRegistry,
  type TaskRegistryDeps,
  type CreateTaskParams,
  type JoinPolicy,
  type JoinOutcome,
  type SettlePatch
} from './task/registry'
