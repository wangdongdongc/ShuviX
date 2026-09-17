/**
 * 内置 MCP 能力服务器注册表 —— 宿主无关。
 *
 * 「内置能力服务器」= 与产品同版本发布、跑在**进程内**、**按会话实例化**的 MCP server。
 * 它存在的理由只有三条第三方 server 拿不到的特权：专属安全客体、进程内 requestUserInput、
 * 专属渲染。三条都用不上的能力不该内置 —— 让用户自己加一台社区 server 即可。
 *
 * **为什么按会话实例化**：ssh 的 control socket、database 的连接、browser 的 CDP tab 都是
 * per-session 资源。而 MCP 协议里没有会话身份这一层（2026-07-28 更是把 `Mcp-Session-Id` 退了役），
 * 所以身份不往协议里塞 —— 一个会话一份 server 实例，天然就是答案。
 *
 * **scope 是泛型的**：运行时只保证 `sessionId`，宿主要什么自己往上加（桌面加了询问通道），
 * 这样「内置服务器需要宿主能力」这件事不必变成运行时的概念。
 *
 * 本模块只管「名字 → 工厂」和「造一对 InMemoryTransport 并把 server side 接上」。
 * 连接的生命周期归 McpManager（它按 `serverId#sessionId` 记账），资源释放归各 server 自己
 * 挂在 server-side transport 的 onclose 上。
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** 内置服务器拿到的会话上下文 —— 宿主可在自己的工厂里扩展更多字段 */
export interface BuiltinMcpScope {
  /** 归属会话；root 与派生 agent 共用根会话 id（与 ToolContext.sessionId 同源） */
  sessionId: string
}

/**
 * 内置服务器工厂：拿到会话上下文，把 server 接到给定的 server-side transport 上。
 *
 * 实现方负责 `server.connect(transport)`，并把自己的资源释放挂在 `transport.onclose`
 * （客户端断开会传播到这一侧，见 InMemoryTransport.close）。
 */
export type BuiltinMcpFactory<TScope extends BuiltinMcpScope = BuiltinMcpScope> = (
  scope: TScope,
  serverTransport: Transport
) => Promise<void> | void

/**
 * 名字 → 工厂。宿主在启动时 register，McpManager 造连接时 create。
 *
 * 注册表本身**不持有任何实例**：一份实例的寿命等于它那条连接的寿命，全部记在 McpManager 里，
 * 这样「会话结束 → 关连接 → 释放资源」只有一条路径。
 */
export class BuiltinMcpRegistry<TScope extends BuiltinMcpScope = BuiltinMcpScope> {
  private factories = new Map<string, BuiltinMcpFactory<TScope>>()

  /** 注册一台内置服务器（同名后注册的覆盖先注册的，便于测试替身） */
  register(name: string, factory: BuiltinMcpFactory<TScope>): void {
    this.factories.set(name, factory)
  }

  has(name: string): boolean {
    return this.factories.has(name)
  }

  names(): string[] {
    return [...this.factories.keys()]
  }

  /**
   * 造一对 InMemoryTransport，把 server side 交给工厂接上，返回 client side 给 McpManager。
   * 名字没注册时抛错 —— 配置里有 `type: 'inproc'` 的行却没有对应实现，属于装配期就该暴露的问题。
   */
  async createClientTransport(name: string, scope: TScope): Promise<Transport> {
    const factory = this.factories.get(name)
    if (!factory) {
      throw new Error(`No builtin MCP server registered under "${name}"`)
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await factory(scope, serverTransport)
    return clientTransport
  }
}
