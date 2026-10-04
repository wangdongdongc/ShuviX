/**
 * 会话宿主（SessionHost）的注入接口 —— durable 核心不认识 Electron、不认识 node:sqlite：
 * 存储怎么开、在哪、算不算临时会话、钉不钉住，都由宿主回答。
 *
 * 桌面（P1-10）：openStorage = 动态 import node:sqlite 打开 `<sessionsDir>/<id>.sqlite`（临时会话给
 * MemoryStorage）；isPinned = 会话有活着 / 在建 / 关停中的运行时；onRunStateChange 写 DB 的运行标记。
 *
 * 系统提示词活段落的宿主 seam（`PromptHost`）也在这里定义（P1-08；桌面 P1-11 实现）。
 */
import type { Models } from '@earendil-works/pi-ai'
import type {
  HarnessOptions,
  RegistryReader,
  Storage,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { RuntimeEventSink, RuntimeLogger } from '../types'
import type { ShuviXSettingsOverrides } from './settings'

/**
 * 一条会话（一个存储）此刻的运行状态（裁决 R2）：
 *  - `busy`：调度器在跑且有活着的任务（运行中、后台压缩等）；
 *  - `interrupted`：存储里有未完成的 run，但调度器停着（上个进程中途退出，重新打开后从不自动续跑）；
 *  - `idle`：其余情况。
 */
export type RunState = 'idle' | 'busy' | 'interrupted'

/**
 * 中断会话上收到用户发送时怎么办（裁决 R5；**待用户确认**，必须保持是一行就能切换的选项）：
 *  - `abort-then-send`（默认）：中止被中断的那件事（上个进程留下的排队输入随之撤回），再发送；
 *  - `continue-then-queue`：先让被中断的 run 跑完，用户的消息作为 follow-up 排在它后面。
 */
export type InterruptedSendPolicy = 'abort-then-send' | 'continue-then-queue'

export const DEFAULT_INTERRUPTED_SEND_POLICY: InterruptedSendPolicy = 'abort-then-send'

/** LRU 保留的空闲会话数上限（与旧 sessionTreeRegistry 相同） */
export const DEFAULT_MAX_IDLE_OPEN = 8

/** 系统通知自动续跑的合并窗口（几条后台任务同一时刻跑完时只起一轮） */
export const DEFAULT_NOTICE_COALESCE_MS = 500

export interface SessionHostDeps {
  /** pi-ai 模型访问（生成用） */
  models: Models
  /** 扩展注册表（工具 / 段落 / 钩子）；可在运行中变化 */
  registry: RegistryReader<ToolRegistration>
  /** 打开（不存在则创建）某会话的存储 */
  openStorage: (sessionId: string) => Promise<Storage>
  /** 该会话的存储是否存在（peek 用它判断「不创建」；临时会话 = 内存存储是否还在） */
  storageExists: (sessionId: string) => boolean | Promise<boolean>
  /** 删除该会话的存储（文件连同 -wal / -shm；临时会话丢弃内存存储）。调用时会话已关闭 */
  deleteStorage: (sessionId: string) => Promise<void>
  /** 临时（内存）会话：永不被 LRU 关闭，也不占名额 */
  isEphemeral?: (sessionId: string) => boolean
  /** 宿主钉住的会话不被 LRU 关闭（抛错按钉住处理） */
  isPinned?: (sessionId: string) => boolean
  /** LRU 保留的空闲会话数（只数可回收的那些）；缺省 8 */
  maxIdleOpen?: number
  /**
   * 该会话根对话锁定模型的上下文窗口（同步；未知 / 未锁定返回 undefined → 按 32768 留余量）。
   * P1-09 起由锁记录回答。
   */
  contextWindow?: (sessionId: string) => number | undefined
  /** 每个 Harness 的 settings 覆盖（测试关掉重试 / 自动压缩） */
  settingsOverrides?: ShuviXSettingsOverrides
  /** 执行环境构造（durable 的 `HarnessOptions.env`） */
  env?: HarnessOptions['env']
  /** 额外的对话创建钩子（ShuviX 文档补种之后运行） */
  conversationCreated?: HarnessOptions['conversationCreated']
  /** 询问的广播与「有没有前端能展示询问面板」 */
  eventSink: RuntimeEventSink
  /**
   * 运行状态变化（idle / busy / interrupted）。关停一个忙碌的会话**不**发事件（DB 里的运行标记
   * 要能熬过退出）；重新打开一个被中断的会话会报 `interrupted`。抛错只记日志。
   */
  onRunStateChange?: (sessionId: string, state: RunState) => void
  /** 中止时、在中止对话之前调用（桌面：abortSessionReviews —— 进行中的自动审查当场作废） */
  beforeAbort?: (sessionId: string) => void
  /** 起跑路径重新受理询问时调用（桌面：reopenSessionReviews） */
  onInputsReopened?: (sessionId: string) => void
  /** 中断会话上的用户发送策略；缺省 abort-then-send（R5） */
  interruptedSendPolicy?: InterruptedSendPolicy
  /**
   * 自动续跑开关（现读）：只有修剪后字面量为 'false'（或布尔 false）才关闭，缺省 / 写坏都按开。
   */
  autoResume?: (sessionId: string) => unknown
  /** 通知合并窗口（毫秒）；缺省 500 */
  noticeCoalesceMs?: number
  /** durable 报告的扩展失败（不影响调用本身） */
  onReport?: (sessionId: string, error: unknown) => void
  logger?: RuntimeLogger
  /** 时钟（durable 的 `now`；日期通知里「上一条消息在多久之前」也按它算） */
  now?: () => number
  /**
   * 今天的本地日期（`YYYY-MM-DD`，桌面传 `() => localDate()`）。给了才发日期通知：每次用户输入之前，
   * 对话里已有条目且日期与上次告知的不同 → 先写一条 `shuvix.notice`（kind `date`，裁决 Q14）。
   * 缺省 = 不发（测试默认关闭，需要的用例自己注入一个确定的日期）。
   */
  today?: () => string
}

/** bot 段落的内容：一块（通常是 `renderBotContext` 的输出）、若干块、或者没有 */
export type BotContextBlocks = string | readonly string[] | null | undefined

/**
 * 系统提示词**活段落**的宿主 seam（P1-08；桌面在 P1-11 的 agentHost 里实现）。
 *
 * 人设在创建 agent 时冻结进 `AgentStateDoc`，不经这里；其余五段在**每次请求准备时**现调这些 seam
 * （durable 只把变化了的段落作为 `pi.system` 增量重发，所以内容不变就没有代价）。全部按根会话 id
 * 解析 —— 派生 agent 用它根会话的项目上下文。返回**原文**，围栏与修剪由段落统一加；
 * 不实现某个 seam = 那一段恒缺席。抛错时 durable 保留该段上一次的内容并报告。
 */
export interface PromptHost {
  /**
   * 指令文件：`candidates` 是档案 `shuvix-instruction-files` 的清单（顺序即优先级），宿主按序取第一个
   * 存在且非空的，至多一个。cwd 是对话 agent 的工作目录（未配置时为空串，宿主按会话兜底）。
   */
  resolveInstruction?: (
    rootSessionId: string,
    cwd: string,
    candidates: readonly string[]
  ) =>
    | { filename: string; content: string }
    | null
    | Promise<{ filename: string; content: string } | null>
  /** 项目提示词（项目设置里的纯文本；无项目 → null） */
  resolveProjectPrompt?: (rootSessionId: string) => string | null | Promise<string | null>
  /** 知识库引导（这条会话勾选的库；一个都没有 → null） */
  resolveKnowledgeBases?: (rootSessionId: string) => string | null | Promise<string | null>
  /** 只读的旧项目记忆索引（渲染好的正文；无项目 / 无记忆 → null） */
  resolveProjectMemory?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * bot 会话根 agent 的 `<bot_profile>` 块（`renderBotContext` 的输出；绑定的 md 不在了 → null）。
   * 可以给多块：每块修剪、空白块跳过、块间空一行（旧 `systemContext` 的口径）。
   */
  resolveBotContext?: (rootSessionId: string) => BotContextBlocks | Promise<BotContextBlocks>
}
