import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expandPath, resolveToCwd, suggestSimilarFiles } from '../utils/pathUtils'

/** 临时测试目录 */
const TEST_DIR = join(tmpdir(), 'shuvix-pathutils-test-' + Date.now())

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  // 创建测试文件
  writeFileSync(join(TEST_DIR, 'README.md'), 'hello')
  writeFileSync(join(TEST_DIR, 'readme.txt'), 'hello')
  writeFileSync(join(TEST_DIR, 'package.json'), '{}')
  writeFileSync(join(TEST_DIR, 'unrelated.ts'), '')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('expandPath', () => {
  it('展开 ~ 为 home 目录', () => {
    const result = expandPath('~/foo')
    expect(result).toContain('foo')
    expect(result).not.toContain('~')
  })

  it('单独的 ~ 展开为 home 目录', () => {
    const result = expandPath('~')
    expect(result).toBe(require('os').homedir())
  })

  it('不以 ~ 开头的路径不变', () => {
    expect(expandPath('/usr/bin')).toBe('/usr/bin')
  })

  it('去除 @ 前缀', () => {
    expect(expandPath('@/foo/bar')).toBe('/foo/bar')
  })
})

describe('resolveToCwd', () => {
  it('相对路径基于 cwd 解析', () => {
    const result = resolveToCwd('foo.ts', '/workspace')
    expect(result).toBe('/workspace/foo.ts')
  })

  it('绝对路径不变', () => {
    const result = resolveToCwd('/absolute/path.ts', '/workspace')
    expect(result).toBe('/absolute/path.ts')
  })
})

describe('suggestSimilarFiles', () => {
  it('大小写不敏感匹配', () => {
    // 查找 Readme（目录中有 README.md 和 readme.txt）
    const suggestions = suggestSimilarFiles(join(TEST_DIR, 'Readme'))
    expect(suggestions.length).toBeGreaterThan(0)
    const names = suggestions.map((s) => s.toLowerCase())
    expect(names.some((n) => n.includes('readme'))).toBe(true)
  })

  it('无近似文件时返回空数组', () => {
    const suggestions = suggestSimilarFiles(join(TEST_DIR, 'zzzznonexistent'))
    expect(suggestions).toEqual([])
  })

  it('父目录不存在时返回空数组（不抛错）', () => {
    const suggestions = suggestSimilarFiles('/nonexistent/dir/file.ts')
    expect(suggestions).toEqual([])
  })

  it('最多返回 maxResults 个结果', () => {
    const suggestions = suggestSimilarFiles(join(TEST_DIR, 'readme'), 1)
    expect(suggestions.length).toBeLessThanOrEqual(1)
  })
})
