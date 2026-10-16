/**
 * 主窗口里的笔记本 —— 别的程序改了绑定的 md，编辑器**原地并入**，不重挂载。
 *
 * 契约（desktop NotebookSessionView → useCoEditing 的 onExternalChange）：每个笔记本都是协作编辑，主窗口里的
 * 也一样 —— 外部写盘（含编辑器没开着时 doc_* 落到磁盘上的改动）三方合并进编辑器的当前缓冲：编辑器节点
 * 不换，并进来的地方留 external 痕迹。以前这里是整篇重读并重挂载，用户正在打字时外部改动会被跳过、
 * 随后又被自动保存盖掉。
 *
 *   EX7 外部写盘 → 编辑器显示新内容；`.cm-editor` 还是原来那个（标记还在）；并进来的地方有 external 痕迹
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
  it('EX7 外部写盘 → 原地并入（不重挂载），留 external 痕迹', async () => {
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
      'notebook merged the external write'
    )
    expect(await editor.text()).not.toContain('Seed body EX7.')
    // 原地并入：还是同一个编辑器节点
    expect(await editor.editorTag()).toBe(tag)
    expect(await editor.coEditMarks()).toBeGreaterThan(0)
  })
})
