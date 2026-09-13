/**
 * policyService 的写路径单测 —— 设置页「安全策略」编辑链路的落盘语义。
 *
 * 关注点是**文件系统层的取舍**（解析语义归 policyFile.test.ts）：
 *   - 文件名由 frontmatter `name` 净化派生 —— 净化不到位会写出扫描恰好跳过的文件
 *     （点开头/路径分隔符），即「创建成功但列表里没有」这种最难排查的失败；
 *   - 冲突后缀循环让净化到同一基名的不同 name 各得一份文件；
 *   - 非法文件不被 create 覆盖（它虽不生效，仍是用户的原始素材）；
 *   - 拒绝原因原样回传（解析器的人读原因就是「文件为何不生效」的答案）。
 *
 * mock 面照 askPolicy.test.ts 的惯例：electron 只需 shell、paths 指向临时目录、logger 静音。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import i18next from 'i18next'
import { assembleRules, type SecurityHostProvider } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }))
vi.mock('../../utils/paths', () => ({ getDefaultPoliciesDir: () => state.dir }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { policyService, type PolicyListItem } from '../policyService'

/** YAML 单引号标量（内部单引号成对转义）—— name 里带 `:`/`"`/emoji 时照样是一个标量 */
const yamlStr = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** 最小合法策略 md（frontmatter name 为准；文件名只是默认值） */
const policyMd = (name: string, extra: string[] = []): string =>
  [
    '---',
    'shuvix: policy v1',
    `name: ${yamlStr(name)}`,
    ...extra,
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '---',
    '',
    `Rationale of ${name}.`,
    ''
  ].join('\n')

/** 规则带未知键 note → 规则级细因 + 文件级 reject 两条 warn */
const INVALID_MD = [
  '---',
  'shuvix: policy v1',
  'name: foo',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    subject.kind: [agent]',
  '    note: x',
  '---',
  '',
  'Invalid policy body.',
  ''
].join('\n')

const files = (): string[] => (existsSync(state.dir) ? readdirSync(state.dir).sort() : [])

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'shuvix-policysvc-'))
})
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

describe('policyService.createPolicy — 文件名净化', () => {
  it('PU-1 净化矩阵：路径分隔/非法字符→`-`、前导点去除、全点回退 policy，且不越出策略目录', () => {
    // 关键是 `.hidden`：不去前导点会写出点开头文件，而扫描恰好跳过点开头 = 创建即消失
    const cases: Array<[string, string]> = [
      ['a/b', 'a-b.md'],
      ['a:b*?"<>|', 'a-b------.md'],
      ['.hidden', 'hidden.md'],
      ['...', 'policy.md'],
      ['../../evil', '-..-evil.md']
    ]
    for (const [name, fileName] of cases) {
      const r = policyService.createPolicy(policyMd(name))
      // name 本身不被净化改写（净化只作用于文件名）
      expect({ name, r }).toEqual({ name, r: { success: true, name } })
      const filePath = join(state.dir, fileName)
      expect({ name, exists: existsSync(filePath) }).toEqual({ name, exists: true })
      // 路径穿越防线：`../../evil` 也必须落在策略目录内
      expect(dirname(filePath)).toBe(state.dir)
    }
    expect(files()).toEqual(['-..-evil.md', 'a-b------.md', 'a-b.md', 'hidden.md', 'policy.md'])
  })

  it('PU-2 冲突后缀循环：净化到同一基名的三个 name → a-b.md / a-b-1.md / a-b-2.md，三条并存', () => {
    for (const name of ['a/b', 'a:b', 'a?b']) {
      expect(policyService.createPolicy(policyMd(name)).success).toBe(true)
    }
    expect(files()).toEqual(['a-b-1.md', 'a-b-2.md', 'a-b.md'])

    // 标识是 frontmatter name —— 三份文件对应三个互异的策略
    const names = policyService
      .listForSettings()
      .filter((p) => p.source === 'user')
      .map((p) => p.name)
      .sort()
    expect(names).toEqual(['a/b', 'a:b', 'a?b'])
  })

  it('PU-3 非法文件不被 create 覆盖：同名新建落 -1 后缀，坏文件逐字节原样保留', () => {
    writeFileSync(join(state.dir, 'foo.md'), INVALID_MD, 'utf-8')
    // 非法文件被扫描跳过 → 不构成重名，但它的文件名仍被占用
    const r = policyService.createPolicy(policyMd('foo'))
    expect(r).toEqual({ success: true, name: 'foo' })
    expect(files()).toEqual(['foo-1.md', 'foo.md'])
    expect(readFileSync(join(state.dir, 'foo.md'), 'utf-8')).toBe(INVALID_MD)
  })

  it('PU-6 非 ASCII name（中文 / emoji）不被净化改写：落盘文件名与 name 一致且可回读', () => {
    for (const name of ['安全策略', '🔒-lock']) {
      expect(policyService.createPolicy(policyMd(name))).toEqual({ success: true, name })
      expect(policyService.getSource(name, 'user')).toEqual({ text: policyMd(name) })
    }
    expect(files()).toEqual(['🔒-lock.md', '安全策略.md'].sort())
  })

  it('PU-7 超长 name（>255 字节）→ 写盘失败被捕获，目录不留半截文件', () => {
    const longName = 'a'.repeat(300)
    const r = policyService.createPolicy(policyMd(longName))
    expect(r.success).toBe(false)
    expect(r.error, '写盘异常原因应原样回传').toBeTruthy()
    expect(files()).toEqual([])
  })
})

describe('policyService — 拒绝原因与错误文案', () => {
  it('PU-4 parseForWrite 原因聚合：规则级细因 + 文件级 rejected 两行，以 \\n join 原样回传', () => {
    const r = policyService.createPolicy(INVALID_MD)
    expect(r.success).toBe(false)
    const lines = (r.error ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("unknown rule key 'note'")
    expect(lines[0]).toContain('rule #0')
    expect(lines[1]).toContain('rule #0 is invalid')
    expect(lines[1]).toContain('the whole file is rejected')
    // 非法一律拒绝写盘
    expect(files()).toEqual([])
  })

  it('PU-5 错误文案矩阵：delete / getSource(user) 报 Policy "X" not found；getSource(builtin) 报 Builtin', () => {
    expect(policyService.deletePolicy('ghost')).toEqual({
      success: false,
      error: 'Policy "ghost" not found'
    })
    expect(policyService.getSource('ghost', 'user')).toEqual({
      error: 'Policy "ghost" not found'
    })
    expect(policyService.getSource('ghost', 'builtin')).toEqual({
      error: 'Builtin policy "ghost" not found'
    })
    // 只有内置的名字经 user 源查同样 not found（不得回吐内置文本）
    expect(policyService.getSource('ask-on-write', 'user')).toEqual({
      error: 'Policy "ask-on-write" not found'
    })
  })
})

/**
 * 同名的几份（PU-SH*）：设置页全量列表（listForSettings）与评估侧装配（assembleRules →
 * mergePolicyFiles）经同一个 resolvePolicyFiles、喂同一份候选 —— 列表上标着生效的，就是真正在评估的
 * 那份。provider 照 toolContext.makeDesktopSecurityProvider 的形状搭（getUserPolicies 直连
 * policyService、getLanguage 取 i18next）；只比判定字段（source.kind / effect / matchExpr），
 * 它们与界面语言无关。
 *
 *   ask-on-write.md  deny  /canon       —— 覆盖内置 ask-on-write，文件名就是名字
 *   a.md             ask   /copy        —— 同名第二份，更短、码点序也更前
 *   gate.md          deny  /gate-canon  —— 纯用户同名两份
 *   g.md             ask   /gate-copy
 *   broken.md        解析不过、写着 name: ask-on-write（不进候选，遮蔽不了任何东西）
 */
describe('policyService —— 同名的几份：设置页列表与评估是同一次裁决', () => {
  /** 一条 path 写入规则的策略：scope 限定 agent + path，规则只看 match */
  const pathPolicy = (name: string, effect: 'ask' | 'deny', dir: string): string =>
    [
      '---',
      'shuvix: policy v1',
      `name: ${yamlStr(name)}`,
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [path]',
      'shuvix-policy-rules:',
      `  - effect: ${effect}`,
      '    action: [write]',
      `    match: "inDir(object.path, '${dir}')"`,
      '---',
      '',
      `Rationale of ${name} (${dir}).`,
      ''
    ].join('\n')

  const CANON = pathPolicy('ask-on-write', 'deny', '/canon')
  const COPY = pathPolicy('ask-on-write', 'ask', '/copy')

  function seedShadowFixture(): void {
    const put = (fileName: string, text: string): void =>
      writeFileSync(join(state.dir, fileName), text, 'utf-8')
    put('ask-on-write.md', CANON)
    put('a.md', COPY)
    put('gate.md', pathPolicy('gate', 'deny', '/gate-canon'))
    put('g.md', pathPolicy('gate', 'ask', '/gate-copy'))
    put('broken.md', INVALID_MD.replace('name: foo', 'name: ask-on-write'))
  }

  /** 桌面 provider 的最小同形（变量表给全，免得内置 lets 求值告警） */
  const provider = (): SecurityHostProvider => ({
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: '/ws',
      toolResultsBase: '/tool-results',
      skillsDirs: [],
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: '/home/u',
      botsDir: '/home/u/.shuvix/bots',
      systemDirs: []
    }),
    getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
    getLanguage: () => i18next.language,
    getUserPolicies: () => policyService.getUserPolicies()
  })

  type Decision = [kind: string, effect: string, matchExpr: string | undefined]

  /** 评估侧：这个名字装配出来的规则的判定字段 */
  const assembledFor = (name: string): Decision[] =>
    assembleRules(provider())
      .filter((rule) => rule.source.policy === name)
      .map((rule): Decision => [rule.source.kind, rule.effect, rule.matchExpr])

  /** md 的 force-* 在装配产物里归一为三态 effect（强度另记在 tier）—— 列表侧照同一口径投影 */
  const DECIDED: Record<string, string> = { 'force-ask': 'ask', 'force-allow': 'allow' }

  /** 列表侧：这个名字唯一生效的那一行的规则，投成同一形状 */
  const winningRowFor = (rows: PolicyListItem[], name: string): Decision[] => {
    const active = rows.filter((row) => row.name === name && !row.overridden)
    expect(active, name).toHaveLength(1)
    return active[0].rules.map(
      (rule): Decision => [active[0].source, DECIDED[rule.effect] ?? rule.effect, rule.match]
    )
  }

  /** 设置页里这个名字的行：[来源, 文件名（内置为空串）, 是否被覆盖, 被谁覆盖] */
  const rowsNamed = (name: string): Array<[string, string, boolean, string | undefined]> =>
    policyService
      .listForSettings()
      .filter((row) => row.name === name)
      .map((row) => [
        row.source,
        row.basePath ? basename(row.basePath) : '',
        !!row.overridden,
        row.overriddenBy
      ])

  it('PU-SH1 getUserPolicies 交出同名的全部几份（带文件名）；每个名字恰一行生效 —— 文件名即名字的那份；评估里的规则正是生效那一行的规则；列表行不外带 fileName', () => {
    seedShadowFixture()

    expect(
      policyService
        .getUserPolicies()
        .map((p) => [p.name, p.fileName])
        .sort()
    ).toEqual([
      ['ask-on-write', 'a.md'],
      ['ask-on-write', 'ask-on-write.md'],
      ['gate', 'g.md'],
      ['gate', 'gate.md']
    ])
    expect(policyService.listInvalid().map((f) => f.fileName)).toEqual(['broken.md'])

    const rows = policyService.listForSettings()
    const names = [...new Set(rows.map((row) => row.name))]
    for (const name of names) {
      expect(
        rows.filter((row) => row.name === name && !row.overridden),
        name
      ).toHaveLength(1)
    }
    // 排序口径（compareRows）：名字 → 生效在前 → basePath；内置的 basePath 是空串，排在输掉的用户文件前
    expect(rowsNamed('ask-on-write')).toEqual([
      ['user', 'ask-on-write.md', false, undefined],
      ['builtin', '', true, 'ask-on-write.md'],
      ['user', 'a.md', true, 'ask-on-write.md']
    ])
    expect(rowsNamed('gate')).toEqual([
      ['user', 'gate.md', false, undefined],
      ['user', 'g.md', true, 'gate.md']
    ])

    // 每个名字（没被碰过的内置也算）：评估里的规则 == 列表上生效那一行的规则
    for (const name of names) {
      expect(assembledFor(name), name).toEqual(winningRowFor(rows, name))
    }
    expect(assembledFor('ask-on-write')).toEqual([['user', 'deny', "inDir(object.path, '/canon')"]])
    expect(assembledFor('gate')).toEqual([['user', 'deny', "inDir(object.path, '/gate-canon')"]])

    // getUserPolicies 附带的 fileName 只给同名裁决用，不过 IPC（列表项的文件身份是 basePath）
    expect(rows.filter((row) => Object.prototype.hasOwnProperty.call(row, 'fileName'))).toEqual([])
  })

  it('PU-SH2 按名读 / 删只碰生效的那份（另一份接班）；按文件名删输的那份不动胜者；删到只剩内置，内置恢复生效', () => {
    seedShadowFixture()
    expect(policyService.getSource('ask-on-write', 'user')).toEqual({ text: CANON })

    // 按名删：删的是 ask-on-write.md —— a.md 接班，评估跟着换成它的规则，内置转而被 a.md 压着
    expect(policyService.deletePolicy('ask-on-write')).toEqual({ success: true })
    expect(files()).toEqual(['a.md', 'broken.md', 'g.md', 'gate.md'])
    expect(assembledFor('ask-on-write')).toEqual([['user', 'ask', "inDir(object.path, '/copy')"]])
    expect(rowsNamed('ask-on-write')).toEqual([
      ['user', 'a.md', false, undefined],
      ['builtin', '', true, 'a.md']
    ])
    expect(policyService.getSource('ask-on-write', 'user')).toEqual({ text: COPY })

    // 按文件名删输掉的 g.md：gate 的胜者与规则原样
    const gateBefore = assembledFor('gate')
    expect(policyService.deleteByFile('g.md')).toEqual({ success: true })
    expect(files()).toEqual(['a.md', 'broken.md', 'gate.md'])
    expect(assembledFor('gate')).toEqual(gateBefore)
    expect(rowsNamed('gate')).toEqual([['user', 'gate.md', false, undefined]])

    // 最后一份同名用户文件也删掉：只剩内置、不再被覆盖，评估里是内置的规则，user 源查不到
    expect(policyService.deleteByFile('a.md')).toEqual({ success: true })
    expect(rowsNamed('ask-on-write')).toEqual([['builtin', '', false, undefined]])
    const restored = assembledFor('ask-on-write')
    expect(restored.length).toBeGreaterThan(0)
    expect(restored.every(([kind]) => kind === 'builtin')).toBe(true)
    expect(policyService.getSource('ask-on-write', 'user')).toEqual({
      error: 'Policy "ask-on-write" not found'
    })
    // 写着同一个名字的 broken.md 从头到尾没进过候选
    expect(policyService.listInvalid().map((f) => f.fileName)).toEqual(['broken.md'])
  })
})
