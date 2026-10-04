/**
 * 测试工具：扣住的工具（等闸门）与发起询问的工具。经 defineExtension 安装 —— 没有显式选择时，
 * 每个对话默认选中全部已安装的扩展。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { DurableSession } from '../../durableSession'
import { aborted } from './wait'

export interface HoldToolOptions {
  /** 观察调用的 signal（缺省 true）；false = 对中止充耳不闻（死锁用例需要） */
  signalAware?: boolean
  /** 工具开始执行 */
  onRun?: () => void
  /** 闸门放行之后、返回之前 */
  afterGate?: (signal: AbortSignal | undefined) => void | Promise<void>
  result?: string
}

/** 等 `gate` 放行再返回的工具 */
export function holdTool(
  name: string,
  gate: Promise<unknown>,
  options: HoldToolOptions = {}
): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: waits for the test`,
    parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      options.onRun?.()
      const signal = context.abortSignal
      if (options.signalAware === false || signal === undefined) await gate
      else await Promise.race([gate, aborted(signal)])
      await options.afterGate?.(signal)
      return { content: [{ type: 'text', text: options.result ?? `${name} done` }] }
    }
  })
}

export interface AskingToolOptions {
  /** 询问落定那一刻（工具继续执行之前）：记下 signal 是否已中止 */
  onResolved?: (response: InputResponse, signalAborted: boolean | undefined) => void
  /** 询问发出前先等这个闸门（对 signal 充耳不闻） */
  gate?: Promise<unknown>
  /** 工具开始执行 */
  onStart?: () => void
}

/** 调用会话的 requestUserInput，把应答原样作为结果文本返回 */
export function askingTool(
  name: string,
  getSession: () => DurableSession,
  options: AskingToolOptions = {}
): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: asks the user`,
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      options.onStart?.()
      if (options.gate !== undefined) await options.gate
      const response = await getSession().requestUserInput({
        id: api.callId,
        kind: 'ask',
        toolName: name,
        command: `run ${name}`,
        createdAt: 0
      })
      options.onResolved?.(response, context.abortSignal?.aborted)
      return { content: [{ type: 'text', text: JSON.stringify(response) }] }
    }
  })
}

export function toolsExtension(tools: readonly ToolRegistration[], name = 'test-tools'): Extension {
  return defineExtension({ name, tools })
}
