/**
 * 无法解析的用户策略文件：可见 / 可修 / 可删（policy.listInvalid + openNote + deleteByFile）。
 *
 * 语义前提：非法文件被扫描跳过 —— 既不生效，也**不遮蔽同名内置**（写坏一份 md
 * 不该意外关掉内置保护）。代价是它此前在设置页完全隐身，用户无从发现更无从修复；
 * 本 spec 钉住「隐身」被消灭而「不生效/不遮蔽」保持不变。修它的路是打开它的**笔记本会话**
 * （`policy.openNote`，按文件名认 —— 它解析不出 name）；写入没有写前校验，写坏的版本照样落盘，
 * 判定由属性卡的横幅与「无法解析」分组给出。
 *
 * 独立 spec（而非并入 policy-editing.e2e.ts）：那份的用例间有资产顺序依赖，
 * 而本文件全程在目录里留着一份坏文件，混在一起会互相干扰。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { policiesPane, registryNotePane, type PoliciesPane } from '../../harness/pages'
import { REGISTRY_NOTE_PROJECT_IDS, noteWrite, openRegistryNote } from '../../harness/seed'

let app: E2EApp
let dir: string
/** 设置窗口只开一次（openSettings 对已存在的窗口只聚焦，不会切 tab）—— UI 用例共用 */
let settings: CdpClient
let pane: PoliciesPane

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

const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval(`window.api.policy.listInvalid()`)

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
    settings = await app.openSettings('policies')
    pane = await policiesPane(settings)
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
    const bad = await listInvalid()
    expect(bad.map((f) => f.fileName)).toContain('broken.md')
    const entry = bad.find((f) => f.fileName === 'broken.md')!
    expect(entry.error).toContain('unknown rule key')
    expect(entry.error).toContain('rejected')
    const list = await app.main.eval<Array<{ name: string }>>(`window.api.policy.list()`)
    expect(list.some((p) => p.name === 'broken-pol')).toBe(false)
  })

  it('PIF-1 openNote 按文件名打开 / 复用它的笔记本会话；越界 / 子目录 / 隐藏 / 不存在的文件名一律拒绝，deleteByFile 同样不认', async () => {
    const first = await openRegistryNote(app.main, 'policy', 'broken.md')
    expect(first).toMatchObject({
      ok: true,
      projectId: REGISTRY_NOTE_PROJECT_IDS.policy,
      notebookPath: 'broken.md',
      workingDirectory: dir
    })
    // 第二次复用同一条会话（一份文件至多一条）
    expect(await openRegistryNote(app.main, 'policy', 'broken.md')).toEqual(first)

    // 让那几份「非法文件名」真实存在：拒绝必须来自白名单，而不是碰巧没有这个文件
    const outside = join(dir, '../../evil.md')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    for (const p of [outside, join(dir, 'sub', 'x.md'), join(dir, '.hidden.md')]) {
      writeFileSync(p, FIXED)
    }
    for (const evil of ['../../evil.md', 'sub/x.md', '.hidden.md', 'nope.md']) {
      const opened = await openRegistryNote(app.main, 'policy', evil)
      expect(opened.ok, evil).toBe(false)
      expect(opened.ok ? '' : opened.error, evil).toContain('Invalid policy file')
      const deleted = await app.main.eval<{ success: boolean }>(
        `window.api.policy.deleteByFile(${JSON.stringify({ fileName: evil })})`
      )
      expect(deleted.success, evil).toBe(false)
    }
    // 拒绝即零副作用：那几份文件原样还在
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(join(dir, 'sub', 'x.md'))).toBe(true)
    expect(existsSync(join(dir, '.hidden.md'))).toBe(true)
  })

  it('PIF-2 经笔记写入没有写前校验：换一种写坏的版本照样落盘（原因随之变化）；写对之后转为合法并进入 list', async () => {
    const reasonBefore = (await listInvalid()).find((f) => f.fileName === 'broken.md')!.error
    // 换一种坏法：去掉未知键、改成非法 effect。不能在 BAD 上改 effect —— 规则解析遇到第一个
    // 未知键就返回（policyFile.ts parseRule），effect 根本轮不到检查，原因会一字不差
    const stillBad = FIXED.replace('deny', 'bogus')
    expect(await noteWrite(app.main, 'policy', 'broken.md', stillBad)).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'broken.md'), 'utf8')).toBe(stillBad)
    const reasonAfter = (await listInvalid()).find((f) => f.fileName === 'broken.md')?.error
    expect(reasonAfter).toBeDefined()
    expect(reasonAfter).not.toBe(reasonBefore)
    expect(reasonAfter).toContain('rejected')

    expect(await noteWrite(app.main, 'policy', 'broken.md', FIXED)).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'broken.md'), 'utf8')).toBe(FIXED)
    const list = await app.main.eval<Array<{ name: string }>>(`window.api.policy.list()`)
    expect(list.some((p) => p.name === 'broken-pol')).toBe(true)
    expect(await listInvalid()).toHaveLength(0)
  })

  it('deleteByFile 删掉修不好的文件', async () => {
    writeFileSync(join(dir, 'hopeless.md'), BAD)
    const r = await app.main.eval<{ success: boolean }>(
      `window.api.policy.deleteByFile({ fileName: 'hopeless.md' })`
    )
    expect(r.success).toBe(true)
    expect(existsSync(join(dir, 'hopeless.md'))).toBe(false)
  })

  it('PIF-3 设置页点「无法解析」行 → 详情就是它的笔记：属性卡横幅给解析器原因（页面上不另起原因框），头部只有删除', async () => {
    writeFileSync(join(dir, 'ui-broken.md'), BAD.replace('name: broken-pol', 'name: ui-broken'))
    await pane.refresh()
    await pane.selectInvalidRow('ui-broken.md')
    expect(await pane.noteFile()).toBe('ui-broken.md')
    expect(await pane.headerTitle()).toBe('ui-broken.md')

    const note = registryNotePane(settings)
    await until(
      async () => (await note.bannerText()).includes('unknown rule key'),
      'card banner shows the parser verdict'
    )
    expect(await pane.reasonText()).toBe('')
    const icons = await pane.headerIcons()
    expect(icons.trash).toBe(true)
    expect(icons.save).toBe(false)
  })

  it('PIF-4 旧的原文读写 IPC 已下线：四个注册表都只剩 openNote 这条编辑路，bot 新建走 createNew', async () => {
    const typeOf = (paths: string[]): Promise<Record<string, string>> =>
      app.main.eval(
        `Object.fromEntries(${JSON.stringify(paths)}.map((p) => {
          const [ns, fn] = p.split('.')
          return [p, typeof (window.api[ns] ?? {})[fn]]
        }))`
      )
    const gone = [
      'policy.save',
      'policy.saveByFile',
      'policy.getSourceByFile',
      'subAgent.saveSource',
      'hook.save',
      'hook.saveByFile',
      'hook.getSourceByFile',
      'bot.save',
      'bot.getSource',
      'bot.template',
      'bot.create',
      'bot.getSourceByFile',
      'bot.saveByFile'
    ]
    const present = [
      'policy.openNote',
      'subAgent.openNote',
      'hook.openNote',
      'bot.openNote',
      'bot.createNew',
      'subAgent.listInvalid',
      'subAgent.deleteByFile'
    ]
    expect(await typeOf(gone)).toEqual(Object.fromEntries(gone.map((p) => [p, 'undefined'])))
    expect(await typeOf(present)).toEqual(Object.fromEntries(present.map((p) => [p, 'function'])))
  })
})
