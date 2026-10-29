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
 *   - 校验顺序：先认会话、再认键、最后认 id；
 *   - **停用开关**（setEnabled / noteView.enabled）：只收确有其物的内置 hook / 安全策略 id（不经会话、不读文件），
 *     状态真的变了才广播这类文件的 `*.changed`；视图只给 id 能停用、且 id 的类型就是这份文件类型的笔记。
 *
 * 文件是真的（临时目录）；数据库换成内存表（mdAttrDao 替身，store 用真的）；appEventBus.publish 被 spy。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
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
import { noteView, setEnabled, setNoteFill, unsetNoteFill } from '../mdMetaService'

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
/** 随包发布的内置 auto-title hook 与 ask-on-external-path 策略（同样只读） */
const BUILTIN_AUTO_TITLE = resolve(
  __dirname,
  '../../../../../../packages/agent-runtime/src/hook/builtinHooks/md/auto-title.md'
)
const BUILTIN_EXTERNAL_PATH = resolve(
  __dirname,
  '../../../../../../packages/agent-runtime/src/security/builtinPolicies/md/ask-on-external-path.md'
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

  it('MS-V9 库里的值不合法（档位 minimal / 数字模型）→ 恰一条告警；同样的坏值落在文件已写的键上 → 不告警（不生效就不算问题）', () => {
    seedRow(U, THINKING, 'minimal')
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

  it('MS-W7b 解析器不收的值 → invalid-value 带解析器原因：数字模型点名 shuvix-model；档位 minimal 列出全部档位；布尔档位', () => {
    const sid = note('agent', agentText(`shuvix-id: ${U}`))
    const model = setNoteFill({ sessionId: sid, objectId: U, key: MODEL, value: 42 })
    expect(model).toMatchObject({ success: false, reason: 'invalid-value' })
    expect((model as { message: string }).message).toContain("'shuvix-model'")

    const minimal = setNoteFill({ sessionId: sid, objectId: U, key: THINKING, value: 'minimal' })
    expect(minimal).toMatchObject({ success: false, reason: 'invalid-value' })
    for (const level of SELECTABLE_THINKING_LEVELS) {
      expect((minimal as { message: string }).message).toContain(level)
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

describe('setEnabled —— 内置 hook / 安全策略的停用开关', () => {
  const HOOK = 'hook:builtin:auto-title'
  const POLICY = 'policy:builtin:ask-on-external-path'
  const metaRows = (): MdAttr[] => db.rows.filter((r) => r.ns === 'meta')

  it('MS-E1 停用内置 auto-title → success、存一行 meta.enabled=false、恰广播一次 hook.changed、不广播 policy.changed', () => {
    expect(setEnabled({ objectId: HOOK, enabled: false })).toEqual({ success: true })
    expect(metaRows()).toEqual([
      { objectId: HOOK, scope: '', ns: 'meta', key: 'enabled', value: false, updatedAt: 1 }
    ])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'hook.changed' })
    expect(publish).not.toHaveBeenCalledWith({ type: 'policy.changed' })
  })

  it('MS-E2 停用内置 ask-on-external-path → 恰广播一次 policy.changed', () => {
    expect(setEnabled({ objectId: POLICY, enabled: false })).toEqual({ success: true })
    expect(metaRows()).toHaveLength(1)
    expect(metaRows()[0]).toMatchObject({ objectId: POLICY, key: 'enabled', value: false })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'policy.changed' })
  })

  it('MS-E3 重复同一状态 → success、不广播、不多写；启用 → 删掉那一行、恰广播一次', async () => {
    const { mdAttrDao } = await import('../../dao/mdAttrDao')
    const upsert = vi.mocked(mdAttrDao.upsert)
    const del = vi.mocked(mdAttrDao.delete)
    upsert.mockClear()
    del.mockClear()

    expect(setEnabled({ objectId: HOOK, enabled: false })).toEqual({ success: true })
    publish.mockClear()
    expect(setEnabled({ objectId: HOOK, enabled: false })).toEqual({ success: true })
    expect(publish).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)

    expect(setEnabled({ objectId: HOOK, enabled: true })).toEqual({ success: true })
    expect(metaRows()).toEqual([])
    expect(del).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'hook.changed' })

    publish.mockClear()
    expect(setEnabled({ objectId: HOOK, enabled: true })).toEqual({ success: true })
    expect(publish).not.toHaveBeenCalled()
    expect(del).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['内置 agent', 'agent:builtin:explore'],
    ['内置 bot', 'bot:builtin:x'],
    ['UUID', U],
    ['不存在的内置 hook', 'hook:builtin:nonexistent'],
    ['下线的内置策略', 'policy:builtin:ask-on-write'],
    ['大写类型段', 'HOOK:builtin:auto-title'],
    ['名字大小写不同', 'hook:builtin:Auto-Title'],
    ['空串', ''],
    ['undefined', undefined]
  ])('MS-E4 不能停用的 id（%s）→ key-not-allowed，什么都不写、不广播', (_label, objectId) => {
    // UUID 那一条：哪怕某份文件真的持有它
    note('hook', otherText('hook v1', `shuvix-id: ${U}`))
    expect(setEnabled({ objectId, enabled: false } as never)).toEqual({
      success: false,
      reason: 'key-not-allowed',
      message: 'not a builtin policy or hook'
    })
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('MS-E4b params 整个是 undefined → key-not-allowed，不抛', () => {
    expect(() => setEnabled(undefined as never)).not.toThrow()
    expect(setEnabled(undefined as never)).toMatchObject({
      success: false,
      reason: 'key-not-allowed'
    })
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it("MS-E5 enabled 不是布尔（'false' / 0 / null / 缺省）→ invalid-value；id 也不对 → key-not-allowed（先认 id）", () => {
    for (const enabled of ['false', 0, null, undefined]) {
      expect(setEnabled({ objectId: HOOK, enabled } as never), String(enabled)).toMatchObject({
        success: false,
        reason: 'invalid-value'
      })
    }
    expect(setEnabled({ objectId: HOOK } as never)).toMatchObject({
      success: false,
      reason: 'invalid-value'
    })
    expect(
      setEnabled({ objectId: 'agent:builtin:explore', enabled: 'false' } as never)
    ).toMatchObject({ success: false, reason: 'key-not-allowed' })
    expect(db.rows).toEqual([])
    expect(publish).not.toHaveBeenCalled()
  })

  it('MS-E6 首尾空白的 id 照收，存的是剥掉空白之后的', () => {
    expect(setEnabled({ objectId: `  ${HOOK}  `, enabled: false })).toEqual({ success: true })
    expect(metaRows().map((r) => r.objectId)).toEqual([HOOK])
    expect(mdMetaStore.isDisabled(HOOK)).toBe(true)
  })
})

describe('noteView.enabled —— 只有能停用的笔记才有这个字段', () => {
  it('MS-E7 内置 hook 笔记：缺省 true，停用后 false；内置策略笔记同样', () => {
    const hook = note('hook', null, { absPath: BUILTIN_AUTO_TITLE, builtin: true })
    expect(noteView(hook)).toMatchObject({
      kind: 'hook',
      objectId: 'hook:builtin:auto-title',
      readOnly: true,
      enabled: true
    })
    setEnabled({ objectId: 'hook:builtin:auto-title', enabled: false })
    expect(noteView(hook)?.enabled).toBe(false)

    const policy = note('policy', null, { absPath: BUILTIN_EXTERNAL_PATH, builtin: true })
    expect(noteView(policy)).toMatchObject({
      kind: 'policy',
      objectId: 'policy:builtin:ask-on-external-path',
      enabled: true
    })
    setEnabled({ objectId: 'policy:builtin:ask-on-external-path', enabled: false })
    expect(noteView(policy)?.enabled).toBe(false)
  })

  it('MS-E8 沿用内置 id 的用户覆盖副本：有 enabled、readOnly false，跟着内置的开关走', () => {
    const copy = note('hook', otherText('hook v1', 'shuvix-id: hook:builtin:auto-title'))
    expect(noteView(copy)).toMatchObject({ readOnly: false, enabled: true })
    setEnabled({ objectId: 'hook:builtin:auto-title', enabled: false })
    expect(noteView(copy)).toMatchObject({ readOnly: false, enabled: false })
  })

  it('MS-E9 其余笔记没有 enabled 这个键', () => {
    const sids = [
      note('agent', null, { absPath: BUILTIN_EXPLORE, builtin: true }),
      note('bot', otherText('bot v2', `shuvix-id: ${U}`)),
      note('hook', otherText('hook v1', `shuvix-id: ${U}`)),
      note('policy', otherText('policy v1', `shuvix-id: ${V}`)),
      note('hook', otherText('hook v1', 'shuvix-id: hook:builtin:nonexistent')),
      note('hook', otherText('hook v1', 'shuvix-id: nope')),
      note('policy', ['---', 'shuvix: policy v1', 'name: no-id', '---', '', 'B', ''].join('\n')),
      // 类型对不上：hook 文件里写着一个安全策略的内置 id —— 开关不能出现在这里
      note('hook', otherText('hook v1', 'shuvix-id: policy:builtin:ask-on-command'))
    ]
    for (const sid of sids) {
      const view = noteView(sid)
      expect(view, sid).not.toBeNull()
      expect('enabled' in view!, sid).toBe(false)
    }
  })
})

/**
 * MS-G 静态守护：停用开关改变安全面（停掉 ask-on-command 就不再问命令，停掉 auto-review 审批就全回到人手上），
 * 补缺值改变 agent 怎么跑 —— 写入口只有界面上那一个（IPC → mdMetaService）。扫 apps/desktop/src 的源码（不含测试）：
 * 只有 mdMetaService 调 mdMetaStore 的写方法；工具与 CLI 一个都不引 mdMetaService / services/mdMeta。
 */
describe('MS-G 写入口只有 mdMetaService', () => {
  const SRC = resolve(__dirname, '../../..')
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full)
      return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
    })
  const rel = (file: string): string => relative(SRC, file).split(sep).join('/')
  const all = sources(SRC)

  it('MS-G1 mdMetaStore.setEnabled / setFill / unsetFill 只在 services/mdMetaService.ts 里被调用', () => {
    expect(all.length).toBeGreaterThan(100)
    for (const method of ['setEnabled', 'setFill', 'unsetFill']) {
      const callers = all
        .filter((file) => readFileSync(file, 'utf8').includes(`mdMetaStore.${method}(`))
        .map(rel)
      expect(callers, method).toEqual(['main/services/mdMetaService.ts'])
    }
  })

  it('MS-G2 工具（main/tools）与 CLI（cli/、services/cliServer.ts）不引 mdMetaService，也不引 services/mdMeta', () => {
    const scoped = all.filter((file) => {
      const r = rel(file)
      return (
        r.startsWith('main/tools/') || r.startsWith('cli/') || r === 'main/services/cliServer.ts'
      )
    })
    expect(scoped.length).toBeGreaterThan(5)
    const offenders = scoped
      .filter((file) =>
        /from\s+'[^']*(?:mdMetaService|services\/mdMeta|\.\/mdMeta|\.\.\/mdMeta)'/.test(
          readFileSync(file, 'utf8')
        )
      )
      .map(rel)
    expect(offenders).toEqual([])
  })
})
