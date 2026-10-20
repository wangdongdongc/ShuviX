/**
 * 文件通道的 path 点位入口（2026-10-19，docs/network-policy/design.md）—— `files:read` / `files:write` /
 * `fs:listDirectories` 的处理函数在这里问：这次调用是网络客户端发的吗，是的话它要读 / 写的位置过不过安全策略。
 *
 * 单独成一个轻模块（只依赖类型）：处理函数不必为了这一问把整个网络服务（设置、数据库、视图同步……）拉进依赖图。
 * 网络服务在构造时登记自己的点位（`setNetworkPathGate`）；没登记（单测、网络服务还没建）→ 不判。
 */
import type { GateVerdict } from '@shuvix/agent-runtime'
import type { ClientContext } from '../../ipc/registry'
import type { NetworkCallFacts } from '../../../shared/network'

type PathGate = (
  facts: NetworkCallFacts,
  connection: string,
  mode: 'read' | 'write',
  path: string,
  tool: { name: string; operation: string }
) => GateVerdict

let gate: PathGate | undefined

/** 网络服务登记自己的 path 点位（undefined = 撤掉） */
export function setNetworkPathGate(next: PathGate | undefined): void {
  gate = next
}

/**
 * 网络客户端要读 / 写一个位置时按安全策略判：桌面窗口的调用 → undefined（不判，`path` 也不解析）；网络客户端 →
 * path 点位的结论（`path()` 给绝对路径）
 */
export function networkPathVerdict(
  ctx: ClientContext,
  mode: 'read' | 'write',
  path: () => string,
  tool: { name: string; operation: string }
): GateVerdict | undefined {
  if (ctx.transport !== 'network' || !ctx.network || !gate) return undefined
  return gate(ctx.network, ctx.client.id, mode, path(), tool)
}
