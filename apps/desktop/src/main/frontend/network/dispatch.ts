/**
 * 网络客户端的请求分发（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— WebSocket 上来的
 * `invoke` / `send` 交给通道注册表里的同一份定义（`defineHandler` / `defineListener`），与 IPC 一样。
 *
 *  - **只分发通道表定义了的请求通道**：`API_TABLE` 与 `API_OVERRIDE_CHANNELS` 里种类为 invoke / send 的通道，
 *    消息种类要对得上（`invoke` → invoke 通道 + `handle` 定义；`send` → send 通道 + `listen` 定义）。
 *    别的一律不认：invoke 回 `ok:false`（`unknown_channel`），send 丢掉。
 *  - **`sync:frame` 不经这里**：网络客户端的视图同步走自己的 `{t:'sync'}` 消息（`networkLinks.ts`），那条
 *    IPC 通道的处理函数只认桌面窗口。
 *  - **只有桌面窗口能用的通道**（`DESKTOP_ONLY_CHANNELS`：开窗、系统文件管理器、原生对话框）：回 `ok:false`
 *    （`desktop_only`），处理函数不执行 —— 远处的人看不见那扇窗，坐在这台电脑前的人却会被吓一跳。
 *  - 处理函数回 `undefined` → 结果不带 `value`（编码时省掉，见 `networkEnvelope`）；抛了 / 拒绝了 →
 *    `ok:false`，带它的消息（与 `code`，如果它带了字符串的 code）。listen 的处理函数抛了只记日志。
 */
import { API_OVERRIDE_CHANNELS, API_TABLE, DESKTOP_ONLY_CHANNELS } from '../../../shared/apiTable'
import {
  envelopeErrorOf,
  type ClientMessage,
  type ServerMessage
} from '../../../shared/networkEnvelope'
import type { ChannelDefinition, ClientContext } from '../../ipc/registry'

/** 网络客户端不经请求分发走的通道（视图同步有自己的消息） */
export const NETWORK_EXCLUDED_CHANNELS: ReadonlySet<string> = new Set(['sync:frame'])

type RequestKind = 'invoke' | 'send'

/** 通道表里的请求通道 → 种类（表条目 + override；推送通道不在里面） */
function tableRequestChannels(): ReadonlyMap<string, RequestKind> {
  const map = new Map<string, RequestKind>()
  for (const members of Object.values(API_TABLE)) {
    for (const member of Object.values(members)) {
      if (member.kind === 'invoke' || member.kind === 'send') map.set(member.channel, member.kind)
    }
  }
  for (const members of Object.values(API_OVERRIDE_CHANNELS)) {
    for (const member of Object.values(members)) {
      if (member !== null && (member.kind === 'invoke' || member.kind === 'send')) {
        map.set(member.channel, member.kind)
      }
    }
  }
  return map
}

const REQUEST_CHANNELS = tableRequestChannels()

/** 一条请求通道对网络客户端的裁决 */
export type NetworkChannelVerdict = 'ok' | 'unknown' | 'desktop_only'

/** 某种消息、某条通道，网络客户端能不能调（只看通道表，不看有没有定义） */
export function networkChannelVerdict(channel: string, kind: RequestKind): NetworkChannelVerdict {
  if (NETWORK_EXCLUDED_CHANNELS.has(channel)) return 'unknown'
  if (REQUEST_CHANNELS.get(channel) !== kind) return 'unknown'
  if (Object.hasOwn(DESKTOP_ONLY_CHANNELS, channel)) return 'desktop_only'
  return 'ok'
}

export interface DispatcherLogger {
  warn(message: string): void
}

export interface NetworkDispatcher {
  /** 一条 invoke：回要发回去的结果（从不拒绝） */
  invoke(
    ctx: ClientContext,
    message: Extract<ClientMessage, { t: 'invoke' }>
  ): Promise<ServerMessage>
  /** 一条 send：交给 listen 定义（不回任何东西；不认的通道丢掉） */
  send(ctx: ClientContext, message: Extract<ClientMessage, { t: 'send' }>): void
}

/**
 * 分发器。`definitionOf` 取注册表里某条通道此刻的定义（网络传输的 `serve` 收下的那一份）。
 */
export function createNetworkDispatcher(deps: {
  definitionOf: (channel: string) => ChannelDefinition | undefined
  logger?: DispatcherLogger
}): NetworkDispatcher {
  const logger = deps.logger ?? { warn: () => {} }

  const failure = (id: number, message: string, code: string): ServerMessage => ({
    t: 'result',
    id,
    ok: false,
    error: { message, code }
  })

  return {
    async invoke(ctx, message) {
      const { id, channel, args } = message
      const verdict = networkChannelVerdict(channel, 'invoke')
      if (verdict === 'desktop_only') {
        return failure(
          id,
          `"${channel}" is only available in the desktop app for now`,
          'desktop_only'
        )
      }
      const definition = verdict === 'ok' ? deps.definitionOf(channel) : undefined
      if (definition === undefined || definition.kind !== 'handle') {
        return failure(id, `No handler registered for "${channel}"`, 'unknown_channel')
      }
      try {
        const value = await definition.fn(ctx, ...args)
        return value === undefined
          ? { t: 'result', id, ok: true }
          : { t: 'result', id, ok: true, value }
      } catch (error) {
        return { t: 'result', id, ok: false, error: envelopeErrorOf(error, 'handler_error') }
      }
    },

    send(ctx, message) {
      const { channel, args } = message
      if (networkChannelVerdict(channel, 'send') !== 'ok') return
      const definition = deps.definitionOf(channel)
      if (definition === undefined || definition.kind !== 'listen') return
      try {
        definition.fn(ctx, ...args)
      } catch (error) {
        logger.warn(`network send "${channel}" from ${ctx.client.id} failed: ${String(error)}`)
      }
    }
  }
}
