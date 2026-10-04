/**
 * 假 MCP 服务器（每个「模拟进程」一份）：记连接次数与调用，能注入连接失败、扣住连接 / 调用、
 * 中途掉线、换工具表（list_changed）。调用时没连着就原地重连一次（与 McpManager 的「用到才连」一致）；
 * 调一个服务器不认识的工具 → isError 结果（不抛）。
 */
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { McpToolDeclaration } from '../../../mcpManager'
import { aborted } from './wait'

export interface FakeMcpCall {
  readonly tool: string
  readonly args: unknown
}

export interface FakeMcpServer {
  readonly name: string
  readonly connected: boolean
  /** 成功或失败的连接尝试都算一次 */
  readonly connects: number
  readonly calls: FakeMcpCall[]
  /** 此刻服务器报的工具表 */
  readonly declarations: McpToolDeclaration[]
  /** 之后的连接都失败（`heal()` 撤销） */
  failConnect(message?: string): void
  heal(): void
  /** 之后的连接都卡住，直到 release（或连接的 signal 中止） */
  holdConnect(): { readonly reached: Promise<void>; release(): void }
  disconnect(): void
  /** 换工具表（服务器侧的 list_changed） */
  setTools(declarations: McpToolDeclaration[]): void
  /** 之后的调用先等这个闸门（观察 signal）；`onCall` 在调用开始时触发 */
  gateCalls(gate: Promise<unknown>, onCall?: () => void): void
  connect(signal?: AbortSignal): Promise<void>
  call(tool: string, args: unknown, signal?: AbortSignal): Promise<ToolExecutionResult>
}

function copyDeclarations(declarations: readonly McpToolDeclaration[]): McpToolDeclaration[] {
  return JSON.parse(JSON.stringify(declarations)) as McpToolDeclaration[]
}

export function fakeMcpServer(
  name: string,
  declarations: readonly McpToolDeclaration[]
): FakeMcpServer {
  let connected = false
  let connects = 0
  let failure: string | undefined
  let hold: { promise: Promise<void>; release: () => void; reached: () => void } | undefined
  let callGate: { gate: Promise<unknown>; onCall?: () => void } | undefined
  let tools = copyDeclarations(declarations)
  const calls: FakeMcpCall[] = []

  const server: FakeMcpServer = {
    name,
    get connected() {
      return connected
    },
    get connects() {
      return connects
    },
    calls,
    get declarations() {
      return copyDeclarations(tools)
    },
    failConnect: (message = 'connection refused') => {
      failure = message
    },
    heal: () => {
      failure = undefined
    },
    holdConnect: () => {
      let release!: () => void
      let reached!: () => void
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve))
      const promise = new Promise<void>((resolve) => (release = resolve))
      hold = { promise, release, reached }
      return {
        reached: reachedPromise,
        release: () => {
          hold = undefined
          release()
        }
      }
    },
    disconnect: () => {
      connected = false
    },
    setTools: (next) => {
      tools = copyDeclarations(next)
    },
    gateCalls: (gate, onCall) => {
      callGate = { gate, ...(onCall === undefined ? {} : { onCall }) }
    },
    connect: async (signal) => {
      connects++
      const pending = hold
      if (pending !== undefined) {
        pending.reached()
        await (signal === undefined
          ? pending.promise
          : Promise.race([pending.promise, aborted(signal)]))
      }
      if (failure !== undefined) throw new Error(`MCP server "${name}": ${failure}`)
      connected = true
    },
    call: async (tool, args, signal) => {
      if (!connected) await server.connect(signal)
      calls.push({ tool, args })
      if (callGate !== undefined) {
        callGate.onCall?.()
        await (signal === undefined
          ? callGate.gate
          : Promise.race([callGate.gate, aborted(signal)]))
      }
      if (!tools.some((decl) => decl.name === tool)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `[MCP Error] unknown tool ${tool} on ${name}` }]
        }
      }
      return { content: [{ type: 'text', text: `${name}.${tool}:${JSON.stringify(args)}` }] }
    }
  }
  return server
}

/** 一个 MCP 工具声明（测试用的最小形状） */
export function mcpDecl(name: string, description = `${name} tool`): McpToolDeclaration {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    trusted: false
  }
}
