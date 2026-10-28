/**
 * 重配 —— 锁住的 root agent 换模型 / 扩展勾选（MCP、技能）时的纯规则（用户裁决 2026-10-26：改了立即
 * 生效，运行中也是；会打穿提供商提示词缓存的改动每次都先问用户，换模型也问）。
 *
 * durable 的 `configure()` 不看会话忙不忙；每次请求模型之前（generation 的 prepare）都重新解析 `pi.agent`，
 * 把「模型这次看到的工具 / 段落」与上一次的差异写成一条 `pi.system`。所以重配就是一次提交：从下一次请求起
 * 生效 —— 正在流式的这次请求、已经在执行的工具调用照旧跑完；模型已经发出、还没开始执行而工具被拿掉的那次
 * 调用拿到 durable 的 `tool_unavailable`（"Tool X is not available"）。
 *
 * 缓存保不保得住看两件事（pi-ai 1.2 `utils/transcript` 与各 api 适配器）：
 *
 *  - **工具差异的形状**。durable 的 `planTools`：留下的工具按原次序重放、新的追加在末尾；重放出来的次序与
 *    想要的不一样 → 全删全加。声明变了的（同名新定义）算一删一加。所以重配按 `orderForMinimalDiff` 排：
 *    模型上次看到的、声明没变的工具按它们在上下文里的次序打头，其余的跟在后面 —— 差异永远是最小的那一份。
 *  - **模型能不能在对话中途接受工具变化**（`toolChangeSupport`）：
 *    - `native`：anthropic-messages 且 `supportsMidConvoSystemMessages && supportsMidConvoToolChanges` ——
 *      增删都以原生块发送，缓存不破；
 *    - `additive`：openai-responses / codex / azure 且 `supportsAdditionalTools || supportsToolSearch`，或
 *      openai-completions 且 `supportsMidConvoSystemMessages && supportsMidConvoToolAdditions` —— 只有
 *      纯新增锚在原位；上下文里（最近一次重置以来）出现过删除或重新声明，之后的任何改动都整份重发；
 *    - `none`：其余 —— 工具列表放在请求顶层，任何改动都打穿缓存。
 *    兼容位只读模型目录里写明的（openai-completions 还会按地址探测，探测出来的这里看不到 —— 判多了只是
 *    多问一次）。
 *
 * 换模型一定打穿缓存（缓存按模型分）；段落（人设）变了要模型支持中途的 system 消息才保得住。
 */
import {
  declarationsEqual,
  getCurrentTools,
  hasNonAdditiveToolChanges,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type SystemMessage,
  type Tool
} from '@earendil-works/pi-ai'

const MCP_TOOL_PREFIX = 'mcp__'

/** MCP 工具名 `mcp__<server>__<tool>` 里的服务器名（服务器名不含 `__`）；不是 MCP 工具 → undefined */
export function mcpServerOfTool(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined
  const end = name.indexOf('__', MCP_TOOL_PREFIX.length)
  return end <= MCP_TOOL_PREFIX.length ? undefined : name.slice(MCP_TOOL_PREFIX.length, end)
}

// ─────────────────────────── 模型的能力 ───────────────────────────

export type ToolChangeSupport = 'native' | 'additive' | 'none'

type ModelCompatView = Pick<Model<Api>, 'api' | 'compat'>

function compatFlags(model: ModelCompatView): Record<string, unknown> {
  return (model.compat ?? {}) as Record<string, unknown>
}

/** 模型在对话中途能怎样接受工具变化而不打穿缓存（见文件头） */
export function toolChangeSupport(model: ModelCompatView): ToolChangeSupport {
  const compat = compatFlags(model)
  const midConvoSystem = compat.supportsMidConvoSystemMessages === true
  switch (model.api) {
    case 'anthropic-messages':
      return midConvoSystem && compat.supportsMidConvoToolChanges === true ? 'native' : 'none'
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
      return compat.supportsAdditionalTools === true || compat.supportsToolSearch === true
        ? 'additive'
        : 'none'
    case 'openai-completions':
      return midConvoSystem && compat.supportsMidConvoToolAdditions === true ? 'additive' : 'none'
    default:
      return 'none'
  }
}

/** 模型在对话中途能不能接受 system 消息（段落改动原地发送，缓存不破） */
export function supportsMidConvoSystemMessages(model: ModelCompatView): boolean {
  return compatFlags(model).supportsMidConvoSystemMessages === true
}

// ─────────────────────────── 工具次序 ───────────────────────────

/**
 * 让 durable 的工具差异最小的次序：`offered`（模型上次看到的工具）里声明没变、仍然想要的那些按 `offered` 的
 * 次序打头，`desired` 里其余的按 `desired` 的次序跟在后面。durable 重放「留下的 + 新增的」恰好得到这个次序，
 * 所以不会全删全加；上下文里还没有工具时原样返回 `desired`。
 */
export function orderForMinimalDiff<T extends Tool>(
  offered: readonly Tool[],
  desired: readonly T[]
): T[] {
  const byName = new Map(desired.map((tool) => [tool.name, tool]))
  const head: T[] = []
  const used = new Set<string>()
  for (const tool of offered) {
    const next = byName.get(tool.name)
    if (next === undefined || used.has(tool.name) || !declarationsEqual(tool, next)) continue
    head.push(next)
    used.add(tool.name)
  }
  return [...head, ...desired.filter((tool) => !used.has(tool.name))]
}

/**
 * 重配之后的工具（未排序的那份，再交给 `orderForMinimalDiff`）：此刻的工具按原次序，拿掉被取消的服务器的
 * 工具；然后是新服务器的工具（服务器次序）。同名只留第一个。技能工具原样留着：货架在创建时定下，重配不动它。
 */
export function composeReconfiguredTools<T extends { readonly name: string }>(input: {
  current: readonly T[]
  removedServers: ReadonlySet<string>
  addedMcp: readonly { readonly server: string; readonly tools: readonly T[] }[]
}): T[] {
  const kept = input.current.filter((tool) => {
    const server = mcpServerOfTool(tool.name)
    return server === undefined || !input.removedServers.has(server)
  })
  const appended: T[] = []
  for (const entry of input.addedMcp) appended.push(...entry.tools)
  const seen = new Set<string>()
  const tools: T[] = []
  for (const tool of [...kept, ...appended]) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    tools.push(tool)
  }
  return tools
}

// ─────────────────────────── 缓存预判 ───────────────────────────

/**
 * 预判的结论：
 *  - `kept`：下一次请求还能命中模型上次留下的缓存；
 *  - `lost`：不能（`reasons` 说为什么）；
 *  - `none`：还没有可失去的缓存（上下文里还没有过模型回复）。
 */
export type CacheVerdict = 'kept' | 'lost' | 'none'

export type CacheLossReason = 'model' | 'tools' | 'prompt'

export interface CacheImpact {
  cache: CacheVerdict
  reasons: CacheLossReason[]
  /** 上一次请求的提示词规模（输入 + 缓存读 + 缓存写）；没有过请求 = 0 */
  promptTokens: number
}

export interface CacheImpactInput {
  /** 模型看得到的上下文（最近一次重置以来，durable 的 view.messages） */
  messages: readonly Message[]
  /** 改动之后的模型（pi provider id + 模型 id） */
  nextModel: { readonly provider: string; readonly modelId: string }
  /** 它在模型目录里的条目；查不到 → 按 `none` 处理 */
  nextModelInfo: ModelCompatView | undefined
  /** 改动之后提供给模型的工具（已按 `orderForMinimalDiff` 排好；不含 `pendingServers` 的） */
  tools: readonly Tool[]
  /** 还没连上、工具还不知道的新服务器（它们的工具一律按新增算） */
  pendingServers?: readonly string[]
  /** 系统提示词的段落（人设）会不会变 */
  sectionsChange?: boolean
}

function lastAssistant(messages: readonly Message[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

/** 下一次请求还能不能命中缓存（见文件头） */
export function predictCacheImpact(input: CacheImpactInput): CacheImpact {
  const last = lastAssistant(input.messages)
  if (last === undefined) return { cache: 'none', reasons: [], promptTokens: 0 }
  const usage = last.usage
  const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0
  const reasons: CacheLossReason[] = []

  if (last.provider !== input.nextModel.provider || last.model !== input.nextModel.modelId) {
    reasons.push('model')
  }

  // 工具差异（durable planTools 的同一口径；tools 已按最小差异排好，不会全删全加）。还没连上的新服务器：
  // 上下文里已经有它的工具（取消了又勾回来，还没发出去）就当没变，否则按新增算
  const offered = getCurrentTools(input.messages)
  const pending = new Set(input.pendingServers ?? [])
  const isPending = (name: string): boolean => {
    const server = mcpServerOfTool(name)
    return server !== undefined && pending.has(server)
  }
  const wanted = new Map(input.tools.map((tool) => [tool.name, tool]))
  const keptNames = new Set<string>()
  const removed: Tool[] = []
  for (const tool of offered) {
    const next = wanted.get(tool.name)
    if (isPending(tool.name) || (next !== undefined && declarationsEqual(tool, next))) {
      keptNames.add(tool.name)
    } else {
      removed.push(tool)
    }
  }
  const added = input.tools.filter((tool) => !keptNames.has(tool.name))
  const offeredServers = new Set(offered.map((tool) => mcpServerOfTool(tool.name)))
  const pendingAdded = [...pending].filter((server) => !offeredServers.has(server))
  const toolsChange = removed.length > 0 || added.length > 0 || pendingAdded.length > 0

  if (toolsChange && !reasons.includes('model')) {
    const support =
      input.nextModelInfo === undefined ? 'none' : toolChangeSupport(input.nextModelInfo)
    if (support === 'none') reasons.push('tools')
    else if (support === 'additive') {
      // 拿 pi-ai 自己的判据看「加上这一条之后」的上下文：删除 / 重新声明（含加回一个早先删过的名字）都算
      const change: SystemMessage = {
        role: 'system',
        content: '',
        ...(removed.length > 0 ? { toolsRemoved: removed.map(({ name }) => ({ name })) } : {}),
        toolsAdded: [
          ...added.map(toToolDeclaration),
          ...pendingAdded.map((server) => pendingPlaceholder(server))
        ],
        timestamp: 0
      }
      if (hasNonAdditiveToolChanges([...input.messages, change])) reasons.push('tools')
    }
  }

  if (
    input.sectionsChange === true &&
    !reasons.includes('model') &&
    (input.nextModelInfo === undefined || !supportsMidConvoSystemMessages(input.nextModelInfo))
  ) {
    reasons.push('prompt')
  }

  return { cache: reasons.length > 0 ? 'lost' : 'kept', reasons, promptTokens }
}

/** 还没连上的服务器在判据里的占位工具（名字不会与任何真工具撞上） */
function pendingPlaceholder(server: string): Tool {
  return {
    name: `${MCP_TOOL_PREFIX}${server}__\u0000pending`,
    description: '',
    parameters: { type: 'object', properties: {} } as unknown as Tool['parameters']
  }
}
