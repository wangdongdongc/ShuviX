/**
 * 安全策略设置 tab 的后端契约（policy IPC 的列表面）：
 * policy.list 返回 7 份内置策略（规则齐全、description 本地化面就绪），
 * 用户在 ~/.shuvix/policies 放置同名 md 即覆盖内置（原内置带 overridden 仅展示）、
 * 新增名字则并列出现 —— 纯 md 驱动，每次 list 现扫，无需任何刷新通知。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { policiesPane, type PoliciesPane } from '../../harness/pages'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

type Conditions = Record<string, string[]>

interface PolicyRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  overridden?: boolean
  description: string
  ruleEffects: string[]
  /** 策略级共同条件（shuvix-policy-scope）—— AND 进本策略每条规则 */
  scope?: Conditions
  /** 各规则自身的结构化条件（与 scope 的合并发生在装配期） */
  ruleConditions: Array<Conditions | undefined>
  /** 缺省 match 在 CDP 传输边界上是 null，不是 undefined */
  ruleMatches: Array<string | null>
  body: string
}

const listPolicies = (): Promise<PolicyRow[]> =>
  app.main.eval<PolicyRow[]>(
    `(async () => {
      const list = await window.api.policy.list()
      return list.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        source: p.source,
        overridden: p.overridden,
        description: p.description,
        ruleEffects: p.rules.map((r) => r.effect),
        scope: p.scope,
        ruleConditions: p.rules.map((r) => r.conditions),
        // 缺省的 match 经 CDP returnByValue 的 JSON 序列化会变成 null（数组里的
        // undefined 不可表达）—— 显式归一，让断言写的是语义而不是传输产物
        ruleMatches: p.rules.map((r) => r.match ?? null),
        body: p.body
      }))
    })()`
  )

const policiesDir = (): string => join(app.home, '.shuvix', 'policies')

const writePolicy = (fileName: string, lines: string[]): void => {
  mkdirSync(policiesDir(), { recursive: true })
  writeFileSync(join(policiesDir(), fileName), lines.join('\n'), 'utf-8')
}

/** 设置窗口只开一次（openSettings 对已存在的窗口只聚焦，不会切 tab）—— UI 用例共用 */
let sharedPane: PoliciesPane | undefined
const getPane = async (): Promise<PoliciesPane> => {
  sharedPane ??= await policiesPane(await app.openSettings('policies'))
  return sharedPane
}

describe('policy IPC（列表与详情渲染）', () => {
  it('内置 13 份策略齐全，规则与人读面就绪；openFolder 通道存在', async () => {
    const list = await listPolicies()
    const builtins = list.filter((p) => p.source === 'builtin')
    // 字母序（断言前已 sort）—— 十道防护 + 两份 force-allow 层的会话授权
    expect(builtins.map((p) => p.name).sort()).toEqual([
      'ask-on-command',
      'ask-on-database',
      'ask-on-read',
      'ask-on-sub-session',
      'ask-on-write',
      'block-catastrophic-commands',
      'git-safety',
      'protect-bot-notes',
      'protect-credentials',
      'protect-system',
      'review-memory-writes',
      'session-auto-allow',
      'session-path-grants'
    ])
    // 每份都有规则与非空人读面（description + Rationale body）
    for (const p of builtins) {
      expect(p.ruleEffects.length, `${p.name} 无规则`).toBeGreaterThan(0)
      expect(p.description.length, `${p.name} 无 description`).toBeGreaterThan(0)
      expect(p.body.length, `${p.name} 无 body`).toBeGreaterThan(0)
    }
    // 关键 effect 形态（引擎评估的即这份内容）
    expect(builtins.find((p) => p.name === 'protect-credentials')!.ruleEffects).toEqual([
      'deny',
      'ask'
    ])
    expect(builtins.find((p) => p.name === 'ask-on-command')!.ruleEffects).toEqual(['ask'])
    // force-allow 是 md 可声明的 effect，经 IPC 原样送达（UI 据此渲染第四种徽章）
    expect(builtins.find((p) => p.name === 'session-auto-allow')!.ruleEffects).toEqual([
      'force-allow'
    ])
    expect(builtins.find((p) => p.name === 'session-path-grants')!.ruleEffects).toEqual([
      'force-allow',
      'force-allow'
    ])

    const hasOpenFolder = await app.main.eval<boolean>(
      `typeof window.api.policy.openFolder === 'function'`
    )
    expect(hasOpenFolder).toBe(true)
  })

  it('用户 md 同名覆盖内置（原内置 overridden 仅展示）；新名字并列新增', async () => {
    const dir = join(app.home, '.shuvix', 'policies')
    mkdirSync(dir, { recursive: true })
    // 同名覆盖 ask-on-write（改成只对 /tmp 下的写入设门）
    writeFileSync(
      join(dir, 'ask-on-write.md'),
      [
        '---',
        'shuvix: policy v1',
        'name: ask-on-write',
        'description: e2e override',
        'shuvix-policy-rules:',
        '  - effect: ask',
        '    subject.kind: [agent]',
        '    action: [write]',
        '    object.type: [path]',
        `    match: "inDir(object.path, '/tmp')"`,
        '---',
        'e2e override body'
      ].join('\n'),
      'utf-8'
    )
    // 新增自定义策略
    writeFileSync(
      join(dir, 'my-extra.md'),
      [
        '---',
        'shuvix: policy v1',
        'name: my-extra',
        'description: extra user policy',
        'shuvix-policy-rules:',
        '  - effect: deny',
        '    subject.kind: [agent]',
        '    action: [write]',
        '    object.type: [path]',
        `    match: "inDir(object.path, '/tmp/e2e-forbidden')"`,
        '---'
      ].join('\n'),
      'utf-8'
    )

    const list = await listPolicies()
    // 覆盖：user 版生效，builtin 版仅展示（overridden）
    const wb = list.filter((p) => p.name === 'ask-on-write')
    expect(wb.find((p) => p.source === 'user')?.description).toBe('e2e override')
    expect(wb.find((p) => p.source === 'builtin')?.overridden).toBe(true)
    // 新增并列出现
    expect(list.find((p) => p.name === 'my-extra')?.source).toBe('user')
    // 其余内置不受影响
    expect(
      list
        .filter((p) => p.source === 'builtin' && !p.overridden)
        .map((p) => p.name)
        .sort()
    ).toEqual([
      'ask-on-command',
      'ask-on-database',
      'ask-on-read',
      'ask-on-sub-session',
      'block-catastrophic-commands',
      'git-safety',
      'protect-bot-notes',
      'protect-credentials',
      'protect-system',
      'review-memory-writes',
      'session-auto-allow',
      'session-path-grants'
    ])
  })

  it('设置页 UI 冒烟：tab 可打开、显示名渲染、覆盖行删除线、内置详情给覆盖副本入口', async () => {
    // 列表行渲染的是 displayName（内置随系统语言本地化）——预期值经 IPC 取，不硬编码语言
    const list = await listPolicies()
    const shadowedWriteAsk = list.find(
      (p) => p.name === 'ask-on-write' && p.source === 'builtin' && p.overridden
    )!
    const protectCredentials = list.find(
      (p) => p.name === 'protect-credentials' && p.source === 'builtin'
    )!
    // 内置显示名已本地化（≠ kebab slug）；用户策略未写 displayName 时回退 name
    expect(shadowedWriteAsk.displayName).not.toBe('ask-on-write')
    expect(list.find((p) => p.name === 'my-extra')!.displayName).toBe('my-extra')

    const pane = await getPane()
    const rows = await pane.rows()
    // 前两个用例已写入：ask-on-write 覆盖（user 生效 + builtin 遮蔽）与 my-extra
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.some((r) => r.name === 'my-extra')).toBe(true)
    expect(
      rows.some((r) => r.name === shadowedWriteAsk.displayName && r.struck && r.overriddenBadge)
    ).toBe(true)

    await pane.selectRow(protectCredentials.displayName)
    const detail = await pane.detail()
    // 详情 = md 原文的 LivePreview（与智能体页统一）：属性卡渲染 frontmatter、正文即 Rationale
    expect(detail.cardBadge).toBe('ShuviX policy · v1')
    expect(detail.effectBadges).toBeGreaterThan(0) // 卡片规则摘要里的 effect 徽章
    expect(detail.hasRationale).toBe(true)
    // 内置随包发布只读：控件照常渲染（形态与可编辑态一致），靠禁用体现；操作只有「创建覆盖副本」
    expect(detail.inputs).toBeGreaterThan(0)
    expect(detail.actionButtons).toBe(1)
  })

  it('非法用户 md 跳过且不遮蔽内置同名策略（写坏文件不关掉内置保护）', async () => {
    const dir = join(app.home, '.shuvix', 'policies')
    mkdirSync(dir, { recursive: true })
    // effect 非法 → 整份文件判非法
    writeFileSync(
      join(dir, 'protect-credentials.md'),
      [
        '---',
        'shuvix: policy v1',
        'name: protect-credentials',
        'shuvix-policy-rules:',
        '  - effect: nonsense',
        '    subject.kind: [agent]',
        '---'
      ].join('\n'),
      'utf-8'
    )

    const list = await listPolicies()
    const pc = list.filter((p) => p.name === 'protect-credentials')
    // 内置仍生效（无 user 行、builtin 不带 overridden）
    expect(pc).toHaveLength(1)
    expect(pc[0].source).toBe('builtin')
    expect(pc[0].overridden).toBeFalsy()
    expect(pc[0].ruleEffects).toEqual(['deny', 'ask'])
  })

  it('E2E-C1 结构化条件与 scope 经 IPC 原样送达（内置十份的书写约定 + 用户 md 往返）', async () => {
    // 用户策略：scope 放身份标签，规则放 effect/action/match（与内置同一书写约定）
    writePolicy('scoped-extra.md', [
      '---',
      'shuvix: policy v1',
      'name: scoped-extra',
      'description: scope + structured conditions',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [path]',
      '  env.host: [desktop]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    action: [write]',
      `    match: "inDir(object.path, '/tmp/e2e-scoped')"`,
      '  - effect: ask',
      '    action: [read, write]',
      '---',
      'scoped body'
    ])

    const list = await listPolicies()
    const mine = list.find((p) => p.name === 'scoped-extra')!
    expect(mine.source).toBe('user')
    expect(mine.scope).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      'env.host': ['desktop']
    })
    // 规则只带自身写的条件（与 scope 的合并发生在装配期，不回写文件模型）
    expect(mine.ruleConditions).toEqual([{ action: ['write'] }, { action: ['read', 'write'] }])
    expect(mine.ruleMatches).toEqual(["inDir(object.path, '/tmp/e2e-scoped')", null])

    // 内置十份的当前书写约定：scope 只放 subject.kind / object.type / env.host，
    // 且每份都用 scope 限定 agent 主体（规则侧不重复声明这些身份标签）
    for (const p of list.filter((x) => x.source === 'builtin' && !x.overridden)) {
      const scopeKeys = Object.keys(p.scope ?? {})
      expect(scopeKeys, `${p.name} 的 scope 键`).toContain('subject.kind')
      expect(p.scope!['subject.kind'], `${p.name} 的主体守卫`).toEqual(['agent'])
      for (const key of scopeKeys) {
        expect(['subject.kind', 'object.type', 'env.host'], `${p.name} 的 scope 键`).toContain(key)
      }
      for (const conditions of p.ruleConditions) {
        for (const key of Object.keys(conditions ?? {})) {
          expect(['action'], `${p.name} 的规则条件键`).toContain(key)
        }
      }
    }
  })

  it('E2E-C2 结构化条件非法的用户 md 整份跳过，不遮蔽内置同名策略', async () => {
    // ① scope 与规则条件矛盾（死规则）；② 缺 subject.kind；③ scope 未知键
    writePolicy('git-safety.md', [
      '---',
      'name: git-safety',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  action: [read]',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    action: [write]',
      '---'
    ])
    writePolicy('ask-on-read.md', [
      '---',
      'name: ask-on-read',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    action: [read]',
      '---'
    ])
    writePolicy('bad-scope-key.md', [
      '---',
      'name: bad-scope-key',
      'shuvix-policy-scope:',
      '  object.kind: [path]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    subject.kind: [agent]',
      '---'
    ])

    const list = await listPolicies()
    for (const name of ['git-safety', 'ask-on-read']) {
      const rows = list.filter((p) => p.name === name)
      expect(rows, `${name} 应只剩内置一行`).toHaveLength(1)
      expect(rows[0].source).toBe('builtin')
      expect(rows[0].overridden).toBeFalsy()
      expect(rows[0].scope!['subject.kind']).toEqual(['agent'])
    }
    // 非法的新增策略同样不出现（整份拒绝，不半生效）
    expect(list.some((p) => p.name === 'bad-scope-key')).toBe(false)
  })

  it('E2E-C3 设置页渲染策略级 scope 段与规则行的结构化条件', async () => {
    const pane = await getPane()
    // 列表只在挂载时加载一次：前两个用例写入的策略文件需重扫才可见
    await pane.refresh()

    // 用户策略 scoped-extra（无 displayName → 行标题即 name）
    await pane.selectRow('scoped-extra')
    const detail = await pane.detail()
    expect(detail.hasScope).toBe(true)
    expect(detail.effectBadges).toBe(2)
    // 卡片的规则摘要把结构化条件与 match 并在同一行（· 分隔），比旧详情的分行更紧凑
    expect(detail.conditionLines[0]).toContain('action: write')
    expect(detail.conditionLines[0]).toContain("inDir(object.path, '/tmp/e2e-scoped')")
    expect(detail.conditionLines[1]).toBe('action: read, write')
    // 用户策略：详情即可编辑（保存 + 删除两个操作），文本字段是输入框
    expect(detail.actionButtons).toBe(2)
    expect(detail.inputs).toBeGreaterThan(0)

    // 内置策略同样渲染 scope 段（书写约定一致）
    const gitSafety = (await listPolicies()).find(
      (p) => p.name === 'git-safety' && p.source === 'builtin'
    )!
    await pane.selectRow(gitSafety.displayName)
    expect((await pane.detail()).hasScope).toBe(true)
  })

  it('CE-1 用户 md 写 effect: force-allow → 经 IPC 原样送达（source=user、effect=force-allow、match 原文）', async () => {
    writePolicy('my-force-allow.md', [
      '---',
      'shuvix: policy v1',
      'name: my-force-allow',
      'description: trust one directory without asking',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [path]',
      'shuvix-policy-rules:',
      '  - effect: force-allow',
      '    action: [read]',
      `    match: "inDir(object.path, '/tmp/e2e-grant')"`,
      '---',
      'force-allow body'
    ])

    const mine = (await listPolicies()).find((p) => p.name === 'my-force-allow')!
    expect(mine.source).toBe('user')
    // force-allow 是 md 的第四个 effect 值，用户策略无额外限制 —— 不被改写成 allow
    expect(mine.ruleEffects).toEqual(['force-allow'])
    expect(mine.ruleConditions).toEqual([{ action: ['read'] }])
    expect(mine.ruleMatches).toEqual(["inDir(object.path, '/tmp/e2e-grant')"])
    expect(mine.scope).toEqual({ 'subject.kind': ['agent'], 'object.type': ['path'] })
  })

  it('CE-2 effect 大小写错值（Consent）的同名覆盖整份非法 → 只剩内置一行，且仍是 force-allow', async () => {
    writePolicy('session-auto-allow.md', [
      '---',
      'shuvix: policy v1',
      'name: session-auto-allow',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      'shuvix-policy-rules:',
      '  - effect: Consent',
      '    match: vars.autoAllow',
      '---'
    ])

    const rows = (await listPolicies()).filter((p) => p.name === 'session-auto-allow')
    // 非法用户文件不遮蔽内置：免询问开关不会因为写错一个大写字母而失去含义
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()
    expect(rows[0].ruleEffects).toEqual(['force-allow'])
  })

  it('CE-3 设置页渲染 force-allow 效果（卡片按 md 原文展示 effect，不做本地化）', async () => {
    const pane = await getPane()
    await pane.refresh()

    const autoAllow = (await listPolicies()).find(
      (p) => p.name === 'session-auto-allow' && p.source === 'builtin'
    )!
    await pane.selectRow(autoAllow.displayName)

    const detail = await pane.detail()
    // 详情统一为 md 原文的 LivePreview 后，effect 徽章展示的是文件里的原词
    // （所见即引擎所评估）——不再经 i18n，故这里钉原值而非本地化文案。
    // 这一条仍守着「force-allow 这个较新的 effect 能一路流到 UI」。
    expect(detail.effectBadgeTexts).toEqual(['force-allow'])
  })
})
