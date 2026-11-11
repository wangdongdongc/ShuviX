// @vitest-environment jsdom
/**
 * 笔记本会话交给 NotebookView 的 `attachable` / `readOnly`（文件库 L1 §5 的载体表；jsdom）。
 * 测试设计 docs/file-library-l1-tests.md §10.3。
 *
 *   NS-1 能放文件：普通项目笔记、`__knowledge__`、`__knowledge_user__`、`__daily__`、`__tracking__`、
 *        没有载体项目（md 窗口的临时会话）；
 *        不能放：bot / agent / 策略 / hook 的注册表载体、三种技能载体（default、builtin、external）；
 *        只读载体（内置知识库、`*_builtin__`）：readOnly 为 true、attachable 为 false；
 *        按文件名认 SKILL.md（2026-11-11 补）：任何载体下、md 窗口里，路径以 `SKILL.md` 结尾（不分大小写）都不能放。
 *
 * NotebookView 换成记 props 的替身；`@shuvix/chat-ui` 替掉 NotebookSession 与 useFocusDim 用到的 hooks 与组件，
 * chatStore 的状态放在可变的 `store` 里。设计稿写的是 `.tsx`，但单测配置只收 app-shell 的 `*.test.ts`，
 * 这里照 app-shell 其他 DOM 单测的写法用 `.ts` + createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

interface StoreSession {
  id: string
  projectId: string | null
}
const store = vi.hoisted(() => ({
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null
}))
const seen = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }))

vi.mock('@shuvix/chat-ui', () => ({
  InputArea: () => null,
  PendingInputsDrawer: () => null,
  TaskListPanel: () => null,
  ThreadDrawer: () => null,
  useChatActions: () => ({ handleInputResponse: () => {} }),
  useChatStore: (selector: (s: typeof store) => unknown) => selector(store),
  selectPendingInputs: () => [],
  useChatHost: () => ({ appearance: { focusMode: false } })
}))

vi.mock('./NotebookView', () => ({
  NotebookView: (props: Record<string, unknown>) => {
    seen.props.push(props)
    return null
  }
}))

import { NotebookSession } from './NotebookSession'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  seen.props = []
  store.sessions = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** 渲染一次，回 NotebookView 最后收到的 attachable / readOnly */
function render(
  projectId: string | null | undefined,
  path = '/p/notes/n.md'
): { attachable: unknown; readOnly: unknown } {
  store.sessions = projectId === undefined ? [] : [{ id: 'S', projectId }]
  act(() => {
    root.render(createElement(NotebookSession, { path, sessionId: 'S' }))
  })
  const last = seen.props[seen.props.length - 1]
  if (!last) throw new Error('NotebookView was not rendered')
  return { attachable: last.attachable, readOnly: last.readOnly }
}

describe('NS-1 各载体的 attachable', () => {
  it.each([
    ['普通项目笔记', 'proj-1'],
    ['__knowledge__', '__knowledge__'],
    ['__knowledge_user__', '__knowledge_user__'],
    ['__daily__', '__daily__'],
    ['__tracking__', '__tracking__'],
    ['md 窗口的临时会话（projectId 为 null）', null],
    ['会话不在列表里（projectId 取不到）', undefined]
  ] as const)('%s → attachable true，readOnly false', (_label, projectId) => {
    expect(render(projectId)).toEqual({ attachable: true, readOnly: false })
  })

  it.each([
    ['__bots__'],
    ['__agents__'],
    ['__policies__'],
    ['__hooks__'],
    ['__skills__'],
    ['__skills:claude__']
  ])('%s → attachable false，readOnly false', (projectId) => {
    expect(render(projectId)).toEqual({ attachable: false, readOnly: false })
  })

  it.each([
    ['__knowledge_builtin__'],
    ['__agents_builtin__'],
    ['__policies_builtin__'],
    ['__hooks_builtin__'],
    ['__skills_builtin__']
  ])('只读载体 %s → readOnly true，attachable false', (projectId) => {
    expect(render(projectId)).toEqual({ attachable: false, readOnly: true })
  })

  it.each([
    ['普通项目里的 SKILL.md', 'proj-1', '/p/skills/pdf/SKILL.md'],
    ['普通项目里的小写 skill.md', 'proj-1', '/p/skills/pdf/skill.md'],
    ['Windows 路径的 SKILL.md', 'proj-1', 'C:\\p\\skills\\pdf\\SKILL.md'],
    ['只有文件名的 SKILL.md', 'proj-1', 'SKILL.md'],
    ['md 窗口里打开的 SKILL.md', null, '/Users/x/.claude/skills/pdf/SKILL.md'],
    ['知识库载体下的 SKILL.md', '__knowledge__', '/k/base/SKILL.md']
  ] as const)('%s → attachable false', (_label, projectId, path) => {
    expect(render(projectId, path)).toEqual({ attachable: false, readOnly: false })
  })

  it.each([
    ['文件名只是以 SKILL.md 结尾', '/p/MY-SKILL.md'],
    ['目录名叫 SKILL.md', '/p/SKILL.md/notes.md'],
    ['扩展名不同', '/p/skills/pdf/SKILL.mdx']
  ])('%s（%s）→ attachable true', (_label, path) => {
    expect(render('proj-1', path)).toEqual({ attachable: true, readOnly: false })
  })
})
