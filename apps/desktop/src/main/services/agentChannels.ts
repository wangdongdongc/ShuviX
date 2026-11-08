/**
 * 开放给 agent 的设置通道 —— 注解的形状（docs/mcp-config-compat-design.md §2.2）。
 *
 * agent 经一个固定的工具 `shuvix` 调 ShuviX 自己的设置 API（设置页、手机、网页调的同一批通道）。要让 agent 多改一样东西，
 * 就给那条通道写一份注解，不加工具（用户裁定 2026-11-08）。注解只回答四件事：
 *  - 给模型看什么：一句说明 + 参数结构（TypeBox，`describe` 时原样当 JSON Schema 给出去）；
 *  - 卡上摆什么：逐行的改动，要用户自己填的值；
 *  - agent 的参数怎么变成处理函数的参数：按名字找 id、env 按键合并 …… —— 处理函数照旧只认它自己的入参；
 *  - 结果给模型看什么：秘密值换成「已设置」，需要时顺手验证一次（回执，比如加完 MCP 服务器连一次）。
 *
 * 权限不在这里：工具按通道表的 scope / access 过 `ask-on-settings`（`access` 只在 agent 这条路确实比表上
 * 那一档做得少时才写，比如列表把秘密打了码）。
 */
import {
  channelAccessOf,
  channelGroupOf,
  channelScopeOf,
  type ChannelAccess
} from '../../shared/channelAccess'
import { mcpAdd, mcpDelete, mcpGetTools, mcpList, mcpUpdate } from './agentChannelsMcp'
import type { TSchema } from 'typebox'
import type { AskField } from '@shuvix/chat-protocol/types/inputRequest'

/** 卡上的内容（宿主按界面语言写好） */
export interface AgentChannelCard {
  /** 一句话：这次做什么 */
  title: string
  rows: Array<{ label: string; value: string }>
}

/** 回执与结果整理时可用的上下文 */
export interface AgentChannelCallContext {
  /** 发起调用的会话 */
  sessionId: string
  signal?: AbortSignal
}

export interface AgentChannel<A = Record<string, unknown>> {
  /** 通道名（`API_TABLE` 里的那条，`mcp:add`） */
  channel: string
  /** 给模型看的一句话（英文，`describe` 列出来的） */
  summary: string
  /** agent 传的参数（一个对象）的结构 */
  params: TSchema
  /**
   * agent 这条路的访问级别，缺省 = 通道表的（channelAccess.ts）。只能往松里写一档的理由是这条路确实做得少：
   * `mcp:list` 在表上是 admin（返回值带 key），给 agent 的结果打了码，就是 read
   */
  access?: ChannelAccess
  /** 要用户在卡上填的值（agent 留空的秘密）；没有 → 空 */
  fieldsOf?(args: A): AskField[]
  /** 把卡上填的值放回参数（键与 fieldsOf 给的一致） */
  withValues?(args: A, values: Record<string, string>): A
  /** 卡上摆什么（只在要问的时候用） */
  card(args: A): AgentChannelCard
  /**
   * agent 的参数 → 处理函数的参数（按位置）。说不通的（名字不存在、内置服务器不能改命令）在这里抛错，
   * 文案给模型 —— 这时还什么都没改
   */
  toHandlerArgs(args: A): unknown[]
  /** 处理函数的结果 → 给模型看的（不带秘密）；需要验证的在这里做（回执） */
  present(result: unknown, args: A, ctx: AgentChannelCallContext): Promise<unknown>
}

/** 注册表里存的是擦掉参数类型的那一份 */
export type AnyAgentChannel = AgentChannel<Record<string, unknown>>

// ─── 注册表 ───
// 要让 agent 多改一样东西：写一份注解，加进下面的清单 —— 不加工具。没在清单里的通道，`shuvix` 工具一律不认。

const erase = <A>(channel: AgentChannel<A>): AnyAgentChannel =>
  channel as unknown as AnyAgentChannel

/** 按 scope、再按这里的顺序列给模型看 */
export const AGENT_CHANNELS: readonly AnyAgentChannel[] = [
  erase(mcpList),
  erase(mcpGetTools),
  erase(mcpAdd),
  erase(mcpUpdate),
  erase(mcpDelete)
]

const byName = new Map(AGENT_CHANNELS.map((channel) => [channel.channel, channel]))

export function agentChannelOf(channel: string): AnyAgentChannel | undefined {
  return byName.get(channel)
}

/** 这条通道在 agent 这条路上的策略事实（与网络客户端同一套词；access 可由注解往松里写一档，见 types.ts） */
export function agentChannelFacts(channel: AnyAgentChannel): {
  channel: string
  group: string
  scope: string
  access: ChannelAccess
} {
  return {
    channel: channel.channel,
    group: channelGroupOf(channel.channel),
    scope: channelScopeOf(channel.channel),
    access: channel.access ?? channelAccessOf(channel.channel)
  }
}
