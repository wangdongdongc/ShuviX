/**
 * 安全策略的**编辑链路**（policy IPC 的写路径 + 设置页 UI）。
 * 列表/详情的只读面在 policies.e2e.ts，这里不重复。
 *
 * 关注点是「文件即事实」这条契约在读写两侧都成立：
 *   - getSource 逐字节回吐用户文件（注释/键序/空行原样）——原文编辑模型的前提；
 *     内置策略无文件，回写出的等价 md 必须自身合法（否则「创建覆盖副本」一开局就是坏文件）；
 *   - create（新建与覆盖副本的入口）**非法一律拒绝写盘**；
 *   - 已有文件的编辑就是它的**笔记本会话**（policy.openNote → 自动保存，与 files.write 同一个
 *     writeSessionFile）：**没有写前校验** —— 写到一半解析不过的版本照样落盘，它不生效、不遮蔽
 *     内置，列进「无法解析」分组，解析器的判定由属性卡的横幅给出；
 *   - 改名以 frontmatter `name` 为准、文件路径不变；撞内置名即覆盖（有意设计）；撞另一份用户策略
 *     的名字时两份都照写、注册表只收一份（收哪份取决于 readdir 顺序 —— 刻意不断言）；
 *   - 落盘即生效（每次评估现扫目录，无缓存/无失效通知）。
 *
 * 断言优先走 IPC（window.api.policy.*）+ fs 直读；DOM 只在验证呈现时用且一律经 pages.ts。
 * 写入只走两条路：`noteWrite`（写路径 IPC）或属性卡 `commitField` —— 绝不往 CodeMirror 里打字。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  policiesPane,
  registryNotePane,
  type PoliciesPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  createProject,
  expectFileUnchanged,
  noteWrite,
  openRegistryNote,
  waitFileWritten
} from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

type Conditions = Record<string, string[]>

interface PolicyItem {
  name: string
  displayName: string
  description: string
  scope?: Conditions
  lets?: Record<string, string>
  rules: Array<{ effect: string; conditions?: Conditions; match?: string }>
  body: string
  source: 'builtin' | 'user'
  basePath: string
  overridden?: boolean
}

type SourceResult = { text: string } | { error: string }
type WriteResult = { success: boolean; name?: string; error?: string }

const mdText = (...lines: string[]): string => lines.join('\n')

/** 最小合法策略 md（命令客体的询问门形状）—— 大多数用例只关心 name/effect/description */
const simplePolicy = (opts: {
  name: string
  description?: string
  effect?: string
  body?: string
}): string =>
  mdText(
    '---',
    'shuvix: policy v1',
    `name: '${opts.name}'`,
    ...(opts.description ? [`description: ${opts.description}`] : []),
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [command]',
    'shuvix-policy-rules:',
    `  - effect: ${opts.effect ?? 'ask'}`,
    '    action: [execute]',
    '---',
    '',
    opts.body ?? 'Body.',
    ''
  )

/** 规则带未知键 note → 解析器给「规则级细因 + 文件级 rejected」两行原因 */
const invalidPolicy = (name: string): string =>
  mdText(
    '---',
    'shuvix: policy v1',
    `name: '${name}'`,
    'shuvix-policy-rules:',
    '  - effect: deny',
    '    subject.kind: [agent]',
    '    note: x',
    '---',
    '',
    'Invalid body.',
    ''
  )

const policiesDir = (): string => join(app.home, '.shuvix', 'policies')
const dirFiles = (): string[] =>
  existsSync(policiesDir()) ? readdirSync(policiesDir()).sort() : []
const readPolicyFile = (fileName: string): string =>
  readFileSync(join(policiesDir(), fileName), 'utf-8')
const hasPolicyFile = (fileName: string): boolean => existsSync(join(policiesDir(), fileName))
/** 绕过 IPC 直接把文件丢进目录（构造非法/非常规文件名的素材，或扮演外部编辑器） */
const writePolicyFile = (fileName: string, text: string): void => {
  mkdirSync(policiesDir(), { recursive: true })
  writeFileSync(join(policiesDir(), fileName), text, 'utf-8')
}

const listPolicies = (): Promise<PolicyItem[]> => app.main.eval('window.api.policy.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.policy.listInvalid()')
const getSource = (name: string, source: 'builtin' | 'user'): Promise<SourceResult> =>
  app.main.eval(`window.api.policy.getSource(${JSON.stringify({ name, source })})`)
const createPolicy = (text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.policy.create(${JSON.stringify({ text })})`)
const deletePolicy = (name: string): Promise<WriteResult> =>
  app.main.eval(`window.api.policy.delete(${JSON.stringify({ name })})`)
/** 经这份文件的笔记本会话写入（已有策略的编辑路径） */
const policyNoteWrite = (
  fileName: string,
  text: string
): Promise<{ ok: boolean; error?: string }> => noteWrite(app.main, 'policy', fileName, text)

const rowsFor = async (name: string): Promise<PolicyItem[]> =>
  (await listPolicies()).filter((p) => p.name === name)

describe('policy 编辑 IPC —— 取原文 / 新建 / 经笔记本编辑 / 删除', () => {
  it('PE-B5 首次 create 懒创建策略目录（此前 ~/.shuvix/policies 不存在）', async () => {
    // 本用例必须跑在任何策略文件写入之前 —— 目录是 create 第一次才建的
    expect(existsSync(policiesDir())).toBe(false)
    expect(await createPolicy(simplePolicy({ name: 'b5-lazy-dir' }))).toEqual({
      success: true,
      name: 'b5-lazy-dir'
    })
    expect(existsSync(policiesDir())).toBe(true)
    expect(dirFiles()).toEqual(['b5-lazy-dir.md'])
  })

  // ── A 组：getSource（只读查看与覆盖副本的数据源）
  const RAW_FIDELITY = mdText(
    '---',
    'shuvix: policy v1',
    '# 注释与非规范键序：getSource 必须逐字节回吐，不得被 serialize 规范化',
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '    action: [execute]',
    'name: raw-fidelity',
    'description: raw fidelity',
    '---',
    '',
    'Body line one.',
    '',
    '',
    'Body line two, after two blank lines.',
    ''
  )

  it('PE-A1 用户策略逐字节回吐原文（注释 / 非规范键序 / 正文空行原样），且按 name 而非文件名定位', async () => {
    // 文件名 a-file.md 与 frontmatter name: raw-fidelity 刻意不一致
    writePolicyFile('a-file.md', RAW_FIDELITY)

    const result = await getSource('raw-fidelity', 'user')
    expect('text' in result).toBe(true)
    // 全等而非 toContain —— 原文编辑模型的整个前提就是「读回来的就是磁盘上的字节」
    expect((result as { text: string }).text).toBe(RAW_FIDELITY)
    expect((result as { text: string }).text).toBe(readPolicyFile('a-file.md'))

    // 文件名不是标识：按 basename 查不到
    expect(await getSource('a-file', 'user')).toEqual({ error: 'Policy "a-file" not found' })
  })

  it('PE-A2 内置策略回写等价 md：含类型标记与规则键，且自身经 shuvixMd.validate 判合法', async () => {
    const result = await getSource('protect-credentials', 'builtin')
    expect('text' in result).toBe(true)
    const { text } = result as { text: string }
    expect(text).toContain('shuvix: policy v1')
    expect(text).toContain('shuvix-policy-rules')

    // 「创建覆盖副本」的初值必须自身合法 —— 否则用户一开局拿到的就是不生效的坏文件
    const validation = await app.main.eval<{ status: string; messages: string[] }>(
      `window.api.shuvixMd.validate({ type: 'policy', text: ${JSON.stringify(text)} })`
    )
    expect(validation).toEqual({ status: 'valid', messages: [] })
  })

  it('PE-A3 三种查不到：user 查无此名 / builtin 查无此名 / user 查只有内置的名字', async () => {
    expect(await getSource('no-such-policy', 'user')).toEqual({
      error: 'Policy "no-such-policy" not found'
    })
    expect(await getSource('no-such-policy', 'builtin')).toEqual({
      error: 'Builtin policy "no-such-policy" not found'
    })
    // 关键：user 源不得回吐内置文本（否则「编辑用户策略」会静默变成编辑内置副本）
    expect(await getSource('ask-on-write', 'user')).toEqual({
      error: 'Policy "ask-on-write" not found'
    })
  })

  it('PE-A4 磁盘上存在但非法的用户文件 → getSource(user) 同样 not found（非法文件不进扫描结果）', async () => {
    writePolicyFile('broken-user.md', invalidPolicy('broken-user'))
    expect(await getSource('broken-user', 'user')).toEqual({
      error: 'Policy "broken-user" not found'
    })
    expect((await listPolicies()).some((p) => p.name === 'broken-user')).toBe(false)
  })

  // ── B 组：create
  const B1_TEXT = mdText(
    '---',
    'shuvix: policy v1',
    'name: b1-created',
    'description: created via ipc',
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [path]',
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    action: [write]',
    `    match: "inDir(object.path, '/tmp/e2e-b1')"`,
    '---',
    '',
    'B1 body.',
    ''
  )

  it('PE-B1 合法新建：返回 name、文件内容与传入 text 逐字节相等、list 出现 user 行且规则原样', async () => {
    expect(await createPolicy(B1_TEXT)).toEqual({ success: true, name: 'b1-created' })
    expect(readPolicyFile('b1-created.md')).toBe(B1_TEXT)

    const row = (await rowsFor('b1-created'))[0]
    expect(row.source).toBe('user')
    expect(row.description).toBe('created via ipc')
    expect(row.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['path'] })
    expect(row.rules).toEqual([
      {
        effect: 'ask',
        conditions: { action: ['write'] },
        match: "inDir(object.path, '/tmp/e2e-b1')"
      }
    ])
  })

  it('PE-B2 非法新建被拒且目录零新增（拒绝原因即解析器原文）', async () => {
    const before = dirFiles()
    const result = await createPolicy(invalidPolicy('b2-invalid'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('unknown rule key')
    expect(result.error).toContain('rejected')
    expect(dirFiles()).toEqual(before)
  })

  it('PE-B3 与既有用户策略重名 → 拒绝，不产生第二个文件', async () => {
    const before = dirFiles()
    const result = await createPolicy(simplePolicy({ name: 'b1-created', description: 'dup' }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
    expect(dirFiles()).toEqual(before)
  })

  it('PE-B4 覆盖内置放行：同名用户策略生效，原内置转 overridden', async () => {
    const text = mdText(
      '---',
      'shuvix: policy v1',
      'name: ask-on-database',
      'description: e2e loosened database gate',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [database]',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    action: [execute]',
      `    match: "object.dbType == 'mysql'"`,
      '---',
      '',
      'Only mysql asks.',
      ''
    )
    expect(await createPolicy(text)).toEqual({ success: true, name: 'ask-on-database' })
    expect(hasPolicyFile('ask-on-database.md')).toBe(true)

    const rows = await rowsFor('ask-on-database')
    expect(rows).toHaveLength(2)
    expect(rows.find((p) => p.source === 'user')!.description).toBe('e2e loosened database gate')
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)
  })

  it('PE-B6 文件名净化：name `net/ssh:guard` → net-ssh-guard.md，list 里 name 仍是原始值', async () => {
    expect(await createPolicy(simplePolicy({ name: 'net/ssh:guard' }))).toEqual({
      success: true,
      name: 'net/ssh:guard'
    })
    expect(hasPolicyFile('net-ssh-guard.md')).toBe(true)
    // 标识是 frontmatter name，净化只作用于文件名
    expect((await rowsFor('net/ssh:guard'))[0].source).toBe('user')
  })

  it('PE-B7 软告警不阻断写盘：match 读客体属性却无 object.type 条件 → 仍创建成功', async () => {
    const text = mdText(
      '---',
      'shuvix: policy v1',
      'name: b7-soft-warn',
      'description: reads object attrs without an object.type guard',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    subject.kind: [agent]',
      `    match: "object.path != ''"`,
      '---',
      '',
      'Soft warn body.',
      ''
    )
    expect(await createPolicy(text)).toEqual({ success: true, name: 'b7-soft-warn' })
    expect(readPolicyFile('b7-soft-warn.md')).toBe(text)
    expect((await rowsFor('b7-soft-warn'))[0].source).toBe('user')
  })

  it('PE-B8 空规则覆盖（rules: []）成功清空一道内置门；YAML null 的 rules 键则整份拒绝', async () => {
    const emptyOverride = mdText(
      '---',
      'shuvix: policy v1',
      'name: protect-system',
      'description: e2e emptied override',
      'shuvix-policy-rules: []',
      '---',
      '',
      'Emptied on purpose.',
      ''
    )
    expect(await createPolicy(emptyOverride)).toEqual({ success: true, name: 'protect-system' })
    const rows = await rowsFor('protect-system')
    expect(rows.find((p) => p.source === 'user')!.rules).toEqual([])
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)

    // 「写了键但没给值」不是空规则，是笔误 —— 整份拒绝
    const before = dirFiles()
    const nullRules = mdText(
      '---',
      'shuvix: policy v1',
      'name: b8-null-rules',
      'shuvix-policy-rules:',
      '---',
      '',
      'Null rules.',
      ''
    )
    const rejected = await createPolicy(nullRules)
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('must be a list')
    expect(dirFiles()).toEqual(before)
  })

  // ── N 组：经笔记本写（已有文件的编辑路径）
  const C1_V1 = simplePolicy({ name: 'c1-saved', description: 'v1', effect: 'ask' })
  const C1_V2 = simplePolicy({ name: 'c1-saved', description: 'v2', effect: 'deny', body: 'V2.' })

  it('PE-N1 经笔记覆写：磁盘逐字节等于新 text、list 反映新规则；反复 openNote 复用同一条隐藏会话', async () => {
    expect(await createPolicy(C1_V1)).toEqual({ success: true, name: 'c1-saved' })
    expect(await policyNoteWrite('c1-saved.md', C1_V2)).toEqual({ ok: true })
    expect(readPolicyFile('c1-saved.md')).toBe(C1_V2)

    const row = (await rowsFor('c1-saved'))[0]
    expect(row.description).toBe('v2')
    expect(row.rules.map((r) => r.effect)).toEqual(['deny'])
    expect(row.body).toBe('V2.')

    const first = await openRegistryNote(app.main, 'policy', 'c1-saved.md')
    expect(first).toMatchObject({
      ok: true,
      projectId: REGISTRY_NOTE_PROJECT_IDS.policy,
      notebookPath: 'c1-saved.md',
      workingDirectory: policiesDir()
    })
    // 一份文件至多一条会话：再开还是它（noteWrite 开过的那一条也是它）
    expect(await openRegistryNote(app.main, 'policy', 'c1-saved.md')).toEqual(first)
  })

  it('PE-N2 经笔记写进非法内容：不拒绝、照原样落盘 —— 进 listInvalid（带解析器原因），list 里没有它', async () => {
    const invalid = invalidPolicy('c1-saved')
    expect(await policyNoteWrite('c1-saved.md', invalid)).toEqual({ ok: true })
    expect(readPolicyFile('c1-saved.md')).toBe(invalid)

    const entry = (await listInvalid()).find((f) => f.fileName === 'c1-saved.md')
    // 拒绝原因是解析器原文 —— 它就是「这份文件为何不生效」的答案
    expect(entry?.error).toContain('unknown rule key')
    expect(entry?.error).toContain('rejected')
    expect((await listPolicies()).some((p) => p.name === 'c1-saved')).toBe(false)
  })

  const RENAME_V1 = simplePolicy({ name: 'rename-src', description: 'before rename' })
  const RENAME_V2 = simplePolicy({ name: 'rename-dst', description: 'after rename' })

  it('PE-N3 改名以 frontmatter name 为准：文件路径不变，旧名查不到、新名回吐新原文', async () => {
    // 文件名与 name 刻意不一致，改名后文件名也不会跟着变
    writePolicyFile('rename-me.md', RENAME_V1)
    expect(await policyNoteWrite('rename-me.md', RENAME_V2)).toEqual({ ok: true })

    expect(hasPolicyFile('rename-me.md')).toBe(true)
    expect(hasPolicyFile('rename-dst.md')).toBe(false)
    expect(readPolicyFile('rename-me.md')).toBe(RENAME_V2)

    const list = await listPolicies()
    expect(list.some((p) => p.name === 'rename-src')).toBe(false)
    expect(list.find((p) => p.name === 'rename-dst')!.basePath).toBe(
      join(policiesDir(), 'rename-me.md')
    )
    expect(await getSource('rename-src', 'user')).toEqual({
      error: 'Policy "rename-src" not found'
    })
    expect(await getSource('rename-dst', 'user')).toEqual({ text: RENAME_V2 })
  })

  it('PE-N4 改名撞另一份用户策略：照写不拒绝，被撞的文件不动；该名字注册表只收一份，两份都不算非法', async () => {
    const collide = simplePolicy({ name: 'b1-created', description: 'collide' })
    expect(await policyNoteWrite('rename-me.md', collide)).toEqual({ ok: true })
    expect(readPolicyFile('rename-me.md')).toBe(collide)
    // 被撞的那一份没被动过
    expect(readPolicyFile('b1-created.md')).toBe(B1_TEXT)
    // 同名用户文件只收一份（收哪份取决于 readdir 顺序 —— 刻意不断言），也不进「无法解析」
    expect((await rowsFor('b1-created')).filter((p) => p.source === 'user')).toHaveLength(1)
    expect((await listInvalid()).map((f) => f.fileName)).not.toContain('rename-me.md')

    // 还原成 rename-dst，后续用例从这里接着改
    expect(await policyNoteWrite('rename-me.md', RENAME_V2)).toEqual({ ok: true })
    expect((await rowsFor('rename-dst'))[0]?.basePath).toBe(join(policiesDir(), 'rename-me.md'))
  })

  it('PE-N5 改名撞内置名 → 覆盖（有意设计）：用户行指向 rename-me.md，该内置转 overridden', async () => {
    const text = simplePolicy({ name: 'git-safety', description: 'e2e renamed onto builtin' })
    expect(await policyNoteWrite('rename-me.md', text)).toEqual({ ok: true })
    expect(readPolicyFile('rename-me.md')).toBe(text)

    const rows = await rowsFor('git-safety')
    expect(rows.find((p) => p.source === 'user')!.basePath).toBe(
      join(policiesDir(), 'rename-me.md')
    )
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)
  })

  it('PE-N6 把这份覆盖写坏：它立即失去遮蔽效力，内置 git-safety 恢复生效（安全语义），文件进 listInvalid', async () => {
    expect(await policyNoteWrite('rename-me.md', invalidPolicy('git-safety'))).toEqual({
      ok: true
    })
    const rows = await rowsFor('git-safety')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()
    // 本组到此把 rename-me.md 留成非法文件 —— 后面数「无法解析」行时算上它
    expect((await listInvalid()).map((f) => f.fileName)).toContain('rename-me.md')
  })

  // ── D 组：覆盖副本全链路 / 删除 / 非法不遮蔽
  it('PE-D1 覆盖副本全链路：getSource(builtin) → create → 用户行与内置逐字段相等 → delete 恢复内置', async () => {
    const builtin = (await rowsFor('protect-credentials'))[0]
    expect(builtin.source).toBe('builtin')
    expect(builtin.overridden).toBeFalsy()

    const source = await getSource('protect-credentials', 'builtin')
    expect(await createPolicy((source as { text: string }).text)).toEqual({
      success: true,
      name: 'protect-credentials'
    })

    const rows = await rowsFor('protect-credentials')
    expect(rows).toHaveLength(2)
    const user = rows.find((p) => p.source === 'user')!
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)
    // 副本不改变安全语义：规则/作用域/lets/人读面整体快照相等
    const face = (p: PolicyItem): Record<string, unknown> => ({
      rules: p.rules,
      scope: p.scope,
      lets: p.lets,
      description: p.description,
      body: p.body
    })
    expect(face(user)).toEqual(face(builtin))

    expect(await deletePolicy('protect-credentials')).toEqual({ success: true })
    const restored = await rowsFor('protect-credentials')
    expect(restored).toHaveLength(1)
    expect(restored[0].source).toBe('builtin')
    expect(restored[0].overridden).toBeFalsy()
    expect(hasPolicyFile('protect-credentials.md')).toBe(false)
  })

  it('PE-D2 delete 不存在名 / 没有覆盖副本的内置名 → 均 not found', async () => {
    expect(await deletePolicy('ghost-policy')).toEqual({
      success: false,
      error: 'Policy "ghost-policy" not found'
    })
    expect(await deletePolicy('ask-on-write')).toEqual({
      success: false,
      error: 'Policy "ask-on-write" not found'
    })
    expect(await rowsFor('ask-on-write')).toHaveLength(1)
  })

  it('PE-D3 非法文件不遮蔽内置；随后同名合法新建落 -1 后缀，坏文件原样保留', async () => {
    const bad = mdText(
      '---',
      'shuvix: policy v1',
      'name: ask-on-command',
      'shuvix-policy-rules:',
      '  - effect: nonsense',
      '    subject.kind: [agent]',
      '---',
      '',
      'Broken override.',
      ''
    )
    writePolicyFile('ask-on-command.md', bad)
    let rows = await rowsFor('ask-on-command')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()

    // 修复的另一种走法：新建一份同 name 的合法策略
    const good = simplePolicy({ name: 'ask-on-command', description: 'e2e repaired override' })
    expect(await createPolicy(good)).toEqual({ success: true, name: 'ask-on-command' })
    expect(readPolicyFile('ask-on-command.md')).toBe(bad)
    expect(readPolicyFile('ask-on-command-1.md')).toBe(good)

    rows = await rowsFor('ask-on-command')
    expect(rows).toHaveLength(2)
    expect(rows.find((p) => p.source === 'user')!.description).toBe('e2e repaired override')
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)
  })

  // ── E 组：落盘即生效
  it('PE-E1 落盘即生效：user 主体的 deny 策略立刻拦下 UI 写入，删除后立刻恢复', async () => {
    const projDir = join(app.home, 'proj-policy-live')
    mkdirSync(projDir, { recursive: true })
    const project = await createProject(app.main, { name: 'PolicyLive', path: projDir })
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'policy-live', projectId: project.id })}).then((s) => s.id)`
    )
    const guarded = join(projDir, 'guarded.md')
    const write = (): Promise<{ ok: boolean; error?: string }> =>
      app.main.eval(
        `window.api.files.write(${JSON.stringify({ sessionId: sid, path: guarded, content: 'hello' })})`
      )

    expect(await write()).toEqual({ ok: true })

    // UI 写入以 user 主体求值：内置防护只限定 agent，要拦住它必须自己写一条
    const guard = mdText(
      '---',
      'shuvix: policy v1',
      'name: e2e-ui-write-guard',
      'description: deny UI writes to guarded.md',
      'shuvix-policy-scope:',
      '  subject.kind: [user]',
      '  object.type: [path]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    action: [write]',
      `    match: "object.path.endsWith('guarded.md')"`,
      '---',
      '',
      'Live effect check.',
      ''
    )
    expect(await createPolicy(guard)).toEqual({ success: true, name: 'e2e-ui-write-guard' })
    // 无缓存、无失效通知：下一次判定就现扫到这份文件
    expect((await write()).ok).toBe(false)

    expect(await deletePolicy('e2e-ui-write-guard')).toEqual({ success: true })
    expect(await write()).toEqual({ ok: true })
  })
})

describe('policy 编辑 UI —— 设置页「安全策略」tab', () => {
  /** 设置窗口只开一次（openSettings 对已存在的窗口只聚焦，不会切 tab） */
  let sharedPane: PoliciesPane | undefined
  let note: RegistryNotePane
  const getPane = async (): Promise<PoliciesPane> => {
    if (!sharedPane) {
      const settings = await app.openSettings('policies')
      sharedPane = await policiesPane(settings)
      note = registryNotePane(settings)
      // 列表只在挂载时加载一次：上面 IPC 组写入的策略文件需重扫才可见
      await sharedPane.refresh()
    }
    return sharedPane
  }

  it('PE-U1 详情按来源分化：用户策略就是它的笔记（可编辑、头部只有删除）；未覆盖内置只读给覆盖副本；被遮蔽内置只读、无动作', async () => {
    const pane = await getPane()
    const list = await listPolicies()
    const askOnRead = list.find((p) => p.name === 'ask-on-read' && p.source === 'builtin')!
    const shadowedDb = list.find((p) => p.name === 'ask-on-database' && p.source === 'builtin')!
    expect(shadowedDb.overridden).toBe(true)

    // 用户策略（覆盖副本未写 displayName → 行标题即 name，与内置的本地化显示名可区分）
    await pane.selectRow('ask-on-database', 'user')
    expect(await pane.noteFile()).toBe('ask-on-database.md')
    const user = await pane.inputs()
    expect(user.count).toBeGreaterThan(0)
    expect(user.disabled).toBe(false)
    expect(await pane.headerIcons()).toEqual({ trash: true, save: false, copy: false })

    // 未被覆盖的内置：随包发布不可直接改（控件照常渲染、全部禁用），只给覆盖副本入口
    await pane.selectRow(askOnRead.displayName, 'builtin')
    expect(await pane.noteFile()).toBe('')
    const builtin = await pane.inputs()
    expect(builtin.count).toBeGreaterThan(0)
    expect(builtin.disabled).toBe(true)
    expect(await pane.headerIcons()).toEqual({ trash: false, save: false, copy: true })

    // 被遮蔽的内置：不生效也不可编辑（生效的是同名用户文件），连覆盖入口都没有
    await pane.selectRow(shadowedDb.displayName, 'builtin')
    expect(await pane.noteFile()).toBe('')
    expect((await pane.inputs()).disabled).toBe(true)
    expect(await pane.headerIcons()).toEqual({ trash: false, save: false, copy: false })
  })

  it('PE-U2 「新建」→ my-policy.md 落盘成为用户策略，选中并打开它的笔记（policy 属性卡、校验通过）', async () => {
    const pane = await getPane()
    expect(await pane.clickNew()).toBe('my-policy.md')
    expect(hasPolicyFile('my-policy.md')).toBe(true)
    expect((await rowsFor('my-policy'))[0].source).toBe('user')
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'my-policy' && r.selected),
      'new policy row selected'
    )
    expect(await pane.noteFile()).toBe('my-policy.md')
    expect(await note.cardBadge()).toBe('ShuviX policy · v1')
    // 解析器级校验异步回传（合法模板 → is-ok，不带告警）
    await note.waitStatus('ok')
  })

  it('PE-U3 再「新建」一次 → 名字自动避让成 my-policy-2（不撞重名），选中，没有错误框', async () => {
    const pane = await getPane()
    expect(await pane.clickNew()).toBe('my-policy-2.md')
    expect(readPolicyFile('my-policy-2.md')).toContain('name: my-policy-2\n')
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'my-policy-2' && r.selected),
      'second new policy row selected'
    )
    expect(await pane.reasonText()).toBe('')
  })

  it('PE-F4 删除确认：弹窗描述含策略名；删覆盖副本后同名内置恢复且被选中', async () => {
    const pane = await getPane()

    // ① 普通用户策略：确认后行消失、文件没了、详情离开它的笔记（不会被自动保存写回来）
    await pane.selectRow('my-policy')
    await pane.clickDelete()
    const dialog = await pane.confirmDialog()
    expect(dialog.open).toBe(true)
    expect(dialog.description).toContain('my-policy')
    await pane.confirmDialogConfirm()
    await until(
      async () => !(await pane.rows()).some((r) => r.name === 'my-policy'),
      'my-policy row gone'
    )
    expect(hasPolicyFile('my-policy.md')).toBe(false)
    await until(async () => (await pane.noteFile()) === '', 'note left after delete')
    await sleep(700)
    expect(hasPolicyFile('my-policy.md')).toBe(false)

    // ② 覆盖副本：删掉后同名内置恢复生效并被选中（不该把选中态甩回首项）
    const shadowedDb = (await listPolicies()).find(
      (p) => p.name === 'ask-on-database' && p.source === 'builtin'
    )!
    await pane.selectRow('ask-on-database', 'user')
    await pane.clickDelete()
    await pane.confirmDialogConfirm()

    await until(async () => {
      const rows = await pane.rows()
      const restored = rows.filter((r) => r.name === shadowedDb.displayName)
      return (
        !rows.some((r) => r.name === 'ask-on-database') &&
        restored.length === 1 &&
        restored[0].selected
      )
    }, 'restored builtin selected')
    const restored = (await pane.rows()).filter((r) => r.name === shadowedDb.displayName)
    expect(restored[0].overriddenBadge).toBe(false)
    expect(await pane.noteFile()).toBe('')
  })

  it('PE-F5 详情即笔记：只打开不改动 → 零写盘（无隐式重序列化）', async () => {
    const pane = await getPane()
    const before = readPolicyFile('b1-created.md')

    await pane.selectRow('b1-created')
    expect(await pane.noteFile()).toBe('b1-created.md')
    await note.waitCard()
    // 跨过自动保存的防抖窗口仍逐字节不变
    await expectFileUnchanged(join(policiesDir(), 'b1-created.md'), before, 1000)
  })

  it('PE-U4 内置「创建覆盖副本」→ 同名用户文件逐字节等于内置等价 md、选中它的笔记；内置行划线带覆盖徽标（收尾删掉）', async () => {
    const pane = await getPane()
    const builtin = (await rowsFor('protect-credentials')).find((p) => p.source === 'builtin')!
    const source = (await getSource('protect-credentials', 'builtin')) as { text: string }

    await pane.selectRow(builtin.displayName, 'builtin')
    expect(await pane.clickCreateOverride()).toBe('protect-credentials.md')
    expect(readPolicyFile('protect-credentials.md')).toBe(source.text)

    const overrideLabel = (await rowsFor('protect-credentials')).find(
      (p) => p.source === 'user'
    )!.displayName
    await until(async () => {
      const rows = await pane.rows()
      return (
        rows.some((r) => r.name === overrideLabel && !r.builtin && r.selected) &&
        rows.some(
          (r) => r.name === builtin.displayName && r.builtin && r.struck && r.overriddenBadge
        )
      )
    }, 'override row selected, builtin row struck')
    expect(await pane.noteFile()).toBe('protect-credentials.md')

    // 收尾：删掉覆盖副本，内置恢复
    await pane.clickDelete()
    await pane.confirmDialogConfirm()
    await until(() => !hasPolicyFile('protect-credentials.md'), 'override copy deleted')
    await until(async () => (await rowsFor('protect-credentials')).length === 1, 'builtin restored')
  })

  it('PE-U5 在卡上改描述、再改名：每次只动那一行落盘；改名后列表换名、选中项不跳、开着的仍是同一份笔记', async () => {
    const pane = await getPane()
    await pane.selectRow('b1-created')
    await note.mark()
    const path = join(policiesDir(), 'b1-created.md')

    let before = readPolicyFile('b1-created.md')
    await note.commitField('description', 'edited in settings')
    expect(await waitFileWritten(path, before)).toBe(
      before.replace('description: created via ipc\n', 'description: edited in settings\n')
    )

    before = readPolicyFile('b1-created.md')
    await note.commitField('name', 'b1-renamed')
    expect(await waitFileWritten(path, before)).toBe(
      before.replace('name: b1-created\n', 'name: b1-renamed\n')
    )
    await until(async () => {
      const rows = await pane.rows()
      return (
        rows.some((r) => r.name === 'b1-renamed' && r.selected) &&
        !rows.some((r) => r.name === 'b1-created')
      )
    }, 'row renamed and still selected')
    expect(await note.isMarked()).toBe(true)
    expect(await pane.noteFile()).toBe('b1-created.md')
  })

  it('PE-U6 外部把它写坏 → 选中项翻成琥珀的「无法解析」行、正文重载、卡片横幅给原因，笔记不重开；写回合法版翻回来', async () => {
    const pane = await getPane()
    const valid = readPolicyFile('b1-created.md')
    writePolicyFile('b1-created.md', invalidPolicy('b1-renamed'))

    await until(
      async () => (await pane.selectedInvalid()) === 'b1-created.md',
      'invalid row selected'
    )
    expect(await pane.invalidRows()).toContain('b1-created.md')
    expect(await pane.headerTitle()).toBe('b1-created.md')
    await note.waitBody('Invalid body.')
    // 原因在笔记里属性卡的横幅上 —— 这个 tab 不另起原因框
    await until(
      async () => (await note.bannerText()).includes('unknown rule key'),
      'card banner shows the parser verdict'
    )
    expect(await pane.reasonText()).toBe('')
    expect(await note.isMarked()).toBe(true)

    writePolicyFile('b1-created.md', valid)
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'b1-renamed' && r.selected),
      'normal row selected again'
    )
    expect(await pane.selectedInvalid()).toBe('')
    expect(await note.isMarked()).toBe(true)
  })
})
