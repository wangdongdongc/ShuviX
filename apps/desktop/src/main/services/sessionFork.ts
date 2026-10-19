/**
 * 会话 fork —— 把一条会话复制成一条新会话（整段当前对话，或从某条回复分支），放在源会话旁边。
 * 契约（谁能 fork、参数、拒绝原因）在 chat-protocol 的 `sessionFork.ts`。
 *
 * pi-durable 不能跨存储 fork 对话，所以新会话的存储是源会话存储的一份**整拷**：条目 id、显示侧车、来源、
 * 用量文档、派生 agent 的对话原样，fork 打开就和源会话此刻一模一样（连旧分支 —— 回退留下、看不见的 ——
 * 也在里面，与回退本身同一个代价）。步骤：
 *  1. 只读校验：源会话在、形态给（项目会话、不是笔记本 / 标签页 / 内存会话）、存储是新格式；
 *  2. 在源会话的 `whileIdle` 里拷存储（有工作在跑 / 被中断 → `busy`，什么都不建）；源会话还没有存储
 *     （从没发过消息）→ 不拷，fork 就是一条抄了设置的空会话；
 *  3. 拷贝收尾（`resetForkedSessionState`：锁、driven-run 标记、待送达通知属于源会话那一场），再插行、
 *     拷 artifacts；
 *  4. 给了 `messageId`：打开 fork、`branchAt` 那条回复（不合格 → 删掉 fork，`invalid_target`）；
 *  5. 广播一次列表变化。
 * 任何一步出错都把已建的半成品删掉（`failed`），源会话从不被写。
 *
 * 不拷的：工具大结果目录（历史里的路径指着源会话的 `tool_results/<id>/`，拷过去路径也对不上）、日历的开口
 * 记录（过去的那几天属于源会话）、子会话（它们仍是源会话的子会话）。
 */
import { v7 as uuidv7 } from 'uuid'
import { SessionClosedError, resetForkedSessionState } from '@shuvix/agent-runtime'
import {
  isForkableSessionShape,
  type SessionForkParams,
  type SessionForkRefusal,
  type SessionForkResult
} from '@shuvix/chat-protocol/sessionFork'
import { createLogger } from '../logger'
import { broadcastSessionListChanged } from '../utils/sessionConfigBroadcast'
import { copySessionArtifacts } from './artifacts/store'
import { parseEntryId } from './messageService'
import { getSessionHost } from './sessionHost'
import { sessionRecords } from './sessionRecords'
import { sessionService } from './sessionService'
import {
  copyDurableStorage,
  deleteSessionStorage,
  isDurableSession,
  openDurableStorageFile
} from './sessionStorage'

const log = createLogger('SessionFork')

function refused(reason: SessionForkRefusal): SessionForkResult {
  return { success: false, reason }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 拷贝这一步的结果：拷好了 / 源会话还没有存储 / 被拒 */
type CopyOutcome = 'copied' | 'empty' | 'busy' | 'invalid_target' | 'failed'

/**
 * 在源会话空闲时把它的存储拷成 fork 的（步骤 2）。`peek` 从不建存储：没有 → `empty`（给了回复 id 就是
 * `invalid_target` —— 空会话里没有回复）。给了回复 id 先在源会话此刻的视图里看一眼它在不在（便宜的预检，
 * 免得为一条早已不在的回复拷一整份；权威的判定是 fork 上的 `branchAt`）。句柄恰好在两步之间被关掉
 * （LRU / 退出）就再窥视一次、只再试一次 —— 拒绝都发生在任何写之前。打开源会话或拷贝出错 → 删掉写了一半的
 * 文件，`failed`。
 */
async function copyFromSource(
  sourceId: string,
  forkId: string,
  entryId: number | undefined
): Promise<CopyOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      // 打开源会话本身也可能失败（存储文件坏了、宿主正在退出）—— 与拷贝出错同样收场，从不往外抛
      const session = await getSessionHost().peek(sourceId)
      if (session === undefined) return entryId === undefined ? 'empty' : 'invalid_target'
      if (entryId !== undefined) {
        const { messages } = await session.viewSnapshot()
        const id = String(entryId)
        if (!messages.some((m) => m.id === id && m.role === 'assistant')) return 'invalid_target'
      }
      const result = await session.whileIdle(() => copyDurableStorage(sourceId, forkId))
      if (result.ok) return 'copied'
      if (result.reason === 'busy') return 'busy'
    } catch (err) {
      if (!(err instanceof SessionClosedError)) {
        log.warn(`拷贝会话存储失败 ${sourceId} → ${forkId}: ${errorText(err)}`)
        await deleteSessionStorage(forkId)
        return 'failed'
      }
    }
    if (attempt > 0) return 'failed'
  }
}

/** 把一条会话复制成一条新会话（见文件头）。从不抛出：出错是 `{ success: false, reason: 'failed' }` */
export async function forkSession(params: SessionForkParams): Promise<SessionForkResult> {
  const source = sessionRecords.findById(params.sessionId)
  if (!source) return refused('no_session')
  if (
    !isForkableSessionShape(source) ||
    sessionRecords.isEphemeral(source.id) ||
    !isDurableSession(source.id)
  ) {
    return refused('not_forkable')
  }
  let entryId: number | undefined
  if (params.messageId !== undefined) {
    entryId = parseEntryId(params.messageId)
    if (entryId === undefined) return refused('invalid_target')
  }

  const forkId = uuidv7()
  const copied = await copyFromSource(source.id, forkId, entryId)
  if (copied !== 'copied' && copied !== 'empty') return refused(copied)

  // 收尾 + 插行：行还没进库时出错，删掉拷出来的文件就是全部的收场
  try {
    if (copied === 'copied') await resetForkedSessionState(await openDurableStorageFile(forkId))
    sessionService.insertForkRow(source, forkId)
  } catch (err) {
    log.warn(`会话 fork 收尾失败 ${source.id} → ${forkId}: ${errorText(err)}`)
    await deleteSessionStorage(forkId)
    return refused('failed')
  }

  // 行已经在了：之后出错走完整的删除（存储、artifacts、行一起）
  try {
    copySessionArtifacts(source.id, forkId)
    if (copied === 'copied' && entryId !== undefined) {
      const fork = await getSessionHost().open(forkId)
      const branched = await fork.branchAt(entryId)
      if (!branched.ok) {
        await sessionService.delete(forkId)
        return refused(branched.reason === 'closed' ? 'failed' : 'invalid_target')
      }
    }
  } catch (err) {
    log.warn(`会话 fork 失败 ${source.id} → ${forkId}: ${errorText(err)}`)
    await sessionService.delete(forkId).catch((e: unknown) => {
      log.warn(`删除半成品 fork 失败 ${forkId}: ${errorText(e)}`)
    })
    return refused('failed')
  }

  broadcastSessionListChanged()
  log.info(`会话 fork ${source.id} → ${forkId}${entryId === undefined ? '' : ` @${entryId}`}`)
  return { success: true, sessionId: forkId }
}
