/**
 * mdMetaService —— 属性卡「ShuviX 设置」条的主进程入口（IPC `mdMeta:*`，契约见 chat-protocol mdMeta.ts）。
 *
 * 规则全在主进程判，这里逐条钉：
 *   - **按笔记本会话认文件**（registryNoteFileOf，替身）：不是注册表笔记 → noteView null / 写入 not-registry-note；
 *   - **id 读自磁盘**：noteView 报磁盘上的 id 与状态（没写 none / 写错 malformed / ok）；写入时渲染进程给的 id
 *     必须与磁盘上的相同（归一后比），否则 no-object-id —— 插 id 的那次保存还没落盘时就是这样；
 *   - **只补白名单**（MD_FM_FILL_KEYS：agent 的模型与档位；bot / hook / policy 一个都没有）→ key-not-allowed；
 *   - **值交解析器校验**，存归一后的值（去首尾空白、档位小写）；空 / 非 JSON / 解析器不收 → invalid-value，什么都不写；
 *   - 写成功广播这类文件的 `*.changed` 恰一次；删一个本来就没有的键算成功但不广播；
 *   - 校验顺序：先认会话、再认键、最后认 id。
 *
 * 文件是真的（临时目录）；数据库换成内存表（mdAttrDao 替身，store 用真的）；appEventBus.publish 被 spy。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MD_FM_FILL_KEYS } from '@shuvix/chat-protocol/mdMeta'
import { SELECTABLE_THINKING_LEVELS } from '@shuvix/chat-protocol/types/thinking'
import type { MdAttr } from '../../dao/types'
import type { RegistryNoteFile } from '../registryNotes'

/** 内存里的 md_attrs（四段主键 objectId + scope + ns + key） */
const db = vi.hoisted(() => ({ rows: [] as MdAttr[] }))

vi.mock('../../dao/mdAttrDao', () => ({
  mdAttrDao: {
    findAll: vi.fn(() => db.rows.map((r) => ({ ...r }))),
    upsert: vi.fn(
      (attr: {
        objectId: string
        scope?: string
        ns: 'fm' | 'meta'
        key: string
        value: unknown
      }) => {
        const scope = attr.scope ?? ''
        db.rows = db.rows.filter(
          (r) =>
            !(
              r.objectId === attr.objectId &&
              r.scope === scope &&
              r.ns === attr.ns &&
              r.key === attr.key
            )
        )
        db.rows.push({
          objectId: attr.objectId,
          scope,
          ns: attr.ns,
          key: attr.key,
          value: attr.value,
          updatedAt: 1
        })
      }
    ),
    delete: vi.fn((key: { objectId: string; scope?: string; ns: string; key: string }) => {
      const scope = key.scope ?? ''
      const before = db.rows.length
      db.rows = db.rows.filter(
        (r) =>
          !(
            r.objectId === key.objectId &&
            r.scope === scope &&
            r.ns === key.ns &&
            r.key === key.key
          )
      )
      return db.rows.length < before
    })
  }
}))

/** 会话 id → 注册表文件（registryNoteFileOf 的替身表） */
const notes = vi.hoisted(() => new Map<string, RegistryNoteFile>())
vi.mock('../registryNotes', () => ({
  registryNoteFileOf: vi.fn((sessionId: string) => notes.get(sessionId) ?? null)
}))

import { appEventBus } from '../../utils/appEventBus'
import { mdMetaStore } from '../mdMeta'
import { noteView, setNoteFill, unsetNoteFill } from '../mdMetaService'

const publish = vi.spyOn(appEventBus, 'publish')

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const U_UP = U.toUpperCase()
const V = '0199d3a2-0000-7000-8000-000000000000'
const MODEL = 'shuvix-model'
const THINKING = 'shuvix-thinking'

/** 仓库里随包发布的内置 explore（只读，这里只读不写） */
const BUILTIN_EXPLORE = resolve(
  __dirname,
  '../../../../../../packages/agent-runtime/src/subagent/builtinAgents/md/explore.md'
)

const base = mkdtempSync(join(tmpdir(), 'shuvix-mdmeta-'))
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

let seq = 0
/** 放一份文件并把一条会话指向它；回会话 id */
function note(
  kind: RegistryNoteFile['kind'],
  text: string | null,
  opts: { builtin?: boolean; absPath?: string } = {}
): string {
  const sid = `s-${++seq}`
  const fileName = `${kind}-${seq}.md`
  const absPath = opts.absPath ?? join(base, fileName)
  if (text !== null && !opts.absPath) {
    mkdirSync(base, { recursive: true })
    writeFileSync(absPath, text)
  }
  notes.set(sid, { kind, absPath, builtin: opts.builtin ?? false, fileName })
  return sid
}

/** agent 文件；idLine 省略 = 不写 id */
const agentText = (idLine: string | null, extra: string[] = []): string =>
  [
    '---',
    'shuvix: agent v1',
    ...(idLine === null ? [] : [idLine]),
    'name: meta-agent',
    'description: d',
    ...extra,
    '---',
    '',
    'Body.',
    ''
  ].join('\n')
const otherText = (marker: string, idLine: string): string =>
  ['---', `shuvix: ${marker}`, idLine, 'name: other', '---', '', 'Body.', ''].join('\n')

/** 直接往内存表里塞一行（绕过 service 的校验，造「库里已有的坏值」） */
function seedRow(objectId: string, key: string, value: unknown): void {
  mdMetaStore.setFill(objectId, key, value)
}

const storedFor = (objectId: string): Record<string, unknown> =>
  Object.fromEntries(db.rows.filter((r) => r.objectId === objectId).map((r) => [r.key, r.value]))

beforeEach(() => {
  db.rows = []
  notes.clear()
  // 快照随写失效 —— 清表之后借一次 unset 让它失效（unset 本身对空表无副作用）
  mdMetaStore.unsetFill('__reset__', '__reset__')
  publish.mockClear()
})

describe('noteView —— 一份注册表笔记的元数据视图', () => {
  it('MS-V1 sessionId 不是字符串 → null；不是注册表笔记 → null', () => {
    expect(noteView(42 as unknown as string)).toBeNull()
    expect(noteView(undefined as unknown as string)).toBeNull()
    expect(noteView('unknown-session')).toBeNull()
  })

  it('MS-V2 agent 文件（大写 UUID）+ 库里存了模型 → 完整视图；fillKeys 是副本', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U_UP}`))
    seedRow(U, MODEL, 'p/m')
    const view = noteView(sid)
    expect(view).toEqual({
      kind: 'agent',
      objectId: U,
      idStatus: 'ok',
      fillKeys: [MODEL, THINKING],
      fill: { [MODEL]: 'p/m' },
      declared: [],
      warnings: [],
      readOnly: false
    })
    view!.fillKeys.push('mutated')
    expect(MD_FM_FILL_KEYS.agent).toEqual([MODEL, THINKING])
  })

  it('MS-V3 没写 id → none、objectId null、fill {}，不去问 store', () => {
    const sid = note('agent', agentText(null))
    const fillFor = vi.spyOn(mdMetaStore, 'fillFor')
    try {
      expect(noteView(sid)).toMatchObject({ objectId: null, idStatus: 'none', fill: {} })
      expect(fillFor).not.toHaveBeenCalled()
    } finally {
      fillFor.mockRestore()
    }
  })

  it.each(['shuvix-id: nope', 'shuvix-id: 123', "shuvix-id: ''", 'shuvix-id:'])(
    'MS-V4 写坏的 `%s` → malformed、objectId null、fill {}',
    (line) => {
      const sid = note('agent', agentText(line))
      expect(noteView(sid)).toMatchObject({ objectId: null, idStatus: 'malformed', fill: {} })
    }
  )

  it('MS-V5 文件不存在 / YAML 写坏（哪怕有一行合法 id）→ none', () => {
    const missing = note('agent', null, { absPath: join(base, 'does-not-exist.md') })
    expect(noteView(missing)).toMatchObject({ objectId: null, idStatus: 'none' })
    const broken = note('agent', agentText(`shuvix-id: ${U}`, ['broken: [unclosed']))
    expect(noteView(broken)).toMatchObject({ objectId: null, idStatus: 'none' })
  })

  it('MS-V6 内置载体 → readOnly true，补缺值照样读得到', () => {
    const sid = note('agent', null, { absPath: BUILTIN_EXPLORE, builtin: true })
    seedRow('agent:builtin:explore', THINKING, 'high')
    expect(noteView(sid)).toMatchObject({
      kind: 'agent',
      objectId: 'agent:builtin:explore',
      idStatus: 'ok',
      readOnly: true,
      fill: { [THINKING]: 'high' }
    })
  })

  it.each([
    ['bot', 'bot v2'],
    ['hook', 'hook v1'],
    ['policy', 'policy v1']
  ] as const)(
    'MS-V7 %s 笔记：fillKeys [] / fill {}（库里有这个 id 的 agent 行也一样）/ declared [] / warnings []',
    (kind, marker) => {
      const sid = note(kind, otherText(marker, `shuvix-id: ${U}`))
      seedRow(U, MODEL, 'p/m')
      expect(noteView(sid)).toEqual({
        kind,
        objectId: U,
        idStatus: 'ok',
        fillKeys: [],
        fill: {},
        declared: [],
        warnings: [],
        readOnly: false
      })
    }
  )

  it('MS-V8 文件写了 shuvix-thinking: high → declared 含它；写成空串 / null → 不算写了；库里存的声明键照样列在 fill 里', () => {
    seedRow(U, THINKING, 'low')
    const declared = note('agent', agentText(`shuvix-id: ${U}`, ['shuvix-thinking: high']))
    expect(noteView(declared)).toMatchObject({
      declared: [THINKING],
      fill: { [THINKING]: 'low' },
      warnings: []
    })
    for (const line of ["shuvix-thinking: ''", 'shuvix-thinking:']) {
      const sid = note('agent', agentText(`shuvix-id: ${U}`, [line]))
      expect(noteView(sid)?.declared, line).toEqual([])
    }
  })

  it('MS-V9 库里的值不合法（档位 max / 数字模型）→ 恰一条告警；同样的坏值落在文件已写的键上 → 不告警（不生效就不算问题）', () => {
    seedRow(U, THINKING, 'max')
    const a = note('agent', agentText(`shuvix-id: ${U}`))
    const viewA = noteView(a)!
    expect(viewA.warnings).toHaveLength(1)
    expect(viewA.warnings[0]).toContain("'shuvix-thinking'")

    db.rows = []
    seedRow(V, MODEL, 42)
    const b = note('agent', agentText(`shuvix-id: ${V}`))
    const viewB = noteView(b)!
    expect(viewB.warnings).toHaveLength(1)
    expect(viewB.warnings[0]).toContain("'shuvix-model'")

    const declaredBad = note('agent', agentText(`shuvix-id: ${V}`, ['shuvix-model: real/m']))
    expect(noteView(declaredBad)?.warnings).toEqual([])
  })
})

describe('setNoteFill / unsetNoteFill —— 写入', () => {
  it('MS-W1 会话查无 / 不是字符串 → not-registry-note', () => {
    for (const sessionId of ['unknown', 42, null, undefined]) {
      expect(
        setNoteFill({ sessionId, objectId: U, key: THINKING, value: 'high' } as never)
      ).toEqual({ success: false, reason: 'not-registry-note' })
      expect(unsetNoteFill({ sessionId, objectId: U, key: THINKING } as never)).toEqual({
        success: false,
        reason: 'not-registry-note'
      })
    }
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(['description', 'shuvix-tools', 'shuvix-id', 'name', 'shuvix', 42])(
    'MS-W2 agent 笔记写白名单外的键 %j → key-not-allowed',
    (key) => {
      const sid = note('agent', agentText(`shuvix-id: ${U}`))
      expect(setNoteFill({ sessionId: sid, objectId: U, key, value: 'x' } as never)).toEqual({
        success: false,
        reason: 'key-not-allowed'
      })
      expect(db.rows).toEqual([])
      expect(publish).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['bot', 'bot v2'],
    ['hook', 'hook v1'],
    ['policy', 'policy v1']
  ] as const)('MS-W3 %s 笔记写任何键（含 shuvix-model）→ key-not-allowed', (kind, marker) => {
    const sid = note(kind, otherText(marker, `shuvix-id: ${U}`))
    for (const key of [MODEL, THINKING, 'description']) {
      expect(setNoteFill({ sessionId: sid, objectId: U, key, value: 'p/m' })).toEqual({
        success: false,
        reason: 'key-not-allowed'
      })
      expect(unsetNoteFill({ sessionId: sid, objectId: U, key })).toEqual({
        success: false,
        reason: 'key-not-allowed'
      })
    }
    expect(db.rows).toEqual([])
  })

  it('MS-W4 磁盘上的 id 不是渲染进程给的那个 → no-object-id：没写 / 写坏 / 另一个 UUID / 参数本身不合法 / 内置 explore 收到 coding 的 id', () => {
    const noId = note('agent', agentText(null))
    const malformed = note('agent', agentText('shuvix-id: nope'))
    const withU = note('agent', agentText(`shuvix-id: ${U}`))
    const explore = note('agent', null, { absPath: BUILTIN_EXPLORE, builtin: true })
    const cases: [string, unknown][] = [
      [noId, U],
      [malformed, U],
      [withU, V],
      [withU, 'nope'],
      [withU, null],
      [withU, 42],
      [explore, 'agent:builtin:coding']
    ]
    for (const [sessionId, objectId] of cases) {
      expect(
        setNoteFill({ sessionId, objectId, key: THINKING, value: 'high' } as never),
        `${sessionId} ${String(objectId)}`
      ).toEqual({ success: false, reason: 'no-object-id' })
      expect(unsetNoteFill({ sessionId, objectId, key: THINKING } as never)).toEqual({
        success: false,
        reason: 'no-object-id'
      })
    }
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('MS-W5 归一后相等即可：参数大写、磁盘小写（反之亦然）；内置 explore 收到自己的 agent:builtin:explore', () => {
    const lower = note('agent', agentText(`shuvix-id: ${U}`))
    expect(setNoteFill({ sessionId: lower, objectId: U_UP, key: THINKING, value: 'low' })).toEqual({
      success: true
    })
    const upper = note('agent', agentText(`shuvix-id: ${U_UP}`))
    expect(setNoteFill({ sessionId: upper, objectId: U, key: MODEL, value: 'p/m' })).toEqual({
      success: true
    })
    const explore = note('agent', null, { absPath: BUILTIN_EXPLORE, builtin: true })
    expect(
      setNoteFill({
        sessionId: explore,
        objectId: 'agent:builtin:explore',
        key: THINKING,
        value: 'high'
      })
    ).toEqual({ success: true })
    expect(storedFor(U)).toEqual({ [THINKING]: 'low', [MODEL]: 'p/m' })
    expect(storedFor('agent:builtin:explore')).toEqual({ [THINKING]: 'high' })
  })

  it('MS-W6 校验顺序：键不对 + id 不对 → key-not-allowed；会话不对 + 键不对 → not-registry-note', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    expect(setNoteFill({ sessionId: sid, objectId: V, key: 'shuvix-tools', value: 'x' })).toEqual({
      success: false,
      reason: 'key-not-allowed'
    })
    expect(
      setNoteFill({ sessionId: 'nope', objectId: V, key: 'shuvix-tools', value: 'x' })
    ).toEqual({ success: false, reason: 'not-registry-note' })
  })

  it.each([
    ['null', THINKING, null],
    ['空串', THINKING, ''],
    ['纯空白', MODEL, '   '],
    ['NaN', THINKING, NaN],
    ['Infinity', MODEL, Infinity],
    ['undefined', THINKING, undefined],
    ['带函数的对象', MODEL, { f: () => 1 }],
    ['Date', MODEL, new Date(0)]
  ])('MS-W7 空值 / 非 JSON 值（%s）→ invalid-value，什么都不写、不广播', (_label, key, value) => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    const result = setNoteFill({ sessionId: sid, objectId: U, key, value })
    expect(result).toMatchObject({ success: false, reason: 'invalid-value' })
    expect((result as { message?: string }).message).toBeTruthy()
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('MS-W7b 解析器不收的值 → invalid-value 带解析器原因：数字模型点名 shuvix-model；档位 max 列出全部档位；布尔档位', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    const model = setNoteFill({ sessionId: sid, objectId: U, key: MODEL, value: 42 })
    expect(model).toMatchObject({ success: false, reason: 'invalid-value' })
    expect((model as { message: string }).message).toContain("'shuvix-model'")

    const max = setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: 'max' })
    expect(max).toMatchObject({ success: false, reason: 'invalid-value' })
    for (const level of SELECTABLE_THINKING_LEVELS) {
      expect((max as { message: string }).message).toContain(level)
    }

    expect(setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: true })).toMatchObject({
      success: false,
      reason: 'invalid-value'
    })
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('MS-W8 写档位 high → success；存在归一后的 id 下（参数给大写）；agent.changed 恰广播一次；下一次 noteView 看得到', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    expect(setNoteFill({ sessionId: sid, objectId: U_UP, key: THINKING, value: 'high' })).toEqual({
      success: true
    })
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({
      objectId: U,
      scope: '',
      ns: 'fm',
      key: THINKING,
      value: 'high'
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'agent.changed' })
    expect(noteView(sid)?.fill).toEqual({ [THINKING]: 'high' })
  })

  it('MS-W9 文件已写的键也能存（不生效，但存得下）：declared 与 fill 同时列出', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`, ['shuvix-thinking: low']))
    expect(setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: 'high' })).toEqual({
      success: true
    })
    expect(noteView(sid)).toMatchObject({ declared: [THINKING], fill: { [THINKING]: 'high' } })
  })

  it('MS-W10 删已有的键 → success、广播一次、键没了；删本来没有的键 → success、不广播', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: 'high' })
    setNoteFill({ sessionId: sid, objectId: U, key: MODEL, value: 'p/m' })
    publish.mockClear()

    expect(unsetNoteFill({ sessionId: sid, objectId: U, key: THINKING })).toEqual({ success: true })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'agent.changed' })
    expect(noteView(sid)?.fill).toEqual({ [MODEL]: 'p/m' })

    publish.mockClear()
    expect(unsetNoteFill({ sessionId: sid, objectId: U, key: THINKING })).toEqual({ success: true })
    expect(publish).not.toHaveBeenCalled()
    expect(storedFor(U)).toEqual({ [MODEL]: 'p/m' })
  })

  it('MS-W11 存的是归一后的值：档位 HIGH → high；模型 " p/m " → p/m', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    expect(setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: 'HIGH' })).toEqual({
      success: true
    })
    expect(setNoteFill({ sessionId: sid, objectId: U, key: MODEL, value: ' p/m ' })).toEqual({
      success: true
    })
    expect(storedFor(U)).toEqual({ [THINKING]: 'high', [MODEL]: 'p/m' })
  })
})
