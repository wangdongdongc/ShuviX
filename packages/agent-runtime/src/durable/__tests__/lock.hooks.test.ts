/**
 * 锁 · 内置扩展带的 generation hook（空回复追问，`emptyReply.ts`）：`shuvix.builtin` 在锁里有三处装法 ——
 * 创建（`create`）、打开时按锁恢复（`restore`：同进程 LRU 重开，或换进程后有可续的工作）、派生 agent 要用时
 * 惰性装（`ensureBuiltin`）。三处装上的都恰好带一条 `pi.generation` 的 onYield hook，所以根对话与派生
 * agent 都会被追问。惰性那一处没有锁可读，请求里不带技能货架（LH-05 / WT4-DL-03）。
 *
 * hook 本身的逻辑在 emptyReply.test.ts；装上之后真的生效在 integration/emptyReply.test.ts 与
 * spawn.emptyReply.test.ts。
 */
import type { HookRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import type { DurableSession } from '../durableSession'
import { SHUVIX_BUILTIN_EXTENSION } from '../lock'
import { testProfile } from './support/agentConfig'
import { answer, stalled } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { scenarioW, wKit } from './support/scenario'
import { callAgent, configD, dispatch, TEST_SPAWN_EXTENSION } from './support/spawn'
import { withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000

/** 某会话当前注册表里 `shuvix.builtin` 带的 hook（没装 → undefined） */
function builtinHooks(t: TestHost, sessionId = 's1'): readonly HookRegistration[] | undefined {
  const extension = t.registryOf(sessionId)?.snapshot().extension(SHUVIX_BUILTIN_EXTENSION)
  return extension === undefined ? undefined : (extension.hooks ?? [])
}

/** 恰好一条 hook：登记在 pi.generation 上、只有 onYield */
function expectOneGenerationHook(hooks: readonly HookRegistration[] | undefined): void {
  expect(hooks).toBeDefined()
  expect(hooks).toHaveLength(1)
  expect(hooks![0]!.task).toBe('pi.generation')
  expect(Object.keys(hooks![0]!.handlers)).toEqual(['onYield'])
}

describe('lock · the builtin extension carries the empty-reply hook', () => {
  it(
    'LH-01 create: the shuvix.builtin installed when the agent is created holds exactly one pi.generation hook',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      expect(builtinHooks(t)).toBeUndefined()
      await session.createAgent()
      expectOneGenerationHook(builtinHooks(t))
    },
    TIMEOUT
  )

  it(
    'LH-02 restore after an LRU close / reopen in the same process: the reinstalled shuvix.builtin holds exactly one pi.generation hook',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const before = t.registriesOf('s1').length
      await t.host.close('s1')

      const reopened = await t.open()
      expect(reopened.lock).toBeDefined()
      expect(t.registriesOf('s1')).toHaveLength(before + 1)
      expectOneGenerationHook(builtinHooks(t))
    },
    TIMEOUT
  )

  it(
    'LH-03 restore after a restart with work to resume (full initialization): shuvix.builtin holds exactly one pi.generation hook',
    async () => {
      const { t } = await scenarioW()
      const session = await t.open()
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('stalled')
      await stall.reached
      const t2 = await t.restart()

      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.lock).toBeDefined()
      expectOneGenerationHook(builtinHooks(t2))
    },
    TIMEOUT
  )

  it(
    'LH-04 ensureBuiltin (lazy): a spawned child continued from the panel on a cleared-lock session installs shuvix.builtin with exactly one pi.generation hook',
    async () => {
      const outcomes: unknown[] = []
      let current: DurableSession | undefined
      const reader = testProfile({ name: 'reader', displayName: 'Reader', tools: ['read'] })
      const dispatchTool = dispatch({
        getSession: () => current!,
        profiles: { reader },
        outcomes: outcomes as never
      })
      const t = await makeHost({
        makeKit: wKit,
        extensions: [TEST_SPAWN_EXTENSION],
        toolHost: { scenario: 'w', dispatchTool },
        agentConfig: configD({
          profile: testProfile({ name: 'work', displayName: 'Work', tools: ['agent', 'read'] })
        })
      })
      current = await t.open()
      t.kit.queue(callAgent('reader', 'look around'), answer('child done'), answer('root done'))
      expect(await current.submitUser('go')).toEqual({})
      const [record] = current.spawnedRecords()

      const t2 = await t.restart()
      current = await t2.open()
      expect(current.lock).toBeUndefined()
      expect(builtinHooks(t2)).toBeUndefined()

      t2.kit.queue(answer('more from the child'))
      const outcome = await withTimeout(
        current.agents.continue(record!.conversationId, 'more'),
        5000,
        'panel continue'
      )
      expect(outcome.error).toBeUndefined()
      expect(current.lock).toBeUndefined()
      expect(t2.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: undefined }])
      expectOneGenerationHook(builtinHooks(t2))
    },
    TIMEOUT
  )

  it(
    'LH-05 (WT4-DL-03) ensureBuiltin with no lock asks for the builtins with no `skills` key (no agent yet); creating the root agent afterwards builds them again with the resolved shelf',
    async () => {
      const outcomes: unknown[] = []
      let current: DurableSession | undefined
      const reader = testProfile({ name: 'reader', displayName: 'Reader', tools: ['read'] })
      const dispatchTool = dispatch({
        getSession: () => current!,
        profiles: { reader },
        outcomes: outcomes as never
      })
      const t = await makeHost({
        makeKit: wKit,
        extensions: [TEST_SPAWN_EXTENSION],
        toolHost: { scenario: 'w', dispatchTool, skills: ['pdf'] },
        agentConfig: configD({
          profile: testProfile({
            name: 'work',
            displayName: 'Work',
            tools: ['agent', 'read', 'skill']
          })
        })
      })
      current = await t.open()
      t.kit.queue(callAgent('reader', 'look around'), answer('child done'), answer('root done'))
      expect(await current.submitUser('go')).toEqual({})
      const [record] = current.spawnedRecords()

      const t2 = await t.restart()
      current = await t2.open()
      expect(current.lock).toBeUndefined()

      t2.kit.queue(answer('more from the child'))
      const outcome = await withTimeout(
        current.agents.continue(record!.conversationId, 'more'),
        5000,
        'panel continue'
      )
      expect(outcome.error).toBeUndefined()
      expect(t2.toolHost.builtinCalls).toHaveLength(1)
      expect(t2.toolHost.builtinCalls[0]).toStrictEqual({ sessionId: 's1', sandboxed: undefined })

      await current.createAgent()
      expect(current.lock!.skills).toEqual(['pdf'])
      expect(t2.toolHost.builtinCalls).toHaveLength(2)
      expect(t2.toolHost.builtinCalls[1]).toStrictEqual({
        sessionId: 's1',
        sandboxed: false,
        skills: ['pdf']
      })
      expectOneGenerationHook(builtinHooks(t2))
    },
    TIMEOUT
  )
})
