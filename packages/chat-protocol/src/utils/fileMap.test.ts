import { describe, it, expect } from 'vitest'
import { buildFileMap, isContentOnlyFileChange, searchFileMap } from './fileMap'

const ROOT = '/Users/me/project'
const map = buildFileMap(ROOT, ['docs/Notes.md', 'src/index.ts'])
const isKnown = (rel: string): boolean => map.byRel.has(rel)

describe('isContentOnlyFileChange', () => {
  it('edit 已有文件（绝对路径）→ 纯内容变更', () => {
    expect(
      isContentOnlyFileChange(
        { root: ROOT, paths: [`${ROOT}/docs/Notes.md`], kind: 'edit' },
        isKnown
      )
    ).toBe(true)
  })

  it('write 覆盖已有文件 → 纯内容变更', () => {
    expect(
      isContentOnlyFileChange(
        { root: ROOT, paths: [`${ROOT}/src/index.ts`], kind: 'write' },
        isKnown
      )
    ).toBe(true)
  })

  it('write 新路径（可能是新建）→ 需要重扫', () => {
    expect(
      isContentOnlyFileChange({ root: ROOT, paths: [`${ROOT}/new.ts`], kind: 'write' }, isKnown)
    ).toBe(false)
  })

  it('delete → 需要重扫', () => {
    expect(
      isContentOnlyFileChange(
        { root: ROOT, paths: [`${ROOT}/docs/Notes.md`], kind: 'delete' },
        isKnown
      )
    ).toBe(false)
  })

  it('无 kind / 无 paths 的保守事件 → 需要重扫', () => {
    expect(isContentOnlyFileChange({ root: ROOT, paths: [`${ROOT}/docs/Notes.md`] }, isKnown)).toBe(
      false
    )
    expect(isContentOnlyFileChange({ root: ROOT, kind: 'edit' }, isKnown)).toBe(false)
    expect(isContentOnlyFileChange({ root: ROOT, paths: [], kind: 'edit' }, isKnown)).toBe(false)
  })

  it('多路径须全部已知才跳过', () => {
    expect(
      isContentOnlyFileChange(
        { root: ROOT, paths: [`${ROOT}/docs/Notes.md`, `${ROOT}/new.ts`], kind: 'edit' },
        isKnown
      )
    ).toBe(false)
  })

  it('相对路径与大小写不敏感', () => {
    expect(
      isContentOnlyFileChange({ root: ROOT, paths: ['docs/notes.md'], kind: 'edit' }, isKnown)
    ).toBe(true)
    expect(
      isContentOnlyFileChange({ root: ROOT, paths: ['./docs/Notes.md'], kind: 'edit' }, isKnown)
    ).toBe(true)
  })

  it('绝对路径不在 root 下 → 需要重扫', () => {
    expect(
      isContentOnlyFileChange({ root: ROOT, paths: ['/etc/hosts'], kind: 'edit' }, isKnown)
    ).toBe(false)
  })

  it('Windows 分隔符：事件绝对路径与反斜杠存键均可命中', () => {
    const winRoot = 'C:\\Users\\me\\project'
    const winKnown = (rel: string): boolean => rel === 'docs\\notes.md' // 模拟反斜杠存键
    expect(
      isContentOnlyFileChange(
        { root: winRoot, paths: ['C:\\Users\\me\\project\\docs\\Notes.md'], kind: 'edit' },
        winKnown
      )
    ).toBe(true)
  })
})

describe('searchFileMap', () => {
  const spaced = buildFileMap(ROOT, ['notes/My Plan.md', 'notes/myplan.ts', 'My Docs/a.md'])
  const rels = (q: string): string[] => searchFileMap(spaced, q).map((s) => s.rel)

  it('query 按原样比：空格是名字的一部分，尾随空格也算数', () => {
    expect(rels('my p')).toEqual(['notes/My Plan.md'])
    expect(rels('my ')).toEqual(['notes/My Plan.md', 'My Docs/a.md'])
    expect(rels('my docs/')).toEqual(['My Docs/a.md'])
    expect(rels('my x')).toEqual([])
  })

  it('不替调用方去首尾空白（`[[ ]]` 补全自己 trim）', () => {
    expect(rels(' myplan')).toEqual([])
    expect(rels('myplan')).toEqual(['notes/myplan.ts'])
  })
})
