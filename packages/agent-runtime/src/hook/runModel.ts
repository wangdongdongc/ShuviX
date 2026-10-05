/**
 * hook run 的模型（P2-08 PIN-06，Q-P2-18）—— 宿主无关的「锁优先」解析，桌面与测试共用。
 *
 *  - **会话锁定了**：用锁的模型，原样（Q9 一致：provider 后来被停用，锁定的会话照样能用）；思考档位取根
 *    对话**此刻**的档位（`pi.agent.thinkingLevel` 是活的，K9），读不到才退回锁上记的那个。
 *  - **没锁**：会话的模型选择（provider 行 id + 模型 id）经 `resolveLockModel` 译成 pi provider id —— 与
 *    创建 agent 同一道校验：没有选择 → null（跳过 `no-model`）；行没了 / 停用 / 模型不存在 → `{refusal}`
 *    （一次失败的 run，error 即发送被拒的那句话）。思考档位取选择里的。
 *
 * 被派发 agent 自己的 `shuvix-model` / `shuvix-thinking` 仍然优先（协调器里，与任何派发一样）。
 */
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { backgroundContext as BG } from '../durable/context'
import type { DurableSession } from '../durable/durableSession'
import type { ModelCatalog } from '../durable/seams'
import { resolveLockModel, type ModelSelection } from '../models/lockModel'
import type { HookRunModel } from './hookRunner'

/** 会话此刻的模型选择（没锁时用） */
export interface HookModelSelection {
  /** provider 行 id + 模型 id；null = 没有选择 */
  model: ModelSelection | null
  thinkingLevel?: ThinkingLevel
  capabilities?: ModelCapabilities
}

export interface HookRunModelInput {
  /** 打开着的会话（关着 / 不存在 = undefined → 按没锁处理） */
  session: Pick<DurableSession, 'lock' | 'currentConversation'> | undefined
  /** 会话的模型选择（没锁时才读；null = 会话不存在） */
  selection: () => HookModelSelection | null | Promise<HookModelSelection | null>
  catalog: Pick<ModelCatalog, 'registry' | 'port'>
}

/** 锁优先的 hook run 模型（见文件头）。会话读取失败只影响思考档位（退回锁上记的） */
export async function resolveHookRunModel(input: HookRunModelInput): Promise<HookRunModel> {
  const lock = input.session?.lock
  if (lock !== undefined) {
    let thinkingLevel = lock.thinkingLevel as ThinkingLevel | undefined
    try {
      const conversation = await input.session!.currentConversation()
      thinkingLevel = (await conversation.agent(BG)).thinkingLevel as ThinkingLevel
    } catch {
      /* 读不到现在的档位：用锁上记的 */
    }
    return {
      provider: lock.model.provider,
      model: lock.model.modelId,
      capabilities: {},
      ...(thinkingLevel === undefined ? {} : { thinkingLevel })
    }
  }
  const selection = await input.selection()
  if (selection === null || selection.model === null) return null
  const resolution = resolveLockModel(input.catalog.registry, input.catalog.port, selection.model)
  if (!resolution.ok) return resolution.kind === 'no_model' ? null : { refusal: resolution.message }
  return {
    provider: resolution.model.provider,
    model: resolution.model.modelId,
    capabilities: selection.capabilities ?? {},
    ...(selection.thinkingLevel === undefined ? {} : { thinkingLevel: selection.thinkingLevel })
  }
}
