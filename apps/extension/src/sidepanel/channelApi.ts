/**
 * 侧边栏的 SessionChannelApi —— chat-ui 单会话「渠道」模式的后端（`setSessionChannelApi` 注入；
 * 于是宿主管理类界面：模型切换、项目、会话配置、设置入口，都自动隐藏）。
 *
 * 会话跑在桌面：对话接口经 SW → 原生消息 → 桌面转发（桌面只接白名单、并核对会话归属）。
 * 这类会话用不上的几样在这里就地回空：文件浏览与 `@` 引用（`tab` 档案没有文件工具）、斜杠命令、
 * 知识库引用、朗读、子代理（见 chat-protocol `CHROME_PANEL_CHANNEL_PATHS` 的说明）。
 *
 * 发送时把选中的标签页作为行内 token 并进消息（见 tabSelection.ts）。
 */
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { ChromePanelChannelPath } from '@shuvix/chat-protocol/chromeBridge'
import {
  syncInvokeError,
  type JsonValue,
  type SyncChannel,
  type SyncFrame,
  type SyncInvokeResult
} from '@shuvix/chat-protocol/sync'
import type { PanelLink } from './panelLink'
import { resolveSelectedTabs, withTabTokens } from './tabSelection'

/** 侧边栏连接里视图同步要的那一点（PanelLink 满足它） */
type SyncLink = Pick<PanelLink, 'request' | 'onSyncFrame'>

/**
 * 视图同步的渠道（P3-09）：`invoke` = `channel.call('sync.invoke', [target, call])`，桌面回一个信封
 * （`SyncInvokeResult`）—— `ok:false` 抛带 `.code` 的 Error（chord 的错误码，如 `service_not_found`）；
 * 桥这一层的失败（`desktop-offline`、归属核对没过 …）只是一段文本，按 PIN-13 原样当成 `.code`。
 * `onFrame` 收 SW 转来的 `sync.frame`（只有挂着这条会话的侧边栏收得到）。
 */
export function createPanelSyncChannel(link: SyncLink): SyncChannel {
  return {
    invoke: async (target, call) => {
      let envelope: SyncInvokeResult
      try {
        envelope = (await link.request('channel.call', {
          path: 'sync.invoke',
          args: [target, call]
        })) as SyncInvokeResult
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw syncInvokeError({ code: message, message })
      }
      if (!envelope || typeof envelope !== 'object') {
        throw syncInvokeError({ message: 'ShuviX sent a malformed sync reply.' })
      }
      if (envelope.ok) return envelope.value as JsonValue | undefined
      throw syncInvokeError(envelope.error ?? { message: 'ShuviX reported an error.' })
    },
    onFrame: (callback) => link.onSyncFrame((frame) => callback(frame as SyncFrame))
  }
}

export function createPanelChannelApi(link: PanelLink): SessionChannelApi {
  const call = <T>(path: ChromePanelChannelPath, ...args: unknown[]): Promise<T> =>
    link.request('channel.call', { path, args }) as Promise<T>

  return {
    app: {
      platform: 'web',
      // 链接在用户自己的浏览器里开一个新标签页 —— 侧边栏本就在浏览器里
      openExternal: async (url) => {
        await chrome.tabs.create({ url })
        return { success: true }
      }
    },
    agent: {
      init: (params) => call('agent.init', params),
      prompt: async (params) => {
        const tabs = await resolveSelectedTabs()
        return call('agent.prompt', {
          ...params,
          ...withTabTokens(params.text, params.inlineTokens, tabs)
        })
      },
      subAgentPrompt: async () => ({ success: false }),
      subSessionDestroy: async () => ({ success: false }),
      subSessionInterrupt: async () => ({ success: false }),
      steer: (params) => call('agent.steer', params),
      followUp: (params) => call('agent.followUp', params),
      withdrawQueued: (params) => call('agent.withdrawQueued', params),
      abort: (sessionId) => call('agent.abort', sessionId),
      continue: (sessionId) => call('agent.continue', sessionId),
      respondToInput: (params) => call('agent.respondToInput', params),
      onEvent: (callback) =>
        link.onChatEvent((event) => callback(event as Parameters<typeof callback>[0]))
    },
    session: {
      getById: (id) => call('session.getById', id)
    },
    message: {
      list: (sessionId) => call('message.list', sessionId)
    },
    runtime: {
      statuses: (sessionId) => call('runtime.statuses', sessionId)
    },
    bgTask: {
      list: (params) => call('bgTask.list', params),
      readLog: async (params) => ({
        exists: false,
        text: '',
        fromByte: params.fromByte ?? 0,
        nextByte: params.fromByte ?? 0,
        size: 0
      })
    },
    tools: {
      list: (sessionId) => call('tools.list', sessionId),
      presentations: () => call('tools.presentations'),
      definitions: () => call('tools.definitions')
    },
    command: {
      list: async () => []
    },
    files: {
      scan: async () => ({ paths: [], truncated: false, root: null }),
      scanDir: async () => ({ files: [], dirs: [], root: null }),
      read: async ({ path }) => ({
        kind: 'not-allowed',
        path,
        reason: 'Files are not available in the Chrome side panel.'
      }),
      watch: async () => {},
      unwatch: async () => {}
    },
    shuvixMd: {
      validate: (params) => call('shuvixMd.validate', params)
    },
    mentions: {
      listKnowledgeEntries: async () => []
    },
    events: {
      subscribe: (callback) =>
        link.onAppEvent((event) => callback(event as Parameters<typeof callback>[0]))
    },
    tts: {
      speakOnce: async () => {},
      abortTts: async () => {},
      onChunk: () => () => {}
    },
    sync: createPanelSyncChannel(link)
  }
}
