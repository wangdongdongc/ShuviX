/**
 * @shuvix/agent-runtime —— 宿主无关的 Agent 编排核心。
 *
 * 消费 @earendil-works/pi-agent-core + pi-ai，把 AgentEvent 转成 @shuvix/chat-protocol 的
 * ChatEvent，并通过注入接口（persistence / event sink / env）脱离 Node/Electron。
 * 桌面端与 Chrome 扩展共享同一套编排逻辑。
 */
export * from './types'
export { RuntimeSession, type RuntimeSessionDeps } from './runtimeSession'
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
export { isAssistantMessage, isUserMessage, isToolResultMessage } from './messageGuards'
export {
  McpManager,
  type McpStore,
  type McpManagerOptions,
  type McpDiscoveredTool
} from './mcpManager'
export { createAskTool, AskParamsSchema, type CreateAskToolOptions } from './askTool'
// 文件工具共享内核（端口注入 File API；桌面 Node fs / 扩展 FSA）
export type { FileSystemPort, FileStat, DirEntry, FileGuards } from './fileTools/port'
export { readTextContent, readDirContent, type ReadTextParams } from './fileTools/read'
export { applyWrite, type WriteParams } from './fileTools/write'
export { applyEdit, type EditParams } from './fileTools/edit'
export { buildTree } from './fileTools/ls'
// CDP 浏览器自动化共享内核（注入 CdpTransport；桌面 webContents.debugger / 扩展 chrome.debugger）
export type { CdpTransport } from './cdp/transport'
export { CdpController, type AXNode } from './cdp/controller'
// 工具输出后处理共享内核（截断 + 经注入 SpillSink 落盘）
export {
  processToolOutput,
  type SpillSink,
  type TruncateStrategy,
  type ProcessToolOutputOptions,
  type ProcessToolOutputResult
} from './toolOutput/spill'
// 沙箱/审批后端共享核心（注入 SandboxPolicy；复用已共享的 requestUserInput + 审批 UI）
export {
  assertSandbox,
  type SandboxPolicy,
  type SandboxMode,
  type AssertSandboxOpts
} from './sandbox/policy'
// 工具基类 + 共享文件工具套件（read/write/edit 整条流程，注入端适配 API）
export { BaseTool } from './tools/baseTool'
export {
  createFileToolSuite,
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
