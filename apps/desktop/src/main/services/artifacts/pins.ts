/**
 * 回复里 ```artifact 引用钉下的版本 —— 宿主这一侧：什么时候钉、名字落到哪个文件、内容存进哪个仓库；
 * 读的时候按钉取回当时那一版。文档的读写与「哪条回复」的查找在 agent-runtime（durable/artifactPins.ts）。
 *
 * 为什么钉而不是按时间推断：引用块此前总是现取文件的当前内容，一件改过几次的产物，往回翻看到的全是
 * 最新版。按「版本时间 ≤ 消息时间」去 git 历史里推断，错了也没有任何信号（子会话、后台命令写的改动，
 * 两个时钟）。钉是**写下引用那一刻记下的事实**：那条回复引用的每件产物当时是哪一份内容。
 *
 * **什么时候钉**（一条回复写完、它的工具开始执行之前 —— 那之后文件才可能被改）：
 *  - 工具调用之前（工具包装器的执行钩子，见 agentHost）：发起这次调用的那条回复（toolCall 认 callId）；
 *  - 一轮结束时（`agent_end`，见 sessionHost）：这一轮的终答（最新的条目是一条不带工具调用的回复）。
 * 同一条回复的并行调用各来一次：进程内记着处理过的，在途的合用一个 promise，文档里钉过的不再改。
 *
 * **钉什么**：回复正文里每个闭合的引用（名字的取法与渲染端同一份，chat-protocol `artifactFence`），按
 * `artifact:read` 的口径找文件（本会话，再往下一层子会话），把那一刻的内容存成那个产物目录里的一个 blob
 * （按内容寻址，不依赖提交历史）。找不到的名字不钉 —— 渲染端照最新版显示、标出来。
 *
 * **读**：有消息 id 就先查钉，取得到那一份就显示它，并告诉渲染端它是不是还等于文件当前的内容；没有钉
 * （功能上线前的旧回复、流式中、钉失败了）或那一份取不回来 → 当前内容，`pinned: false`。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  findCallingReply,
  findFinalReply,
  hasArtifactPins,
  hashBlobText,
  readArtifactPins,
  writeArtifactPins,
  type ArtifactPin,
  type ArtifactReply,
  type DurableSession
} from '@shuvix/agent-runtime'
import type { ConversationId } from '@earendil-works/pi-durable'
import { artifactFenceNames } from '@shuvix/chat-protocol/utils/artifactFence'
import { createLogger } from '../../logger'
import { appEventBus } from '../../utils/appEventBus'
import { getSessionArtifactsDir, isSafeSessionId } from '../../utils/paths'
import { sessionRecords } from '../sessionRecords'
import { readArtifactBlob, storeArtifactBlob } from './history'
import { findArtifact, titleOf } from './store'

const log = createLogger('ArtifactPins')

/** 钉与读要用到的那一点会话面 */
export type PinSession = Pick<DurableSession, 'harness' | 'currentConversation'>

/** `artifact:read` 的结果：钉下的那一版，或当前内容 */
export interface ArtifactReadResult {
  /** 产物所在的会话（本会话或一个直接子会话） */
  sessionId: string
  name: string
  title: string
  content: string
  /** 显示的是这条回复钉下的那一版 */
  pinned: boolean
  /** 显示的内容就是文件此刻的内容（没钉的恒为 true；钉下的那一版之后又被改过 → false） */
  latest: boolean
}

/**
 * 一个名字去哪几场会话的产物目录里找：本会话，再往下一层子会话（产物的目录跟着产出它的会话走，`work`
 * 把具体活交给子会话 —— 子会话画的图，父会话回复里的引用必须找得到）。嵌套只有一层，不递归。
 */
export function artifactOwners(sessionId: string): string[] {
  return [sessionId, ...sessionRecords.findChildren(sessionId).map((c) => c.id)]
}

/** 本会话或它的直接子会话有没有产物目录（一件都没有就不可能有钉得住的引用） */
function hasAnyArtifacts(sessionId: string): boolean {
  return artifactOwners(sessionId).some(
    (owner) => isSafeSessionId(owner) && existsSync(getSessionArtifactsDir(owner))
  )
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 进程内处理过的回复（`<会话>#<条目>`）：钉过、没有引用、或引用都找不到 —— 同一条不再查第二遍。
 * 只是省一次文档读，满了就整个清掉（清掉的再来一次也只是多读一次、照样不覆盖）
 */
const handled = new Set<string>()
const HANDLED_MAX = 5000
/** 正在钉的回复：同一条回复的并行调用合用一次 */
const inflight = new Map<string, Promise<void>>()

/** 一个名字此刻的那一份：找到文件、存成 blob；找不到或存不进 → undefined */
async function pinOne(sessionId: string, name: string): Promise<ArtifactPin | undefined> {
  for (const owner of artifactOwners(sessionId)) {
    const found = findArtifact(owner, name)
    if (!found) continue
    const content = readText(found.path)
    if (content === null) continue
    const oid = await storeArtifactBlob(owner, content)
    if (oid === null) return undefined
    // 自己目录里的不记会话 id（fork 整拷存储与目录，读的时候按读的那场会话算），子会话的记它的 id
    return owner === sessionId
      ? { file: found.name, oid }
      : { file: found.name, oid, subSessionId: owner }
  }
  return undefined
}

function pinReply(session: PinSession, sessionId: string, reply: ArtifactReply): Promise<void> {
  const key = `${sessionId}#${reply.entryId}`
  if (handled.has(key)) return Promise.resolve()
  const running = inflight.get(key)
  if (running) return running
  const task = (async () => {
    // 两种读法都收：过程区按块各自渲染，终答把几个 text 块拼起来渲染（AssistantBubble）
    const names = [
      ...reply.texts.flatMap((text) => artifactFenceNames(text)),
      ...artifactFenceNames(reply.texts.join(''))
    ]
    if (names.length === 0) return
    if (await hasArtifactPins(session.harness, reply.conversationId, reply.entryId)) return
    const pins: Record<string, ArtifactPin> = {}
    for (const name of new Set(names)) {
      const pin = await pinOne(sessionId, name)
      if (pin) pins[name] = pin
    }
    if (Object.keys(pins).length === 0) return
    const wrote = await writeArtifactPins(
      session.harness,
      reply.conversationId,
      reply.entryId,
      pins
    )
    // 渲染端在回复落定时可能已经按「没钉」取过一次：告诉它再取（面板也跟着重拉一次，无妨）
    if (wrote) appEventBus.publish({ type: 'artifacts.changed', sessionIds: [sessionId] })
  })()
    .then(() => {
      if (handled.size >= HANDLED_MAX) handled.clear()
      handled.add(key)
    })
    .catch((err: unknown) => {
      log.warn(`pinning artifact refs failed for ${key}: ${(err as Error).message}`)
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/**
 * 工具执行之前（权限门之前 —— 被拒、被问的调用也算：回复已经写完了）：钉住发起这次调用的那条回复里的引用。
 * 认不出发起者（不是最新的那条回复）就不钉。只钉会话**当前对话**里的回复：派生 agent 的对话里的回复，
 * 界面不按消息 id 来读，钉了也没人看。不抛：钉是旁路，失败只记日志。
 */
export async function pinCallingReply(
  session: PinSession | undefined,
  sessionId: string,
  call: { conversationId: ConversationId; callId: string }
): Promise<void> {
  if (!session) return
  try {
    // 每次工具调用都走这里：本会话与子会话都还没有产物目录，就没有什么可钉的，不去读转写
    if (!hasAnyArtifacts(sessionId)) return
    if ((await session.currentConversation()).id !== call.conversationId) return
    const reply = await findCallingReply(session.harness, call.conversationId, call.callId)
    if (reply) await pinReply(session, sessionId, reply)
  } catch (err) {
    log.warn(`finding the calling reply failed for ${sessionId}: ${(err as Error).message}`)
  }
}

/** 一轮结束时：钉住这一轮的终答里的引用（当前对话最新的助手条目不带工具调用才算，见 findFinalReply） */
export async function pinFinalReply(
  session: PinSession | undefined,
  sessionId: string
): Promise<void> {
  if (!session) return
  try {
    if (!hasAnyArtifacts(sessionId)) return
    const conversation = await session.currentConversation()
    const reply = await findFinalReply(session.harness, conversation.id)
    if (reply) await pinReply(session, sessionId, reply)
  } catch (err) {
    log.warn(`finding the final reply failed for ${sessionId}: ${(err as Error).message}`)
  }
}

/** 当前内容（没有钉、或钉下的那一份取不回来时；面板的预览也走这里） */
export function readCurrentArtifact(sessionId: string, name: string): ArtifactReadResult | null {
  for (const owner of artifactOwners(sessionId)) {
    const found = findArtifact(owner, name)
    if (!found) continue
    const content = readText(found.path)
    if (content !== null) {
      return {
        sessionId: owner,
        name: found.name,
        title: found.title,
        content,
        pinned: false,
        latest: true
      }
    }
  }
  return null
}

/**
 * 引用围栏要显示的那一份：`messageId`（回复的条目 id，十进制数字串）给了、会话在、这条回复钉过这个名字、
 * 那一份取得回来 → 钉下的那一版；否则当前内容。都没有 → null（渲染端显示「找不到」）。
 *
 * `latest`：文件此刻的内容还是钉下的那一份。文件已经不在了（删了、改了名）也算 true —— 没有更新的版本可看，
 * 标「已有新版」只会让人点进一个空处。
 */
export async function readArtifactForRef(
  session: PinSession | undefined,
  sessionId: string,
  name: string,
  messageId?: string
): Promise<ArtifactReadResult | null> {
  if (session && messageId !== undefined && /^\d+$/.test(messageId)) {
    try {
      const conversation = await session.currentConversation()
      const entryId = Number(messageId)
      const pin = (await readArtifactPins(session.harness, conversation.id, entryId))?.[name.trim()]
      if (pin) {
        const owner = pin.subSessionId ?? sessionId
        const content = await readArtifactBlob(owner, pin.oid)
        if (content !== null) {
          const current = findArtifact(owner, pin.file)
          const now = current ? readText(current.path) : null
          return {
            sessionId: owner,
            name: pin.file,
            title: titleOf(content, pin.file),
            content,
            pinned: true,
            latest: now === null || (await hashBlobText(now)) === pin.oid
          }
        }
      }
    } catch (err) {
      log.warn(`reading the pinned version failed for ${sessionId}: ${(err as Error).message}`)
    }
  }
  return readCurrentArtifact(sessionId, name)
}
