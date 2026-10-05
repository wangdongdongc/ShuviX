/**
 * 真 SessionHost（agent-runtime 的 createSessionHost）接桌面存储路由 —— 存储层 / 接线层的 S 用例共用。
 *
 * faux 模型（`fauxKit`）、faux 模型目录（一条内置行 `faux`）、空 ToolHost、记录型 eventSink；
 * 重试与自动压缩关掉；真定时器。复用运行时测试的 faux / transcript / wait 辅助（相对路径 import ——
 * 桌面的 vitest 本来就跑 agent-runtime 的单测）。
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import {
  createSessionHost,
  type AgentConfig,
  type SessionHost,
  type SessionHostDeps,
  type ToolHost
} from '@shuvix/agent-runtime'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  fauxKit,
  type FauxKit
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import {
  defaultAgentConfig,
  fauxCatalog,
  fauxPort
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/agentConfig'
import { TEST_SETTINGS_OVERRIDES } from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'

export { fauxKit, type FauxKit }
export {
  answer,
  callTool,
  held,
  modelError,
  stalled
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
export {
  allEntries,
  requestTexts,
  transcript
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/transcript'
export {
  waitFor,
  withTimeout
} from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/wait'
export { defaultAgentConfig, fauxCatalog, fauxPort, TEST_SETTINGS_OVERRIDES }

/** 没有任何工具的 ToolHost（桌面用例不依赖过渡期的工具表） */
export const emptyToolHost: ToolHost = {
  buildBuiltinTools: () => [],
  resolveAgentTools: async () => ({ sandboxed: false }),
  rebuildAgentTools: () => ({})
}

/**
 * 每个 agent 都带上 `make(会话 id)` 给的工具的 ToolHost（S+T 用例：父会话拿到真的 `SessionTool`）。
 * 创建与重开时的重建都现造一份，资源按会话 id 找（与桌面 ToolHost 同一口径）。
 */
export function toolsToolHost(make: (sessionId: string) => readonly ToolRegistration[]): ToolHost {
  return {
    buildBuiltinTools: () => [],
    resolveAgentTools: async (request) => ({ sandboxed: false, tools: make(request.sessionId) }),
    rebuildAgentTools: (_record, context) => ({ tools: make(context.sessionId) })
  }
}

export interface RecordingSink {
  readonly events: ChatEvent[]
  broadcast(event: ChatEvent): void
  hasUserInputCapability(): boolean
}

export function recordingSink(): RecordingSink {
  const events: ChatEvent[] = []
  return {
    events,
    broadcast: (event) => void events.push(event),
    hasUserInputCapability: () => true
  }
}

/**
 * 测试用的宿主依赖覆盖：faux 模型与目录、空 ToolHost、关重试 / 自动压缩。`sessionHost.buildSessionHostDeps`
 * 的 overrides 与直接 `createSessionHost` 都能用。
 */
export function testDepsOverrides(
  kit: FauxKit,
  extra: Partial<SessionHostDeps> = {}
): Partial<SessionHostDeps> {
  return {
    models: kit.models,
    modelCatalog: fauxCatalog(kit, fauxPort()),
    toolHost: emptyToolHost,
    promptHost: {},
    promptVars: () => ({}),
    settingsOverrides: TEST_SETTINGS_OVERRIDES,
    today: undefined,
    ...extra
  }
}

/** 真宿主 + 指定的存储 seam（存储层用例传桌面路由的三个函数） */
export function makeRealHost(options: {
  storage: Pick<SessionHostDeps, 'openStorage' | 'storageExists' | 'deleteStorage'>
  isEphemeral?: (sessionId: string) => boolean
  agentConfig?: () => AgentConfig
  kit?: FauxKit
}): { host: SessionHost; kit: FauxKit; sink: RecordingSink } {
  const kit = options.kit ?? fauxKit()
  const sink = recordingSink()
  const host = createSessionHost({
    ...(testDepsOverrides(kit) as Pick<SessionHostDeps, 'models' | 'modelCatalog' | 'toolHost'>),
    resolveAgentConfig: options.agentConfig ?? (() => defaultAgentConfig()),
    ...options.storage,
    ...(options.isEphemeral === undefined ? {} : { isEphemeral: options.isEphemeral }),
    eventSink: sink
  })
  return { host, kit, sink }
}
