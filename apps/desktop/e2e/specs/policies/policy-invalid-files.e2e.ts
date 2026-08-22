/**
 * 无法解析的用户策略文件：可见 / 可修 / 可删（policy.listInvalid + *ByFile 一组）。
 *
 * 语义前提：非法文件被扫描跳过 —— 既不生效，也**不遮蔽同名内置**（写坏一份 md
 * 不该意外关掉内置保护）。代价是它此前在设置页完全隐身，用户无从发现更无从修复；
 * 本 spec 钉住「隐身」被消灭而「不生效/不遮蔽」保持不变。
 *
 * 独立 spec（而非并入 policy-editing.e2e.ts）：那份的用例间有资产顺序依赖，
 * 而本文件全程在目录里留着一份坏文件，混在一起会互相干扰。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { policiesPane } from '../../harness/pages'

let app: E2EApp
let dir: string

const BAD = [
  '---',
  'shuvix: policy v1',
  'name: broken-pol',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    subject.kind: [agent]',
  '    note: 未知键让整份文件非法',
  '---',
  '',
  'RATIONALE.',
  ''
].join('\n')

const FIXED = BAD.replace('    note: 未知键让整份文件非法\n', '')

beforeAll(async () => {
  app = await launchApp()
  dir = join(app.home, '.shuvix', 'policies')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'broken.md'), BAD)
})
afterAll(async () => {
  await app.stop()
})

describe('非法策略文件链路', () => {
  it('设置页左栏「无法解析」分组列出该文件（此前完全隐身）', async () => {
    const pane = await policiesPane(await app.openSettings('policies'))
    expect(await pane.invalidRows()).toContain('broken.md')
    // 正常策略行不受影响：内置照常列出，坏文件不混进 rows()
    const rows = await pane.rows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.name === 'broken.md')).toBe(false)
  })

  it('同名内置不被非法文件遮蔽（安全语义不变）', async () => {
    writeFileSync(join(dir, 'ask-on-command.md'), BAD)
    try {
      const list =
        await app.main.eval<Array<{ name: string; source: string; overridden?: boolean }>>(
          `window.api.policy.list()`
        )
      const hits = list.filter((p) => p.name === 'ask-on-command')
      expect(hits).toHaveLength(1)
      expect(hits[0].source).toBe('builtin')
      expect(hits[0].overridden).toBeFalsy()
    } finally {
      // 后续用例断言「修好后再无非法文件」，这里必须还原成只剩 broken.md
      unlinkSync(join(dir, 'ask-on-command.md'))
    }
  })

  it('listInvalid 列出该文件并带解析器原因；list 里不出现', async () => {
    const bad = await app.main.eval<Array<{ fileName: string; error: string }>>(
      `window.api.policy.listInvalid()`
    )
    expect(bad.map((f) => f.fileName)).toContain('broken.md')
    const entry = bad.find((f) => f.fileName === 'broken.md')!
    expect(entry.error).toContain('unknown rule key')
    expect(entry.error).toContain('rejected')
    const list = await app.main.eval<Array<{ name: string }>>(`window.api.policy.list()`)
    expect(list.some((p) => p.name === 'broken-pol')).toBe(false)
  })

  it('getSourceByFile 拿到原文；路径穿越被拒', async () => {
    const r = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.policy.getSourceByFile({ fileName: 'broken.md' })`
    )
    expect(r.text).toBe(BAD)
    for (const evil of ['../../evil.md', 'sub/x.md', '.hidden.md', 'nope.md']) {
      const bad = await app.main.eval<{ error?: string }>(
        `window.api.policy.getSourceByFile({ fileName: ${JSON.stringify(evil)} })`
      )
      expect(bad.error, evil).toBeTruthy()
    }
  })

  it('saveByFile 非法仍拒绝且不动磁盘；改对后文件转为合法并进入 list', async () => {
    const stillBad = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.policy.saveByFile({ fileName: 'broken.md', text: ${JSON.stringify(BAD.replace('deny', 'bogus'))} })`
    )
    expect(stillBad.success).toBe(false)
    expect(readFileSync(join(dir, 'broken.md'), 'utf8')).toBe(BAD)

    const ok = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.policy.saveByFile({ fileName: 'broken.md', text: ${JSON.stringify(FIXED)} })`
    )
    expect(ok.success).toBe(true)
    expect(readFileSync(join(dir, 'broken.md'), 'utf8')).toBe(FIXED)
    const list = await app.main.eval<Array<{ name: string }>>(`window.api.policy.list()`)
    expect(list.some((p) => p.name === 'broken-pol')).toBe(true)
    const bad = await app.main.eval<unknown[]>(`window.api.policy.listInvalid()`)
    expect(bad).toHaveLength(0)
  })

  it('deleteByFile 删掉修不好的文件', async () => {
    writeFileSync(join(dir, 'hopeless.md'), BAD)
    const r = await app.main.eval<{ success: boolean }>(
      `window.api.policy.deleteByFile({ fileName: 'hopeless.md' })`
    )
    expect(r.success).toBe(true)
    expect(existsSync(join(dir, 'hopeless.md'))).toBe(false)
  })
})
