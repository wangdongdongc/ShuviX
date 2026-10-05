/**
 * 宿主派发 · 锚扩展（P2-08 A 段，01–04）：`shuvix.spawn` 带着 `shuvix.spawn.anchor` v1 装进每条会话的注册表
 * （打开那一刻、调度器还停着；重启之后照样）；它不进任何对话的 agent 扩展清单。锚本身：后台、对话拥有、一跑
 * 就以 completed / null 收场（不发请求、不写转写），中止 → aborted；名下的 titler 在跑时它以 completing 陪着，
 * titler 收场它就终结；崩溃之后重开不报「不认识的任务」，下一次开启调度器时连同被打了标记的 titler 一起收场。
 */
import {
  AgentDoc,
  ROOT_CONVERSATION_ID,
  type RegistrySnapshot,
  type TaskId
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { SHUVIX_SPAWN_EXTENSION, SPAWN_ANCHOR_TASK, SpawnAnchor } from '../anchor'
import { backgroundContext as BG } from '../context'
import { answer, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  anchors,
  hookRig,
  promptPayload,
  queueRoles,
  requestsOfRole,
  reviewerOf,
  TITLE_FENCE
} from './support/hookRig'
import { liveTasks, mentions, taskRecord, tasksOf } from './support/spawn'
import { transcript } from './support/transcript'
import { waitFor } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID

function anchorTaskOf(snapshot: RegistrySnapshot): {
  extension: boolean
  task: { name: string; version: number } | undefined
} {
  const extension = snapshot.extension(SHUVIX_SPAWN_EXTENSION)
  const task = extension?.tasks?.find((t) => t.definition.name === SPAWN_ANCHOR_TASK)?.definition
  return {
    extension: extension !== undefined,
    task: task && { name: task.name, version: task.version }
  }
}

describe('P2-08 A · the anchor extension', () => {
  it(
    'P2-08-01 installed in every per-session registry at open (locked, never locked, ephemeral), before and after a restart; never in a root AgentDoc',
    async () => {
      const rig = await hookRig({ host: { ephemeral: ['s3'] } })
      const check = async (t: typeof rig.t, sessionId: string): Promise<void> => {
        const registry = t.registryOf(sessionId)!
        const session = t.host.get(sessionId)!
        // 打开刚完成、调度器还停着
        expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
        expect(anchorTaskOf(registry.snapshot())).toEqual({
          extension: true,
          task: { name: SPAWN_ANCHOR_TASK, version: 1 }
        })
        const doc = await session.harness.snapshot(AgentDoc, ROOT, BG)
        const extensions = doc?.extensions
        if (Array.isArray(extensions)) expect(extensions).not.toContain(SHUVIX_SPAWN_EXTENSION)
        // LC-08：锁记录的扩展清单原样就是根对话的扩展清单（锚扩展不在其中）
        if (session.lock !== undefined) {
          expect(extensions).toEqual(session.lock.extensions)
          expect(session.lock.extensions).not.toContain(SHUVIX_SPAWN_EXTENSION)
        }
      }
      // s1 已锁（hookRig 建了 agent）；s2 从没锁过；s3 是临时会话
      await rig.open('s2', false)
      await rig.open('s3', false)
      for (const id of ['s1', 's2', 's3']) await check(rig.t, id)
      expect(rig.t.host.get('s2')!.lock).toBeUndefined()
      const next = await rig.reopen()
      await next.open('s2', false)
      for (const id of ['s1', 's2']) await check(next.t, id)
      expect(next.t.warnings.filter((w) => /unknown task|not registered/i.test(w))).toEqual([])
    },
    RESTART_TIMEOUT
  )

  it('P2-08-02 an anchor alone: completed with result null, no request, root transcript unchanged; abortTask on a fresh pending anchor → aborted', async () => {
    const rig = await hookRig()
    const session = rig.session
    const root = (await session.harness.conversation(ROOT, BG))!
    const before = await transcript(root)
    const anchor = await session.harness.commit(
      (tx) =>
        tx.createTask(SpawnAnchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: ROOT,
          background: true
        }),
      BG
    )
    await session.harness.waitForTask(anchor, BG)
    const record = await taskRecord(session, anchor as TaskId)
    expect(record?.state).toEqual({
      status: 'terminal',
      outcome: { status: 'completed', result: null }
    })
    expect(record?.background).toBe(true)
    expect(rig.kit.callCount).toBe(0)
    expect(await transcript(root)).toEqual(before)

    const fresh = await session.harness.commit(
      (tx) =>
        tx.createTask(SpawnAnchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: ROOT,
          background: true
        }),
      BG
    )
    await session.harness.abortTask(fresh, BG)
    await session.harness.waitForTask(fresh, BG)
    expect((await taskRecord(session, fresh as TaskId))?.state).toEqual({
      status: 'terminal',
      outcome: { status: 'aborted' }
    })
  })

  it('P2-08-03 the anchor holds (completing) while its titler runs, then completes; nothing stays live in the root', async () => {
    const rig = await hookRig()
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [h.step] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await h.reached
    const [anchor] = await anchors(rig.session)
    expect(anchor?.state.status).toBe('completing')
    expect(anchor?.background).toBe(true)
    expect(anchor?.conversationId).toBe(ROOT)
    h.release()
    await waitFor(() => rig.ends().length === 1)
    await waitFor(async () => (await anchors(rig.session))[0]!.state.status === 'terminal')
    expect((await anchors(rig.session))[0]!.state).toEqual({
      status: 'terminal',
      outcome: { status: 'completed', result: null }
    })
    expect(await liveTasks(rig.session, ROOT)).toEqual([])
  })

  it(
    'P2-08-04 the anchor resolves after a crash: no unknown-task warnings at open; the next root send ends the titler and its anchor; no request carries the titler text',
    async () => {
      const rig = await hookRig()
      const stall = stalled()
      queueRoles(rig.kit, { titler: [stall.step] })
      rig.runner.fire('session.prompt-accepted', promptPayload())
      await stall.reached
      const [anchor] = await anchors(rig.session)
      const [T] = await reviewerOf(rig.session, anchor!.id)
      const next = await rig.reopen()
      expect(next.t.warnings).toEqual([])
      queueRoles(next.kit, { root: [answer('hello back')] })
      expect(await next.session.submitUser('hi')).toEqual({})
      await waitFor(async () => (await liveTasks(next.session)).length === 0)
      expect((await taskRecord(next.session, anchor!.id as TaskId))?.state.status).toBe('terminal')
      const generations = await tasksOf(next.session, T!)
      expect(generations.map((task) => task.state)).toEqual([
        { status: 'terminal', outcome: { status: 'aborted' } }
      ])
      expect(requestsOfRole(next.kit, 'titler')).toEqual([])
      expect(mentions(next.kit, TITLE_FENCE)).toBe(false)
      expect(next.kit.requests).toHaveLength(1)
    },
    RESTART_TIMEOUT
  )
})
