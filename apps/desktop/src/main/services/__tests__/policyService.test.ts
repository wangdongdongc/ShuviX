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
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }))
vi.mock('../../utils/paths', () => ({ getDefaultPoliciesDir: () => state.dir }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { policyService } from '../policyService'

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

  it('PU-5 错误文案矩阵：save / delete / getSource(user) 报 Policy "X" not found；getSource(builtin) 报 Builtin', () => {
    expect(policyService.savePolicy('ghost', policyMd('ghost'))).toEqual({
      success: false,
      error: 'Policy "ghost" not found'
    })
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
