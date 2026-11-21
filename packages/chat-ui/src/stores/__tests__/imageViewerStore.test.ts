/**
 * 看图层的 store（imageViewerStore）：打开一组图、翻页、关掉；按扩展名判断是不是图、取顶栏的名字。
 *
 *   IVS-1 open(组, 1) → images / index 1 / nonce +1；同一组再开 nonce 又 +1；openImageViewer([a]) → index 0
 *   IVS-2 越界的 index 夹进范围（5 → 末张，-3 → 0）
 *   IVS-3 open([]) 什么都不变（开着时也不变）
 *   IVS-4 go 回绕（3 张：3 → 0、-1 → 2、7 → 1）；没开时 go 不动
 *   IVS-5 close → images [] / index 0，nonce 不变；再开 nonce +1
 *   IVS-6 isImagePath 的真假表
 *   IVS-7 imageNameOf 取最后一段（`shown:` 去前缀，以分隔符结尾的原样返回）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  imageNameOf,
  isImagePath,
  openImageViewer,
  useImageViewerStore,
  type ViewerImage
} from '../imageViewerStore'

const a: ViewerImage = { src: 'data:image/png;base64,AA', name: 'a.png' }
const b: ViewerImage = { sessionId: 's1', path: '/x/b.png', name: 'b.png' }
const c: ViewerImage = { sessionId: 's1', path: 'shown:c.png', name: 'c.png' }

const state = (): ReturnType<typeof useImageViewerStore.getState> => useImageViewerStore.getState()

beforeEach(() => {
  useImageViewerStore.setState({ images: [], index: 0, nonce: 0 })
})

describe('IVS-1 打开', () => {
  it('open(组, 1) → 那一组、第 1 张、nonce +1；同一组再开 nonce 又 +1', () => {
    const group = [a, b, c]
    state().open(group, 1)
    expect(state().images).toBe(group)
    expect(state().index).toBe(1)
    expect(state().nonce).toBe(1)
    state().open(group, 1)
    expect(state().index).toBe(1)
    expect(state().nonce).toBe(2)
  })

  it('openImageViewer([a]) → index 0', () => {
    openImageViewer([a])
    expect(state().images).toEqual([a])
    expect(state().index).toBe(0)
    expect(state().nonce).toBe(1)
  })
})

describe('IVS-2 夹住 index', () => {
  it('5 → 末张，-3 → 0', () => {
    state().open([a, b], 5)
    expect(state().index).toBe(1)
    state().open([a, b], -3)
    expect(state().index).toBe(0)
  })
})

describe('IVS-3 空组', () => {
  it('没开时 open([]) 什么都不变', () => {
    state().open([])
    expect(state()).toMatchObject({ images: [], index: 0, nonce: 0 })
  })

  it('开着时 open([]) 也什么都不变', () => {
    state().open([a, b, c], 2)
    const before = state()
    state().open([])
    expect(state().images).toBe(before.images)
    expect(state().index).toBe(2)
    expect(state().nonce).toBe(1)
  })
})

describe('IVS-4 翻页', () => {
  it('回绕', () => {
    state().open([a, b, c])
    state().go(3)
    expect(state().index).toBe(0)
    state().go(-1)
    expect(state().index).toBe(2)
    state().go(7)
    expect(state().index).toBe(1)
    expect(state().nonce).toBe(1)
  })

  it('没开时 go 不动', () => {
    state().go(2)
    expect(state()).toMatchObject({ images: [], index: 0, nonce: 0 })
  })
})

describe('IVS-5 关掉', () => {
  it('close → 空、index 0、nonce 不变；再开 nonce +1', () => {
    state().open([a, b, c], 2)
    state().close()
    expect(state().images).toEqual([])
    expect(state().index).toBe(0)
    expect(state().nonce).toBe(1)
    state().open([a])
    expect(state().nonce).toBe(2)
  })
})

describe('IVS-6 isImagePath', () => {
  it.each(['a.PNG', '/x/y.jpeg', 'C:\\pics\\z.WebP', 'x.svg', 'x.avif', 'x.bmp', 'shown:anything'])(
    '%s → 是图',
    (path) => {
      expect(isImagePath(path)).toBe(true)
    }
  )

  it.each([
    'notes.md',
    'README',
    '.png',
    'dir/.png',
    'a.png?x=1',
    'library:0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
  ])('%s → 不是图', (path) => {
    expect(isImagePath(path)).toBe(false)
  })
})

describe('IVS-7 imageNameOf', () => {
  it.each([
    ['/a/b/c.png', 'c.png'],
    ['C:\\a\\b.jpg', 'b.jpg'],
    ['plain.png', 'plain.png'],
    ['a/b/', 'a/b/'],
    ['shown:abc.png', 'abc.png']
  ])('%s → %s', (path, name) => {
    expect(imageNameOf(path)).toBe(name)
  })
})
