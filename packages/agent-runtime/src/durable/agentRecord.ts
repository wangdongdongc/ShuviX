/**
 * agent 记录 —— 「这个对话上的 agent 是谁」的纯 JSON 记录与它的校验 / 序列化（P1-09 锁记录；P2-01 派生
 * agent 记录）。
 *
 *  - **锁记录**（`LockRecord`）：会话根 agent 的锁，存在 `SessionStateDoc.lock`（`lock.ts` 管它的创建 /
 *    销毁 / 重开）。
 *  - **派生 agent 记录**（`SpawnedAgentRecord`）：一个派生 agent（`agent` 派发，或宿主派发的 hook agent）
 *    自己的那份锁形记录 —— 锁的全部字段（kind 恒为 `spawned`）加上派生字段（agentId、深度、能否再派生、
 *    派发方式、父对话、拥有它的任务、显示名、说明、hook 名、结果契约）。它**平铺**在子对话自己的
 *    `AgentStateDoc` 里（与冻结的人设并列，`kind` / `profileName` 两者共用），随人设一起冻结；不碰
 *    `SessionStateDoc.lock`。
 *
 * 两种记录共用一个校验器（锁字段那一段）：形状不对 → undefined；返回的对象是拷贝，不与文档快照共享
 * 任何东西；未知的键（人设、指令文件、上次告知的日期……）一律丢掉。序列化是严格 JSON（混进 bigint 之类
 * 当场抛错），可选字段缺省就不写这个键。
 *
 * 身份（`AgentIdentity`）是记录在工具眼里的那一截：档案名、root / spawned、惰性模型配置、调用方 id ——
 * 结构上就是桌面的 `ToolAgentIdentity`。
 */
import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import type {
  ConversationId,
  DocumentReader,
  JsonObject,
  TaskId,
  Tx
} from '@earendil-works/pi-durable'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { AgentKind } from '../agentProfile/promptVars'
import type { McpToolDeclaration } from '../mcpManager'
import type { LockModel } from '../models/lockModel'
import type { ResultContract } from '../subagent/nextTool'
import type { SubAgentModelConfig } from '../subagent/types'
import { AgentStateDoc } from './docs'

// ─────────────────────────── 锁记录 ───────────────────────────

/**
 * 锁记录（K2）—— 纯 JSON，存在 `SessionStateDoc.lock`。重开时据它重建工具（`ToolHost.rebuildAgentTools`），
 * 压缩窗口按它的模型算（K14）。派生 agent 记录在它之上加派生字段。
 */
export interface LockRecord {
  /** 上锁时的当前对话（回退 fork 之后可能不是根，K20）；按 agent 的扩展以它命名 */
  conversationId: ConversationId
  profileName: string
  kind: AgentKind
  /** durable 的 ModelRef 形状（pi provider id + 模型 id） */
  model: LockModel
  /** 创建时的思考档位（之后的调整只写 `pi.agent.thinkingLevel`，K9）；配置没给就不记 */
  thinkingLevel?: ThinkingLevel
  /** 提供给模型的工具，按次序（= `pi.agent.tools`） */
  toolNames: string[]
  /** 选中的扩展，按次序（= `pi.agent.extensions`） */
  extensions: string[]
  /** 命令沙箱钉子（K8） */
  sandboxed: boolean
  /** 连上了的 MCP 服务器 → 工具声明快照（重开时据此建注册项，不连服务器） */
  mcp: { [server: string]: McpToolDeclaration[] }
  /** 技能工具列出的技能 */
  skills: string[]
  createdAt: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** 纯 JSON 值的深拷贝（存储里读出来的本来就是 JSON） */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 锁字段那一段的校验与拷贝（两种记录共用）；kind 只认 root / spawned */
function parseLockFields(raw: Record<string, unknown>): LockRecord | undefined {
  const { conversationId, profileName, kind, model, thinkingLevel, toolNames } = raw
  const { extensions, sandboxed, mcp, skills, createdAt } = raw
  if (!isPositiveInteger(conversationId)) return undefined
  if (typeof profileName !== 'string') return undefined
  if (kind !== 'root' && kind !== 'spawned') return undefined
  if (!isObject(model) || typeof model.provider !== 'string' || typeof model.modelId !== 'string') {
    return undefined
  }
  if (thinkingLevel !== undefined && typeof thinkingLevel !== 'string') return undefined
  if (!isStringArray(toolNames) || !isStringArray(extensions) || !isStringArray(skills)) {
    return undefined
  }
  if (typeof sandboxed !== 'boolean') return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (!isObject(mcp)) return undefined
  for (const declarations of Object.values(mcp)) {
    if (!Array.isArray(declarations)) return undefined
    if (!declarations.every((decl) => isObject(decl) && typeof decl.name === 'string')) {
      return undefined
    }
  }
  return {
    conversationId: conversationId as ConversationId,
    profileName,
    kind,
    model: { provider: model.provider, modelId: model.modelId },
    ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
    toolNames: [...toolNames],
    extensions: [...extensions],
    sandboxed,
    mcp: cloneJson(mcp) as LockRecord['mcp'],
    skills: [...skills],
    createdAt
  }
}

/**
 * 校验并拷贝一条存储里的锁记录；形状不对 → undefined（重开时按「写坏了」处理，K12）。
 * 拷贝：返回的对象不与文档快照共享任何东西。kind 认 root 与 spawned（派生 agent 记录的锁字段部分
 * 同样能读成一条锁记录）。
 */
export function parseLockRecord(raw: unknown): LockRecord | undefined {
  return isObject(raw) ? parseLockFields(raw) : undefined
}

/** 锁记录 → 严格 JSON（非 JSON 的值 —— 如 MCP 声明里混进的 bigint —— 当场抛错） */
export function lockRecordJson(record: LockRecord): JsonObject {
  return copyJson(record as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject
}

// ─────────────────────────── 派生 agent 记录（P2-01） ───────────────────────────

/** 派生 agent 是怎么派出来的：`tool` = 模型调 `agent` 工具；`hook` = 宿主派发（hook 的 runTask） */
export type AgentDispatch = 'tool' | 'hook'

/**
 * 派生 agent 记录：锁记录（kind `spawned`）+ 派生字段。平铺在子对话的 `AgentStateDoc` 里
 * （`writeSpawnedAgentRecord` / `spawnedAgentRecordOf`），创建它的那个提交里随人设一起冻结。
 */
export interface SpawnedAgentRecord extends LockRecord {
  kind: 'spawned'
  /** agent id（`sub-<uuid>`，派发任务里记忆化）：调用方 id、面板 / 任务登记都按它 */
  agentId: string
  /** 派生深度（根的直接子 agent = 1） */
  depth: number
  /** 还能不能再派生（`depth < 上限`；决定工具清单里给不给 `agent`） */
  canSpawn: boolean
  dispatch: AgentDispatch
  /** 派出它的那个对话 */
  parentConversationId: ConversationId
  /** 拥有它这个对话的任务（派发工具任务 / 锚任务 / 发起审查的工具任务） */
  ownerTaskId: TaskId
  displayName: string
  description: string
  /** 宿主派发的 hook 名（`dispatch: 'hook'` 时） */
  hook?: string
  /** 结果契约（`next` 工具据它的 schema 重建） */
  resultContract?: ResultContract
}

/**
 * 派生层级上限的缺省值：根 agent 深度 0，它的直接子 agent 深度 1，再派生深度 2（与旧 manager 的
 * `DEFAULT_MAX_AGENT_DEPTH` 相同；宿主覆盖经 `SessionHostDeps.maxAgentDepth`，P2-05）。
 */
export const MAX_AGENT_DEPTH = 2

/**
 * 深度为 `depth` 的 agent 还能不能再派生（= 记录里的 `canSpawn`，决定工具清单里给不给 `agent`）：
 * 它的子 agent 深度 `depth + 1` 不超过上限，即 `depth < max`。
 */
export function canSpawnAt(depth: number, max: number = MAX_AGENT_DEPTH): boolean {
  return depth < max
}

function parseResultContract(raw: unknown): ResultContract | undefined {
  if (!isObject(raw) || !isObject(raw.schema)) return undefined
  const { nudges, sourceLabel } = raw
  if (nudges !== undefined && !(typeof nudges === 'number' && Number.isInteger(nudges))) {
    return undefined
  }
  if (typeof nudges === 'number' && nudges < 0) return undefined
  if (sourceLabel !== undefined && typeof sourceLabel !== 'string') return undefined
  return {
    schema: cloneJson(raw.schema),
    ...(nudges === undefined ? {} : { nudges }),
    ...(sourceLabel === undefined ? {} : { sourceLabel })
  }
}

/**
 * 校验并拷贝一条派生 agent 记录（`AgentStateDoc` 的值，或任何带这些字段的对象）；kind 不是 `spawned`
 * 或形状不对 → undefined。锁字段与锁记录同一个校验器；人设等其余键丢掉。
 *
 * 严格口径（PIN-09）：agentId 非空串（不查前缀）；depth 是 ≥ 1 的整数；ids 是正整数；hook 给了就得是
 * 字符串；结果契约是 `{schema: 对象, nudges?: ≥ 0 的整数, sourceLabel?: 字符串}`。不做跨字段校验
 * （hook 与 dispatch、记录里的 conversationId 与所在对话）。
 */
export function parseSpawnedAgentRecord(raw: unknown): SpawnedAgentRecord | undefined {
  if (!isObject(raw) || raw.kind !== 'spawned') return undefined
  const lock = parseLockFields(raw)
  if (lock === undefined) return undefined
  const { agentId, depth, canSpawn, dispatch, parentConversationId, ownerTaskId } = raw
  const { displayName, description, hook, resultContract } = raw
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined
  if (!isPositiveInteger(depth)) return undefined
  if (typeof canSpawn !== 'boolean') return undefined
  if (dispatch !== 'tool' && dispatch !== 'hook') return undefined
  if (!isPositiveInteger(parentConversationId) || !isPositiveInteger(ownerTaskId)) return undefined
  if (typeof displayName !== 'string' || typeof description !== 'string') return undefined
  if (hook !== undefined && typeof hook !== 'string') return undefined
  let contract: ResultContract | undefined
  if (resultContract !== undefined) {
    contract = parseResultContract(resultContract)
    if (contract === undefined) return undefined
  }
  return {
    ...lock,
    kind: 'spawned',
    agentId,
    depth,
    canSpawn,
    dispatch,
    parentConversationId: parentConversationId as ConversationId,
    ownerTaskId: ownerTaskId as TaskId,
    displayName,
    description,
    ...(hook === undefined ? {} : { hook }),
    ...(contract === undefined ? {} : { resultContract: contract })
  }
}

/** 派生 agent 记录 → 严格 JSON（非 JSON 的值当场抛错；可选字段缺省不写键） */
export function spawnedAgentRecordJson(record: SpawnedAgentRecord): JsonObject {
  return copyJson(record as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject
}

/** 派生 agent 记录在 `AgentStateDoc` 里占的键（锁字段 + 派生字段；`kind` / `profileName` 与人设共用） */
const SPAWNED_RECORD_KEYS = [
  'conversationId',
  'profileName',
  'kind',
  'model',
  'thinkingLevel',
  'toolNames',
  'extensions',
  'sandboxed',
  'mcp',
  'skills',
  'createdAt',
  'agentId',
  'depth',
  'canSpawn',
  'dispatch',
  'parentConversationId',
  'ownerTaskId',
  'displayName',
  'description',
  'hook',
  'resultContract'
] as const satisfies readonly (keyof SpawnedAgentRecord)[]

/**
 * 在调用方的提交里把派生 agent 记录平铺写进该对话的 `AgentStateDoc`（PIN-01）：记录的每个键整份覆盖，
 * 记录里缺省的可选键（思考档位 / hook / 结果契约）从文档删掉；其余键（人设、指令文件、根会话 id、
 * 上次告知的日期）原样保留。先严格序列化 —— 非 JSON 的值在碰文档之前就抛错。
 */
export async function writeSpawnedAgentRecord(
  tx: Tx,
  conversationId: ConversationId,
  record: SpawnedAgentRecord
): Promise<void> {
  const json = spawnedAgentRecordJson(record)
  const state = (await tx.doc(AgentStateDoc, conversationId)) as unknown as Record<
    string,
    JsonValue | undefined
  >
  for (const key of SPAWNED_RECORD_KEYS) {
    const value = json[key]
    if (value === undefined) delete state[key]
    else state[key] = value
  }
}

/** 读一个对话的派生 agent 记录（没有 / 不是派生 / 写坏了 → undefined） */
export async function spawnedAgentRecordOf(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context
): Promise<SpawnedAgentRecord | undefined> {
  return parseSpawnedAgentRecord(await read.snapshot(AgentStateDoc, conversationId, context))
}

// ─────────────────────────── 身份（P2-01） ───────────────────────────

/**
 * 一个对话上发起调用的 agent 在工具眼里的身份（结构上 = 桌面的 `ToolAgentIdentity`）：
 *  - 根（锁）：`{profileName, kind: 'root', getModelConfig}`，没有 callerId（桌面落回会话 id）；
 *  - 派生：`{profileName, kind: 'spawned', getModelConfig, callerId: agentId}`；
 *  - 派生但记录写坏了（PIN-04）：`{profileName, kind: 'spawned', callerId?}`，没有模型配置 —— 绝不认成根。
 * 模型配置不带思考档位（溯源章 / 安全主体只看 provider 与模型）。
 */
export interface AgentIdentity {
  profileName: string
  kind: AgentKind
  getModelConfig?: () => SubAgentModelConfig
  /** 调用方 id：派生 = agentId；缺省 = 根 agent（会话 id） */
  callerId?: string
}

function modelConfigOf(model: LockModel): () => SubAgentModelConfig {
  const { provider, modelId } = model
  return () => ({ provider, model: modelId, capabilities: {} })
}

/** 锁住的根 agent 的身份 */
export function rootAgentIdentity(lock: LockRecord): AgentIdentity {
  return { profileName: lock.profileName, kind: 'root', getModelConfig: modelConfigOf(lock.model) }
}

/** 派生 agent 的身份 */
export function spawnedAgentIdentity(record: SpawnedAgentRecord): AgentIdentity {
  return {
    profileName: record.profileName,
    kind: 'spawned',
    getModelConfig: modelConfigOf(record.model),
    callerId: record.agentId
  }
}
