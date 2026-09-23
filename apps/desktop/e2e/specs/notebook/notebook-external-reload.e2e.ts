/**
 * 主窗口里的笔记本 —— 别的程序改了绑定的 md，编辑器照旧**重读并重挂载**。
 *
 * 契约（app-shell NotebookView 的 files.changed 分支）：宿主没给 `onExternalChange`（只有从系统打开的
 * md 窗口给，那里走三方合并、原地并入）时，行为与协作编辑出现之前一致 —— 没有未保存的输入、磁盘内容
 * 不是自己刚存的，就重读文件、整篇重挂载编辑器。协作编辑的合并路径不能漏进普通笔记本：这里没有
 * 改动痕迹，编辑器节点也换了一个。
 *
 *   EX7 外部写盘 → 编辑器显示新内容；`.cm-editor` 是新挂的（标记没了）；没有协作编辑的痕迹
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject } from '../../harness/seed'
import { notebookEditorPane, sidebarPane } from '../../harness/pages'

let app: E2EApp
let notePath: string

beforeAll(async () => {
  app = await launchApp()
  const projDir = join(app.home, 'proj-external-reload')
  mkdirSync(projDir, { recursive: true })
  notePath = join(projDir, 'ex7-note.md')
  writeFileSync(notePath, '# EX7 note\n\nSeed body EX7.\n')
  const project = await createProject(app.main, { name: 'ExternalReloadProj', path: projDir })
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({ projectId: project.id, notebookPath: notePath })})`
  )
})

afterAll(async () => {
  await app.stop()
})

describe('主窗口笔记本的外部写盘', () => {
  it('EX7 外部写盘 → 重读并重挂载（没有协作编辑的合并与痕迹）', async () => {
    const sidebar = sidebarPane(app.main)
    await until(() => sidebar.openSession('ex7-note.md'), 'notebook session opened')
    const editor = notebookEditorPane(app.main)
    await until(
      async () => (await editor.text())?.includes('Seed body EX7.'),
      'notebook shows the seed body'
    )
    const tag = await editor.tagEditor()

    writeFileSync(notePath, '# EX7 note\n\nRewritten outside EX7.\n')
    await until(
      async () => (await editor.text())?.includes('Rewritten outside EX7.'),
      'notebook reloaded the external write'
    )
    expect(await editor.text()).not.toContain('Seed body EX7.')
    // 重挂载：换了一个编辑器节点
    expect(await editor.editorTag()).not.toBe(tag)
    expect(await editor.coEditMarks()).toBe(0)
  })
})
