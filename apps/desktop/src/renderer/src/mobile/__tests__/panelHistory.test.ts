/**
 * 对话页上面那几页（文件 / 后台任务 / 产物）在浏览器历史里的记号（mobile/panelHistory.ts，纯函数）。
 *
 * 契约：
 * - `history.state.shuvixMobilePanel` 是一摞页面 id（从对话页往上数）：首个必须是三样之一的首页，上面只能是同一样
 *   东西更深的一层（文件夹可以很多层；任务 / 产物只有一层详情），前缀后面必须有东西；有一个不对整摞都不算；
 * - 深度 = 这一摞的长度（关对话页时要一起退掉的条数）；
 * - 页面 id 与它说的东西来回对得上（文件夹路径、任务 id、产物的 `<会话 id>/<文件名>`）。
 *
 *   PH-1..5  panelStackOf / panelDepthOf
 *   PH-6..9  各页 id 的拼与拆
 */
import { describe, expect, it } from 'vitest'
import {
  PANEL_HISTORY_MARK,
  artifactKeyOf,
  artifactPage,
  filesDirOf,
  filesPage,
  panelDepthOf,
  panelStackOf,
  taskIdOf,
  taskPage
} from '../panelHistory'

const st = (value: unknown): Record<string, unknown> => ({ [PANEL_HISTORY_MARK]: value })

describe('panelHistory: the stack stored on a history entry', () => {
  it('PH-0 the mark name', () => {
    expect(PANEL_HISTORY_MARK).toBe('shuvixMobilePanel')
  })

  it.each([[null], [undefined], [{}], ['x'], [5]])('PH-1 %j is not a panel entry', (state) => {
    expect(panelStackOf(state)).toEqual([])
    expect(panelDepthOf(state)).toBe(0)
  })

  it.each([['files'], [{ 0: 'files' }], [[]]])('PH-2 a mark that is %j is no stack', (value) => {
    expect(panelStackOf(st(value))).toEqual([])
    expect(panelDepthOf(st(value))).toBe(0)
  })

  it.each<[string[], number]>([
    [['files'], 1],
    [['files', 'files:src', 'files:src/main'], 3],
    [['tasks', 'task:t1'], 2],
    [['artifacts', 'artifact:s1/a.svg'], 2],
    [['tasks'], 1],
    [['artifacts'], 1]
  ])('PH-3 %j is its own stack', (stack, depth) => {
    expect(panelStackOf(st(stack))).toEqual(stack)
    expect(panelDepthOf(st(stack))).toBe(depth)
  })

  it.each([[['files', 3]], [['files', null]], [['files', 'bogus']], [['tasks', 'tasksx']]])(
    'PH-4 one element that is not a page invalidates the whole stack: %j',
    (stack) => {
      expect(panelStackOf(st(stack))).toEqual([])
      expect(panelDepthOf(st(stack))).toBe(0)
    }
  )

  it.each([[['files:src']], [['task:t1']], [['artifact:s/a']], [['bogus']], [[3]]])(
    'PH-5 a stack must start with one of the three first pages: %j',
    (stack) => {
      expect(panelStackOf(st(stack))).toEqual([])
    }
  )

  it.each([[['files', 'files:']], [['tasks', 'task:']], [['artifacts', 'artifact:']]])(
    'PH-5b a prefix with nothing after it is not a page: %j',
    (stack) => {
      expect(panelStackOf(st(stack))).toEqual([])
    }
  )

  it.each([
    [['tasks', 'files:a']],
    [['files', 'task:t1']],
    [['artifacts', 'task:t1']],
    [['files', 'files']],
    [['tasks', 'tasks']]
  ])('PH-5c the pages above the first one are of the same kind: %j', (stack) => {
    expect(panelStackOf(st(stack))).toEqual([])
  })

  it.each([[['tasks', 'task:t1', 'task:t2']], [['artifacts', 'artifact:s/a', 'artifact:s/b']]])(
    'PH-5d tasks and artifacts have one detail level only: %j',
    (stack) => {
      expect(panelStackOf(st(stack))).toEqual([])
      expect(panelDepthOf(st(stack))).toBe(0)
    }
  )

  it('PH-3b the other marks on the entry do not matter', () => {
    const state = { shuvixMobile: true, shuvixMobileScope: true, ...st(['files', 'files:a']) }
    expect(panelStackOf(state)).toEqual(['files', 'files:a'])
  })
})

describe('panelHistory: page ids', () => {
  it('PH-6 filesDirOf', () => {
    expect(filesDirOf('files')).toBe('')
    expect(filesDirOf('files:a/b')).toBe('a/b')
    expect(filesDirOf('tasks')).toBeNull()
    expect(filesDirOf('task:x')).toBeNull()
    expect(filesDirOf('filesx')).toBeNull()
    expect(filesDirOf('')).toBeNull()
  })

  it('PH-7 filesPage and its round trip', () => {
    expect(filesPage('')).toBe('files')
    expect(filesPage('a')).toBe('files:a')
    for (const dir of ['', 'a', 'a/b c', 'a:b']) expect(filesDirOf(filesPage(dir))).toBe(dir)
  })

  it('PH-8 taskPage / taskIdOf', () => {
    expect(taskPage('t1')).toBe('task:t1')
    expect(taskIdOf('task:t1')).toBe('t1')
    expect(taskIdOf('tasks')).toBeNull()
    expect(taskIdOf(taskPage('call:1:2'))).toBe('call:1:2')
  })

  it('PH-9 artifactPage / artifactKeyOf', () => {
    expect(artifactPage('s1', 'a.svg')).toBe('artifact:s1/a.svg')
    expect(artifactKeyOf('artifact:s1/a.svg')).toBe('s1/a.svg')
    expect(artifactKeyOf('artifacts')).toBeNull()
    expect(artifactKeyOf(artifactPage('s1', 'a:b.svg'))).toBe('s1/a:b.svg')
  })
})
