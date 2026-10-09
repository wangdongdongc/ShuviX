/**
 * agent 记录（P2-01）：派生 agent 记录的解析 / 序列化（与锁记录共用一个校验器）、平铺在子对话
 * `AgentStateDoc` 里的字段（PIN-01：平铺、写入器只合并不删人设、不升版本）。
 *
 * A 段是纯函数；B 段跑在真 Harness 上（持久化用 SQLite 重启）。
 *
 *   REC-1 派发它的 tool_call id（`ownerCallId`）随记录往返：JSON 里有这个键、解析回来与原值相同；旧记录没有它照样解析
 *   REC-2 ownerCallId 给了就得是非空串：数字 / null / 布尔 / 对象 / 数组 / 空串都让整条记录作废
 *   REC-3 ownerCallId 是记录自己的键：随种子写进文档、重写换成新值、重写时缺省就从文档删掉；人设那几项不动
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import * as runtime from '../../index'
import {
  parseSpawnedAgentRecord,
  spawnedAgentRecordJson,
  spawnedAgentRecordOf,
  writeSpawnedAgentRecord,
  type SpawnedAgentRecord
} from '../agentRecord'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, noticeEntryDraft } from '../docs'
import { lockRecordJson, parseLockRecord, type LockRecord } from '../lock'
import { DECL_RESOLVE } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { makeHost, registerHostCleanup } from './support/host'
import { agentState, lockW, scenarioW, wKit } from './support/scenario'
import { hookRec, rec, seedAgent, TEST_SPAWN_EXTENSION, TITLE_SCHEMA } from './support/spawn'
import { allEntries } from './support/transcript'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

/** 一条完整的记录：思考档位、hook 字段（契约带 nudges）、MCP 声明、技能 */
function fullRecord(): SpawnedAgentRecord {
  return hookRec({
    thinkingLevel: 'medium',
    resultContract: { schema: structuredClone(TITLE_SCHEMA), nudges: 2, sourceLabel: 'auto-title' },
    mcp: { ctx: [structuredClone(DECL_RESOLVE)] },
    skills: ['pdf']
  })
}

/** 表格行的标签：缺省 = missing；数字原样（NaN / Infinity 不是 JSON） */
function label(value: unknown): string {
  if (value === undefined) return 'missing'
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/** 一条有效记录的 JSON，把某个字段换成 `value`（原样放进去，NaN 也一样；`undefined` = 删掉这个键） */
function withField(key: string, value: unknown, base: SpawnedAgentRecord = rec()): unknown {
  const raw = JSON.parse(JSON.stringify(spawnedAgentRecordJson(base))) as Record<string, unknown>
  if (value === undefined) delete raw[key]
  else raw[key] = value
  return raw
}

/** 锁字段那一段（派生记录里的锁记录投影） */
function lockProjection(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'conversationId',
    'profileName',
    'kind',
    'model',
    'thinkingLevel',
    'toolNames',
    'extensions',
    'sandboxed',
    'mcp',
    'skills',
    'createdAt'
  ]
  return Object.fromEntries(keys.filter((key) => key in raw).map((key) => [key, raw[key]]))
}

describe('agent records · parse / serialise', () => {
  it('P2-01-01 a full record round-trips; its JSON is plain JSON', () => {
    const r = fullRecord()
    const json = spawnedAgentRecordJson(r)
    expect(parseSpawnedAgentRecord(json)).toEqual(r)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })

  it('P2-01-02 a minimal record round-trips; absent optional fields leave no keys behind', () => {
    const minimal = rec()
    const json = spawnedAgentRecordJson(minimal)
    expect(parseSpawnedAgentRecord(json)).toEqual(minimal)
    // rec() 是早于 ownerCallId 的 tool 记录：没有这个键照样解析（REC-1），也不凭空长出来
    for (const key of ['thinkingLevel', 'ownerCallId', 'hook', 'resultContract'])
      expect(json).not.toHaveProperty(key)

    const schemaOnly = rec({ resultContract: { schema: structuredClone(TITLE_SCHEMA) } })
    const contractJson = spawnedAgentRecordJson(schemaOnly)
    const parsed = parseSpawnedAgentRecord(contractJson)
    expect(parsed).toEqual(schemaOnly)
    expect(contractJson.resultContract).not.toHaveProperty('nudges')
    expect(contractJson.resultContract).not.toHaveProperty('sourceLabel')
    expect(parsed!.resultContract).not.toHaveProperty('nudges')
    expect(parsed!.resultContract).not.toHaveProperty('sourceLabel')
  })

  it('REC-1 a tool record carrying its dispatch call id round-trips; the key is in the JSON', () => {
    const withCall = rec({ ownerCallId: 'call-x' })
    const json = spawnedAgentRecordJson(withCall)
    expect(json.ownerCallId).toBe('call-x')
    expect(parseSpawnedAgentRecord(json)).toEqual(withCall)
    expect(parseSpawnedAgentRecord(JSON.parse(JSON.stringify(json)))).toEqual(withCall)
  })

  it('P2-01-03 parsing copies: neither the raw value nor the result sees the other change', () => {
    const r = fullRecord()
    const raw = JSON.parse(JSON.stringify(spawnedAgentRecordJson(r))) as {
      toolNames: string[]
      mcp: { ctx: { name: string }[] }
      resultContract: { schema: { properties: Record<string, unknown> } }
    }
    const parsed = parseSpawnedAgentRecord(raw)!
    raw.toolNames.push('mutated')
    raw.mcp.ctx[0]!.name = 'mutated'
    raw.resultContract.schema.properties.extra = { type: 'number' }
    expect(parsed).toEqual(r)

    parsed.toolNames.push('changed')
    parsed.mcp.ctx![0]!.name = 'changed'
    ;(parsed.resultContract!.schema.properties as Record<string, unknown>).other = {}
    expect(raw.toolNames).toEqual([...r.toolNames, 'mutated'])
    expect(raw.mcp.ctx[0]!.name).toBe('mutated')
    expect(raw.resultContract.schema.properties).not.toHaveProperty('other')
  })

  it('P2-01-04 kind: root or missing is not a spawned record; the lock parser still reads the shared base', () => {
    expect(parseSpawnedAgentRecord(withField('kind', 'root'))).toBeUndefined()
    expect(parseSpawnedAgentRecord(withField('kind', undefined))).toBeUndefined()

    const r = fullRecord()
    const asLock = parseLockRecord(spawnedAgentRecordJson(r))
    expect(asLock).toEqual(lockProjection(r as unknown as Record<string, unknown>))
    expect(asLock?.kind).toBe('spawned')
    expect(asLock).not.toHaveProperty('agentId')
    expect(asLock).not.toHaveProperty('resultContract')
  })

  const spawnRows: [string, unknown][] = [
    ['agentId', undefined],
    ['agentId', 42],
    ['agentId', ''],
    ['depth', undefined],
    ['depth', '1'],
    ['depth', 1.5],
    ['depth', -1],
    ['depth', 0],
    ['depth', Number.NaN],
    ['depth', Number.POSITIVE_INFINITY],
    ['canSpawn', undefined],
    ['canSpawn', 'true'],
    ['dispatch', undefined],
    ['dispatch', 'agent'],
    ['dispatch', 'Tool'],
    ...(['parentConversationId', 'ownerTaskId'] as const).flatMap((key): [string, unknown][] => [
      [key, undefined],
      [key, 0],
      [key, -3],
      [key, 2.5],
      [key, '1']
    ]),
    ['displayName', undefined],
    ['displayName', 3],
    ['description', undefined],
    ['description', null],
    ['hook', 5],
    ['hook', null],
    // REC-2：派发它的 tool_call id 给了就得是非空串
    ['ownerCallId', 42],
    ['ownerCallId', null],
    ['ownerCallId', true],
    ['ownerCallId', {}],
    ['ownerCallId', ['call-x']],
    ['ownerCallId', ''],
    ['resultContract', 'x'],
    ['resultContract', []],
    ['resultContract', null],
    ['resultContract', {}],
    ['resultContract', { schema: 'x' }],
    ['resultContract', { schema: [] }],
    ['resultContract', { schema: {}, nudges: -1 }],
    ['resultContract', { schema: {}, nudges: 1.5 }],
    ['resultContract', { schema: {}, nudges: '1' }],
    ['resultContract', { schema: {}, sourceLabel: 3 }]
  ]

  it.each(spawnRows.map(([key, value]) => [key, label(value), value]))(
    'P2-01-05 spawn field %s = %s is rejected',
    (key, _label, value) => {
      expect(parseSpawnedAgentRecord(withField(key as string, value))).toBeUndefined()
    }
  )

  const lockRows: [string, unknown][] = [
    ['conversationId', 0],
    ['conversationId', 1.5],
    ['conversationId', '1'],
    ['model', { provider: 'faux' }],
    ['toolNames', [1]],
    ['extensions', 'x'],
    ['skills', undefined],
    ['sandboxed', 'yes'],
    ['createdAt', Number.NaN],
    ['createdAt', Number.POSITIVE_INFINITY],
    ['mcp', { ctx: 'x' }],
    ['mcp', { ctx: [{}] }],
    ['thinkingLevel', 3]
  ]

  it.each(lockRows.map(([key, value]) => [key, label(value), value]))(
    'P2-01-06 shared lock field %s = %s is rejected by both parsers',
    (key, _label, value) => {
      const raw = withField(key as string, value) as Record<string, unknown>
      expect(parseSpawnedAgentRecord(raw)).toBeUndefined()
      expect(parseLockRecord(lockProjection(raw))).toBeUndefined()
    }
  )

  it('P2-01-07 unknown keys (persona and friends) are dropped', () => {
    const r = rec()
    const raw = {
      ...spawnedAgentRecordJson(r),
      persona: 'You are Explorer',
      instructionFiles: ['AGENTS.md'],
      rootSessionId: 's1',
      lastAnnouncedDate: '2026-10-04',
      foo: 'bar'
    }
    const parsed = parseSpawnedAgentRecord(raw)
    expect(parsed).toEqual(r)
    for (const key of [
      'persona',
      'instructionFiles',
      'rootSessionId',
      'lastAnnouncedDate',
      'foo'
    ]) {
      expect(parsed).not.toHaveProperty(key)
    }
  })

  it('P2-01-08 serialising is strict: a bigint in the contract schema or an MCP declaration throws', () => {
    const inSchema = rec({ resultContract: { schema: { type: 'object', max: 10n } } })
    expect(() => spawnedAgentRecordJson(inSchema)).toThrow()
    const inMcp = rec({
      mcp: { ctx: [{ ...DECL_RESOLVE, inputSchema: { type: 'object', big: 1n } } as never] }
    })
    expect(() => spawnedAgentRecordJson(inMcp)).toThrow()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a number', 5]
  ])('P2-01-09 %s is not a record', (_name, raw) => {
    expect(parseSpawnedAgentRecord(raw)).toBeUndefined()
  })

  it('P2-01-10 the lock record parser is unchanged after the extraction and still exported from lock and the package index', () => {
    expect(parseLockRecord(lockRecordJson(lockW()))).toEqual(lockW())
    expect(parseLockRecord({ ...lockRecordJson(lockW()), kind: 'other' })).toBeUndefined()
    expect(runtime.parseLockRecord).toBe(parseLockRecord)
    expect(runtime.lockRecordJson).toBe(lockRecordJson)
    expect(runtime.parseSpawnedAgentRecord).toBe(parseSpawnedAgentRecord)
    expect(runtime.spawnedAgentRecordJson).toBe(spawnedAgentRecordJson)
    const typed: LockRecord = lockW()
    expect(typed.kind).toBe('root')
  })
})

describe('agent records · AgentStateDoc fields', () => {
  it('P2-01-11 the AgentStateDoc definition is unchanged (no version bump, PIN-01)', () => {
    const { kind, version, scope, history, fork } = AgentStateDoc.definition as unknown as Record<
      string,
      unknown
    >
    expect({ kind, version, scope, history, fork }).toEqual({
      kind: 'shuvix.agent-state',
      version: 1,
      scope: 'conversation',
      history: 'rewindable',
      fork: 'asOf'
    })
  })

  it('P2-01-12 one creation commit: the record and the frozen persona coexist; kind and profileName are shared', async () => {
    const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    const recorder = recordPublications(session.harness)
    const seeded = await seedAgent(session, { record: hookRec() })
    recorder.stop()
    const child = seeded.conversationId
    const touching = recorder.touching(`shuvix.agent-state#${child}`)
    expect(touching).toHaveLength(1)
    expect(touching[0]!.docs).toEqual(expect.arrayContaining([`pi.agent#${child}`]))

    const state = (await agentState(session, child)) as Record<string, unknown>
    expect(parseSpawnedAgentRecord(state)).toEqual(seeded.record)
    expect(await spawnedAgentRecordOf(session.harness, child, BG)).toEqual(seeded.record)
    expect(state).toMatchObject({
      kind: 'spawned',
      profileName: 'titler',
      persona: 'You are Auto title',
      instructionFiles: [],
      rootSessionId: 's1'
    })
    // 根的文档没被碰
    expect(await agentState(session, ROOT_CONVERSATION_ID)).toEqual({})
  })

  it(
    'P2-01-13 the record persists across a restart; the root agent state is unchanged',
    async () => {
      const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
      const session = await t.open()
      await session.createAgent()
      const rootBefore = await agentState(session, ROOT_CONVERSATION_ID)
      const seeded = await seedAgent(session)
      const next = await t.restart()
      const reopened = await next.open()
      expect(await spawnedAgentRecordOf(reopened.harness, seeded.conversationId, BG)).toEqual(
        seeded.record
      )
      expect(await agentState(reopened, ROOT_CONVERSATION_ID)).toEqual(rootBefore)
    },
    RESTART_TIMEOUT
  )

  it('P2-01-14 later writes keep the record; rewriting the record never deletes the persona keys', async () => {
    const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    const seeded = await seedAgent(session, { record: hookRec() })
    const child = seeded.conversationId
    await session.harness.commit(async (tx) => {
      const state = await tx.doc(AgentStateDoc, child)
      state.lastAnnouncedDate = '2026-10-04'
      state.persona = 'You are edited'
    }, BG)
    expect(await spawnedAgentRecordOf(session.harness, child, BG)).toEqual(seeded.record)

    // 重写：换显示名、去掉 hook / 结果契约（可选键缺省 = 从文档删掉），人设那几项原样
    const rewritten: SpawnedAgentRecord = {
      ...seeded.record,
      displayName: 'Renamed',
      dispatch: 'tool'
    }
    delete rewritten.hook
    delete rewritten.resultContract
    await session.harness.commit((tx) => writeSpawnedAgentRecord(tx, child, rewritten), BG)
    const state = (await agentState(session, child)) as Record<string, unknown>
    expect(parseSpawnedAgentRecord(state)).toEqual(rewritten)
    expect(state).not.toHaveProperty('hook')
    expect(state).not.toHaveProperty('resultContract')
    expect(state).toMatchObject({
      persona: 'You are edited',
      instructionFiles: [],
      rootSessionId: 's1',
      lastAnnouncedDate: '2026-10-04'
    })
  })

  it('REC-3 ownerCallId is one of the record keys: seeded into the doc, replaced by a rewrite, deleted by a rewrite without it; persona keys untouched', async () => {
    const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    const seeded = await seedAgent(session, { record: rec({ ownerCallId: 'call-x' }) })
    const child = seeded.conversationId
    const persona = {
      persona: 'You are Explorer',
      instructionFiles: [],
      rootSessionId: 's1'
    }
    let state = (await agentState(session, child)) as Record<string, unknown>
    expect(state.ownerCallId).toBe('call-x')
    expect(state).toMatchObject(persona)
    expect(await spawnedAgentRecordOf(session.harness, child, BG)).toEqual(seeded.record)

    // 重写换一个 call id：文档里是新值
    const moved: SpawnedAgentRecord = { ...seeded.record, ownerCallId: 'call-y' }
    await session.harness.commit((tx) => writeSpawnedAgentRecord(tx, child, moved), BG)
    state = (await agentState(session, child)) as Record<string, unknown>
    expect(state.ownerCallId).toBe('call-y')
    expect(await spawnedAgentRecordOf(session.harness, child, BG)).toEqual(moved)

    // 重写时缺省 = 从文档删掉（不留一个过期的 call id）；人设那几项原样
    const without: SpawnedAgentRecord = { ...seeded.record }
    delete without.ownerCallId
    await session.harness.commit((tx) => writeSpawnedAgentRecord(tx, child, without), BG)
    state = (await agentState(session, child)) as Record<string, unknown>
    expect(state).not.toHaveProperty('ownerCallId')
    expect(parseSpawnedAgentRecord(state)).toEqual(without)
    expect(await spawnedAgentRecordOf(session.harness, child, BG)).toEqual(without)
    expect(state).toMatchObject(persona)
  })

  it('P2-01-15 nothing leaks into the root: the root agent state is exactly LC-08 and no fresh conversation parses as spawned', async () => {
    const { t, vars } = await scenarioW()
    vars.state.marker = 'Aria'
    const session = await t.open()
    await session.createAgent()
    const rootState = await agentState(session)
    expect(rootState).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 's1',
      persona: 'You are Aria',
      instructionFiles: ['AGENTS.md']
    })
    expect(parseSpawnedAgentRecord(rootState)).toBeUndefined()
    const fresh = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    expect(await agentState(session, fresh.id)).toEqual({})
    expect(parseSpawnedAgentRecord(await agentState(session, fresh.id))).toBeUndefined()
  })

  it('P2-01-16 a fork of a spawned conversation carries the record as of the fork point (R9, doc semantics only)', async () => {
    const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    const seeded = await seedAgent(session)
    const child = (await session.harness.conversation(seeded.conversationId, BG))!
    const written = await child.submit(
      { type: 'write', entry: noticeEntryDraft({ text: 'mark', kind: 'background' }, 0) },
      BG
    )
    await written.wait(BG)
    const entry = (await allEntries(child)).find((e) => e.kind === 'shuvix.notice')!
    // fork 之后再改子对话的记录：fork 拿到的是 fork 点时的那份
    await session.harness.commit(
      (tx) =>
        writeSpawnedAgentRecord(tx, child.id, { ...seeded.record, displayName: 'Changed later' }),
      BG
    )
    const fork = await child.fork(entry.id, { ownership: { kind: 'ownerless' } }, BG)
    expect(await spawnedAgentRecordOf(session.harness, fork.id, BG)).toEqual(seeded.record)
    expect((await spawnedAgentRecordOf(session.harness, child.id, BG))?.displayName).toBe(
      'Changed later'
    )
  })
})
