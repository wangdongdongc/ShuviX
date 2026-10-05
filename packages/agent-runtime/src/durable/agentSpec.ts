/**
 * agent 规格的纯派生 —— 思考档位与工具名单的 root·spawned 决策表（P1-01 从旧创建管线抽出）。
 *
 * 这里不碰任何运行时 —— 构造运行时（根 agent 的锁 `lock.ts`、派生 agent 的 durable 子对话 `spawn.ts`）是
 * 调用方的事，它们各取这里的 `normalizeToolNames` / `resolveThinkingLevel`。
 *
 * | 项        | root                                    | spawned                             |
 * |-----------|-----------------------------------------|-------------------------------------|
 * | 思考档位   | 传入值（会话设置）                       | 档案 shuvix-thinking 优先，否则继承  |
 * | 工具名单   | 档案全量 + 会话勾选（只收 mcp:/skill:）  | 档案全量 + overlay                  |
 *
 * 初始模型那一行不在这里：root 以会话设置为准（锁），spawned 的 `shuvix-model` 由协调器经
 * `SessionHostDeps.resolveProfileModel` 解析（`spawn.ts`）。系统提示词也不在这里拼：人设在创建 agent 时冻结
 *（`prompt/persona.ts`），其余注入各是一个现解析的段落扩展（`prompt/sections.ts`）。
 */
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { InProcessAgentType } from '../subagent/types'
import type { AgentKind } from '../agentProfile/promptVars'

/** 会话级工具（用户能在工具选择器里勾选的那两类）；其余为内置工具名 + 'agent' */
const isSessionScopedTool = (name: string): boolean =>
  name.startsWith('mcp:') || name.startsWith('skill:')

/**
 * 名单归一：档案白名单 + 会话勾选 overlay，去重保序。
 *
 * 档案的 `shuvix-tools` 对内置 / mcp / skill 三类是**一并声明**的，而且三类都**恒生效** ——
 * root 与 spawned 同一条规则：档案写了什么，这个 agent 就带什么。会话勾选只能往上**加**：
 *  - 内置工具名恒由档案决定（选择器里本就看不到它们）；
 *  - mcp: / skill: 档案声明的那截恒在，会话勾选在其上叠加。选择器与会话设置把档案声明的项
 *    画成「已勾、锁住」（`tools.list` 的 `declaredBy`）—— 界面上取消不了，也就不存在
 *    「取消了却被档案并集加回来」的假勾选。要去掉一项，路径是覆盖这份档案 md。
 *  - root 的 overlay **只收** mcp: / skill:：勾选里混进一个内置名（手改的设置、被新会话继承的
 *    项目配置）不能借 overlay 越过档案 —— bot 基座的窄名单因此是结构保证。
 *  - spawned 没有选择器也没有会话设置，档案即全部（overlay 恒为空）。
 *
 * 于是 `shuvix-tools` 加上会话勾选就是 agent 工具表的完整列举：宿主不在这份名单之外另挂工具
 * （内置技能也要档案点名 `skill:builtin:<name>` 才上架）。
 */
export function normalizeToolNames(
  kind: AgentKind,
  profileTools: readonly string[],
  overlay: readonly string[] | undefined
): string[] {
  const added = kind === 'root' ? (overlay ?? []).filter(isSessionScopedTool) : (overlay ?? [])
  return [...new Set([...profileTools, ...added])]
}

/**
 * 思考档位（决策表的思考一行，与协调器的模型一行同一口径）。
 *
 * root：以传入值为准（会话设置；档案的 `shuvix-thinking` 只在钉档案时作为种子写进去）。
 * spawned：档案声明优先于派发方继承。没有可用性问题要处理：档位是个枚举值，模型不支持
 *       思考时与界面选了档位同一条路径（pi 按模型能力取舍）。
 */
export function resolveThinkingLevel(
  kind: AgentKind,
  profile: InProcessAgentType,
  requested: ThinkingLevel | undefined
): ThinkingLevel | undefined {
  return kind === 'spawned' && profile.thinkingLevel ? profile.thinkingLevel : requested
}
