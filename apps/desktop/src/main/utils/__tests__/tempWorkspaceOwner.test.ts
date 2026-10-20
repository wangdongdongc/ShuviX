/**
 * paths —— 临时工作区的根与「这个目录是谁的临时工作区」（会话 fork 共用源会话的临时工作区，删除时据此
 * 判断一个 `settings.workingDirectory` 是不是别的会话的 `temp_workspace/<id>` 本身）。
 *
 * 契约（utils/paths 的注释）：
 *   - `getTempWorkspaceBase()` = `<userData>/temp_workspace`，**不**自动创建；
 *   - `getTempWorkspace(id)` = `<base>/<id>`，问一次就建出来；
 *   - `tempWorkspaceOwnerOf(dir)`：`dirname(dir) === base` 且 basename 是安全的会话 id → 那个 id，
 *     否则 undefined；只比路径，不碰磁盘。
 *
 * userData 指到每个用例自己的临时目录（electron 的 app.getPath 换成读 holder）。
 *
 *   TW-1  getTempWorkspace(id) 的结果认得出主人；base 是 <userData>/temp_workspace，只问 base 不建它
 *   TW-2  不是「base 的直接子目录」的一律 undefined（base 本身、userData、更深的子目录、名字相近的兄弟、
 *         别处的同名 temp_workspace、相对路径、空串）
 *   TW-3  最后一段不是安全会话 id（`..` / `.` / 含 `..` / 含反斜杠）→ undefined
 *   TW-4  带结尾斜杠：按 node 的 dirname / basename 口径，仍认作那条会话（钉住现状）
 *   TW-5  纯函数：问过之后磁盘上什么都没多
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const holder = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => holder.userData, isPackaged: false, getAppPath: () => holder.userData }
}))

import { getTempWorkspace, getTempWorkspaceBase, tempWorkspaceOwnerOf } from '../paths'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-tw-'))
  holder.userData = join(root, 'userData')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const base = (): string => join(holder.userData, 'temp_workspace')

describe('TW-1 the base and a session folder', () => {
  it('TW-1 getTempWorkspaceBase() is <userData>/temp_workspace and asking for it creates nothing', () => {
    expect(getTempWorkspaceBase()).toBe(base())
    expect(existsSync(base())).toBe(false)
    expect(existsSync(holder.userData)).toBe(false)
  })

  it("TW-1 tempWorkspaceOwnerOf(getTempWorkspace('s1')) is 's1'; the folder is <base>/s1 and exists", () => {
    const dir = getTempWorkspace('s1')
    expect(dir).toBe(join(base(), 's1'))
    expect(existsSync(dir)).toBe(true)
    expect(tempWorkspaceOwnerOf(dir)).toBe('s1')
  })

  it('TW-1 a uuid-like session id is recognised too', () => {
    const id = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
    expect(tempWorkspaceOwnerOf(getTempWorkspace(id))).toBe(id)
  })
})

describe('TW-2 anything that is not a direct child of the base', () => {
  it.each<[string, () => string]>([
    ['the base itself', () => base()],
    ['<userData>', () => holder.userData],
    ['a subfolder of a session folder', () => join(base(), 's1', 'sub')],
    ['two levels below a session folder', () => join(base(), 's1', 'a', 'b')],
    ['a sibling base with a similar name', () => join(holder.userData, 'temp_workspaceX', 's1')],
    ['a temp_workspace folder elsewhere', () => '/elsewhere/temp_workspace/s1'],
    ['a temp_workspace folder under a different root', () => join(root, 'temp_workspace', 's1')],
    ['a relative path', () => 'temp_workspace/s1'],
    ['the empty string', () => '']
  ])('TW-2 %s → undefined', (_label, dir) => {
    expect(tempWorkspaceOwnerOf(dir())).toBeUndefined()
  })
})

describe('TW-3 unsafe last segments', () => {
  // 字符串拼接而不是 join：join 会把 `..` / `.` 规整掉
  it.each(['..', '.', 'x..y', '..x', 'a\\b'])('TW-3 <base>/%s → undefined', (segment) => {
    expect(tempWorkspaceOwnerOf(`${base()}/${segment}`)).toBeUndefined()
  })
})

describe('TW-4 trailing slash', () => {
  it("TW-4 <base>/s1/ is still read as s1's folder (node dirname / basename ignore the trailing slash)", () => {
    expect(tempWorkspaceOwnerOf(`${join(base(), 's1')}/`)).toBe('s1')
  })
})

describe('TW-5 pure', () => {
  it('TW-5 asking about paths creates no folder', () => {
    expect(tempWorkspaceOwnerOf(join(base(), 's9'))).toBe('s9')
    expect(tempWorkspaceOwnerOf(join(base(), 's9', 'sub'))).toBeUndefined()
    expect(tempWorkspaceOwnerOf(base())).toBeUndefined()
    expect(existsSync(join(base(), 's9'))).toBe(false)
    expect(existsSync(base())).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })
})
