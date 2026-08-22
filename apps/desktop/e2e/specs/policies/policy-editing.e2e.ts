/**
 * 安全策略的**编辑链路**（policy IPC 的写路径 + 设置页编辑器 UI）。
 * 列表/详情的只读面在 policies.e2e.ts，这里不重复。
 *
 * 关注点是「文件即事实」这条契约在读写两侧都成立：
 *   - getSource 逐字节回吐用户文件（注释/键序/空行原样）——原文编辑模型的前提；
 *     内置策略无文件，回写出的等价 md 必须自身合法（否则「创建覆盖副本」一开局就是坏文件）；
 *   - create/save **非法一律拒绝写盘**且旧内容零损伤 —— 一份存在但非法的策略会被
 *     扫描静默跳过（不生效也不遮蔽内置），正是编辑器要消灭的失败模式；
 *   - 改名以 frontmatter `name` 为准、文件路径不变；撞用户重名拒绝、撞内置名放行（覆盖是有意设计）；
 *   - 落盘即生效（每次评估现扫目录，无缓存/无失效通知）。
 *
 * 断言优先走 IPC（window.api.policy.*）+ fs 直读；DOM 只在验证呈现时用且一律经 pages.ts。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { policiesPane, type PoliciesPane } from '../../harness/pages'
import { createProject } from '../../harness/seed'

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
/** 绕过 IPC 直接把文件丢进目录（构造非法/非常规文件名的素材） */
const writePolicyFile = (fileName: string, text: string): void => {
  mkdirSync(policiesDir(), { recursive: true })
  writeFileSync(join(policiesDir(), fileName), text, 'utf-8')
}

const listPolicies = (): Promise<PolicyItem[]> => app.main.eval('window.api.policy.list()')
const getSource = (name: string, source: 'builtin' | 'user'): Promise<SourceResult> =>
  app.main.eval(`window.api.policy.getSource(${JSON.stringify({ name, source })})`)
const createPolicy = (text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.policy.create(${JSON.stringify({ text })})`)
const savePolicy = (originalName: string, text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.policy.save(${JSON.stringify({ originalName, text })})`)
const deletePolicy = (name: string): Promise<WriteResult> =>
  app.main.eval(`window.api.policy.delete(${JSON.stringify({ name })})`)

const rowsFor = async (name: string): Promise<PolicyItem[]> =>
  (await listPolicies()).filter((p) => p.name === name)

describe('policy 编辑 IPC —— 取原文 / 新建 / 覆写 / 删除', () => {
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

  // ── A 组：getSource（编辑器的数据源）
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

  // ── C 组：save
  const C1_V1 = simplePolicy({ name: 'c1-saved', description: 'v1', effect: 'ask' })
  const C1_V2 = simplePolicy({ name: 'c1-saved', description: 'v2', effect: 'deny', body: 'V2.' })

  it('PE-C1 覆写成功：磁盘逐字节等于新 text，list 反映新规则', async () => {
    expect(await createPolicy(C1_V1)).toEqual({ success: true, name: 'c1-saved' })
    expect(await savePolicy('c1-saved', C1_V2)).toEqual({ success: true })
    expect(readPolicyFile('c1-saved.md')).toBe(C1_V2)

    const row = (await rowsFor('c1-saved'))[0]
    expect(row.description).toBe('v2')
    expect(row.rules.map((r) => r.effect)).toEqual(['deny'])
    expect(row.body).toBe('V2.')
  })

  it('PE-C2 非法覆写被拒且旧内容零损伤（磁盘逐字节不变、list 仍是旧规则）', async () => {
    const before = readPolicyFile('c1-saved.md')
    const result = await savePolicy('c1-saved', invalidPolicy('c1-saved'))
    expect(result.success).toBe(false)
    // 拒绝原因是解析器原文 —— 它就是「这份文件为何不生效」的答案
    expect(result.error).toContain('unknown rule key')
    expect(result.error).toContain('rejected')

    expect(readPolicyFile('c1-saved.md')).toBe(before)
    const row = (await rowsFor('c1-saved'))[0]
    expect(row.description).toBe('v2')
    expect(row.rules.map((r) => r.effect)).toEqual(['deny'])
  })

  const RENAME_V1 = simplePolicy({ name: 'rename-src', description: 'before rename' })
  const RENAME_V2 = simplePolicy({ name: 'rename-dst', description: 'after rename' })

  it('PE-C3 改名以 frontmatter name 为准：文件路径不变，旧名查不到、新名回吐新原文', async () => {
    // 文件名与 name 刻意不一致，改名后文件名也不会跟着变
    writePolicyFile('rename-me.md', RENAME_V1)
    expect(await savePolicy('rename-src', RENAME_V2)).toEqual({ success: true })

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

  it('PE-C4 改名撞另一份用户策略 → 拒绝，磁盘逐字节不变', async () => {
    const before = readPolicyFile('rename-me.md')
    const result = await savePolicy(
      'rename-dst',
      simplePolicy({ name: 'b1-created', description: 'collide' })
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
    expect(readPolicyFile('rename-me.md')).toBe(before)
    // 被撞的那一份也没被动过
    expect(readPolicyFile('b1-created.md')).toBe(B1_TEXT)
  })

  it('PE-C5 改名撞内置名 → 放行（覆盖是有意设计），该内置转 overridden', async () => {
    const text = simplePolicy({ name: 'git-safety', description: 'e2e renamed onto builtin' })
    expect(await savePolicy('rename-dst', text)).toEqual({ success: true })
    expect(readPolicyFile('rename-me.md')).toBe(text)

    const rows = await rowsFor('git-safety')
    expect(rows.find((p) => p.source === 'user')!.basePath).toBe(
      join(policiesDir(), 'rename-me.md')
    )
    expect(rows.find((p) => p.source === 'builtin')!.overridden).toBe(true)
  })

  it('PE-C6 originalName 不存在 → not found；对内置名直接 save（未先建覆盖副本）同样 not found', async () => {
    expect(await savePolicy('ghost-policy', simplePolicy({ name: 'ghost-policy' }))).toEqual({
      success: false,
      error: 'Policy "ghost-policy" not found'
    })
    // 内置策略无文件：必须先「创建覆盖副本」（create），save 无从定位
    expect(await savePolicy('ask-on-read', simplePolicy({ name: 'ask-on-read' }))).toEqual({
      success: false,
      error: 'Policy "ask-on-read" not found'
    })
    expect(hasPolicyFile('ask-on-read.md')).toBe(false)
    expect(await rowsFor('ask-on-read')).toHaveLength(1)
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

    // 编辑链路下的「修复」动作：新建一份同 name 的合法策略
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
  const getPane = async (): Promise<PoliciesPane> => {
    if (!sharedPane) {
      sharedPane = await policiesPane(await app.openSettings('policies'))
      // 列表只在挂载时加载一次：上面 IPC 组写入的策略文件需重扫才可见
      await sharedPane.refresh()
    }
    return sharedPane
  }

  it('PE-F1 详情即编辑器，按来源分化：用户可编辑（保存+删除）、未覆盖内置只读（覆盖副本）、被遮蔽内置只读无操作', async () => {
    const pane = await getPane()
    const list = await listPolicies()
    const askOnRead = list.find((p) => p.name === 'ask-on-read' && p.source === 'builtin')!
    const shadowedDb = list.find((p) => p.name === 'ask-on-database' && p.source === 'builtin')!
    expect(shadowedDb.overridden).toBe(true)

    // 用户策略（覆盖副本未写 displayName → 行标题即 name，与内置的本地化显示名可区分）
    await pane.selectRow('ask-on-database')
    const user = await pane.detail()
    // 详情就是可编辑的 LivePreview：文本字段是输入框且可用，操作 = 保存 + 删除（无「编辑」二次入口）
    expect(user.inputs).toBeGreaterThan(0)
    expect(user.inputsDisabled).toBe(false)
    expect(user.actionButtons).toBe(2)
    const userActions = await pane.detailActionTexts()
    expect(userActions.some((x) => /^(Save|保存)$/.test(x))).toBe(true)
    expect(userActions.some((x) => /^(Edit|编辑|編集)$/.test(x))).toBe(false)

    // 未被覆盖的内置：随包发布不可直接改，只给覆盖副本入口
    await pane.selectRow(askOnRead.displayName)
    const builtin = await pane.detail()
    // 只读不再靠「没有控件」体现，而是控件被禁用（形态与可编辑态一致）
    expect(builtin.inputs).toBeGreaterThan(0)
    expect(builtin.inputsDisabled).toBe(true)
    expect(builtin.actionButtons).toBe(1)
    expect(
      (await pane.detailActionTexts()).some((x) =>
        /^(Create override copy|创建覆盖副本|上書きコピーを作成)$/.test(x)
      )
    ).toBe(true)

    // 被遮蔽的内置：不生效也不可编辑（改它没有意义 —— 生效的是同名用户文件）
    await pane.selectRow(shadowedDb.displayName)
    const shadowed = await pane.detail()
    expect(shadowed.inputsDisabled).toBe(true)
    expect(shadowed.actionButtons).toBe(0)
  })

  it('PE-F2 「新建」→ 编辑器上屏（policy 属性卡 + 校验通过）→ 保存落盘并选中新行', async () => {
    const pane = await getPane()
    await pane.clickNew()

    const opened = await pane.editor()
    expect(opened.open).toBe(true)
    expect(opened.text).toContain('my-policy')
    // frontmatter 由属性卡接管：类型徽章 + 规则摘要行
    expect(opened.cardBadge).toBe('ShuviX policy · v1')
    expect(opened.cardRules).toBe(1)
    // 解析器级校验异步回传（合法模板 → is-ok，不带告警）
    await until(async () => (await pane.editor()).cardStatus === 'ok', 'policy card validated')

    await pane.save()
    expect((await pane.editor()).open).toBe(false)
    expect(hasPolicyFile('my-policy.md')).toBe(true)
    expect((await rowsFor('my-policy'))[0].source).toBe('user')

    const row = (await pane.rows()).find((r) => r.name === 'my-policy')
    expect(row?.selected).toBe(true)
  })

  it('PE-F3 保存失败 → 红色横幅显示原因，编辑器保持打开、列表不新增', async () => {
    const pane = await getPane()
    expect(hasPolicyFile('my-policy.md'), 'PE-F2 应已落盘 my-policy').toBe(true)
    const before = (await pane.rows()).length

    // 模板的 name 恒为 my-policy → 第二次直接保存必然撞重名
    await pane.clickNew()
    await pane.save()

    const state = await pane.editor()
    expect(state.open).toBe(true)
    expect(state.error).toContain('already exists')
    expect((await pane.rows()).length).toBe(before)

    await pane.cancelEdit()
  })

  it('PE-F4 删除确认：弹窗描述含策略名；删覆盖副本后同名内置恢复且被选中', async () => {
    const pane = await getPane()

    // ① 普通用户策略：确认后行消失
    await pane.selectRow('my-policy')
    await pane.clickDetailAction('delete')
    const dialog = await until(async () => {
      const d = await pane.confirmDialog()
      return d.open ? d : undefined
    }, 'delete confirm dialog')
    expect(dialog.description).toContain('my-policy')
    await pane.confirmDialogConfirm()
    expect((await pane.rows()).some((r) => r.name === 'my-policy')).toBe(false)
    expect(hasPolicyFile('my-policy.md')).toBe(false)

    // ② 覆盖副本：删掉后同名内置恢复生效并被选中（不该把选中态甩回首项）
    const shadowedDb = (await listPolicies()).find(
      (p) => p.name === 'ask-on-database' && p.source === 'builtin'
    )!
    await pane.selectRow('ask-on-database')
    await pane.clickDetailAction('delete')
    await until(async () => (await pane.confirmDialog()).open, 'override delete confirm dialog')
    await pane.confirmDialogConfirm()

    const rows = await pane.rows()
    expect(rows.some((r) => r.name === 'ask-on-database')).toBe(false)
    const restored = rows.filter((r) => r.name === shadowedDb.displayName)
    expect(restored).toHaveLength(1)
    expect(restored[0].overriddenBadge).toBe(false)
    expect(restored[0].selected).toBe(true)
  })

  it('PE-F5 详情即编辑器：只打开不改动 → 零写盘（无隐式重序列化）', async () => {
    const pane = await getPane()
    const before = readPolicyFile('b1-created.md')

    await pane.selectRow('b1-created')
    await until(async () => (await pane.detail()).inputs > 0, 'editable detail')
    await sleep(1000)

    // 统一后详情常态没有「取消」可言（同智能体页）：不点保存就不写盘
    expect(readPolicyFile('b1-created.md')).toBe(before)
  })
})
