import { describe, it, expect } from 'vitest'
import { sanitizeBinaryOutput, collapseProgressOutput } from '../utils/shell'

// ─── sanitizeBinaryOutput ───────────────────────────────────────────────────

describe('sanitizeBinaryOutput', () => {
  it('保留普通文本不变', () => {
    expect(sanitizeBinaryOutput('hello world')).toBe('hello world')
  })

  it('保留 tab、换行、回车', () => {
    expect(sanitizeBinaryOutput('a\tb\nc\r\n')).toBe('a\tb\nc\r\n')
  })

  it('移除控制字符（如 BEL、NULL）', () => {
    expect(sanitizeBinaryOutput('before\x00\x07after')).toBe('beforeafter')
  })

  it('完整移除 ANSI 颜色转义序列（不残留 [32m 等文本）', () => {
    const input = '\x1b[32mgreen text\x1b[0m normal'
    const result = sanitizeBinaryOutput(input)
    expect(result).toBe('green text normal')
    expect(result).not.toContain('[32m')
    expect(result).not.toContain('[0m')
  })

  it('移除 ANSI 光标移动序列', () => {
    // ESC[2K = 擦除整行, ESC[1A = 光标上移
    const input = '\x1b[2K\x1b[1Aupdated line'
    const result = sanitizeBinaryOutput(input)
    expect(result).toBe('updated line')
  })

  it('移除 256 色和真彩色 ANSI 序列', () => {
    // 256 color: ESC[38;5;196m  True color: ESC[38;2;255;0;0m
    const input = '\x1b[38;5;196mred\x1b[0m \x1b[38;2;255;0;0mtrue-red\x1b[0m'
    const result = sanitizeBinaryOutput(input)
    expect(result).toBe('red true-red')
  })

  it('移除 Unicode 格式字符 (0xFFF9-0xFFFB)', () => {
    expect(sanitizeBinaryOutput('a\uFFF9b\uFFFAc\uFFFBd')).toBe('abcd')
  })
})

// ─── collapseProgressOutput ─────────────────────────────────────────────────

describe('collapseProgressOutput', () => {
  // --- \r 回车处理 ---

  describe('\\r 回车处理', () => {
    it('模拟终端行覆盖——只保留 \\r 后的最终内容', () => {
      const input = 'progress 10%\rprogress 50%\rprogress 100%'
      const result = collapseProgressOutput(input)
      expect(result).toBe('progress 100%')
    })

    it('多行中混合 \\r 的行正确处理', () => {
      const input = 'line1\ndownloading 1MB\rdownloading 5MB\rdownloading 10MB\nline3'
      const result = collapseProgressOutput(input)
      expect(result).toBe('line1\ndownloading 10MB\nline3')
    })

    it('纯 \\r 行返回空字符串', () => {
      const input = 'before\n\r\r\r\nafter'
      const result = collapseProgressOutput(input)
      expect(result).toBe('before\n\nafter')
    })

    it('没有 \\r 时不改变内容', () => {
      const input = 'line1\nline2\nline3'
      expect(collapseProgressOutput(input)).toBe(input)
    })
  })

  // --- 骨架去重 ---

  describe('骨架去重', () => {
    it('Docker pull 进度行折叠——60 行重复输出折叠为数行', () => {
      const lines = [
        'Using default tag: latest',
        'latest: Pulling from library/nginx',
        // 3 个 layer × 20 帧 = 60 行进度
        ...Array.from({ length: 20 }, (_, i) => [
          `c032818082ff Downloading ${(i * 0.5 + 0.5).toFixed(3)}MB`,
          `9ef18fb61f0c Downloading ${(i * 0.3 + 0.1).toFixed(3)}MB`,
          `aab3b37e4807 Extracting ${(i * 0.2 + 0.1).toFixed(3)}MB`
        ]).flat(),
        'c032818082ff Pull complete',
        '9ef18fb61f0c Pull complete',
        'aab3b37e4807 Pull complete',
        'Digest: sha256:abc123def456',
        'Status: Downloaded newer image for nginx:latest'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      const resultLines = result.split('\n')

      // 原始 66 行应大幅缩减
      expect(resultLines.length).toBeLessThan(15)
      // 保留首尾有价值的行
      expect(result).toContain('Using default tag: latest')
      expect(result).toContain('Status: Downloaded newer image for nginx:latest')
      // 有折叠提示
      expect(result).toContain('similar lines collapsed')
    })

    it('wget/curl 进度条折叠', () => {
      const lines = [
        'Connecting to example.com...',
        ...Array.from(
          { length: 10 },
          (_, i) =>
            `  ${(i + 1) * 10}% [${'='.repeat(i + 1)}>${' '.repeat(9 - i)}] ${(i + 1) * 1024}  1.5MB/s`
        ),
        'Downloaded: 1 file, 10240 in 7s (1.5 MB/s)'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      const resultLines = result.split('\n')

      expect(resultLines.length).toBeLessThan(lines.length)
      expect(result).toContain('Connecting to example.com...')
      expect(result).toContain('Downloaded: 1 file')
      expect(result).toContain('similar lines collapsed')
    })

    it('git clone 进度折叠', () => {
      const lines = [
        "Cloning into 'repo'...",
        ...Array.from(
          { length: 10 },
          (_, i) => `Receiving objects: ${(i + 1) * 10}% (${(i + 1) * 50}/500)`
        ),
        ...Array.from(
          { length: 10 },
          (_, i) => `Resolving deltas: ${(i + 1) * 10}% (${(i + 1) * 20}/200)`
        ),
        'done.'
      ]

      const result = collapseProgressOutput(lines.join('\n'))

      expect(result).toContain("Cloning into 'repo'...")
      expect(result).toContain('done.')
      expect(result).toContain('similar lines collapsed')
    })

    it('少于阈值（5次）的相似行不折叠', () => {
      // 4 行共享相同骨架 "Downloading <S>"，但低于阈值 5
      const lines = [
        'Downloading 1MB',
        'Downloading 2MB',
        'Downloading 3MB',
        'Downloading 4MB',
        'Done.'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      // 同一骨架仅 4 行（< 5），不应折叠
      expect(result).toBe(lines.join('\n'))
    })

    it('结构不同的行不折叠', () => {
      const lines = [
        'Compiling src/main.ts...',
        'Warning: unused variable x',
        'Compiling src/utils.ts...',
        'Error: type mismatch',
        'Build failed with 1 error'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      expect(result).toBe(lines.join('\n'))
    })

    it('空行和超短行不参与去重', () => {
      const lines = ['', 'ok', '', 'ok', '', 'ok', '', 'ok', '', 'ok', '', 'ok']

      const result = collapseProgressOutput(lines.join('\n'))
      // 'ok' 长度 < 4，不参与骨架去重，应全部保留
      expect(result).toBe(lines.join('\n'))
    })

    it('npm install 正常输出不被误伤', () => {
      const lines = [
        'npm warn deprecated inflight@1.0.6: This module is not supported',
        'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
        'added 150 packages in 3s',
        '50 packages are looking for funding',
        '  run `npm fund` for details'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      expect(result).toBe(lines.join('\n'))
    })
  })

  // --- 综合场景 ---

  describe('综合场景', () => {
    it('\\r 处理 + 骨架去重 联合工作', () => {
      // Docker 在 TTY 模式下使用 \r 刷新 + 多层交替
      const frames = Array.from({ length: 8 }, (_, i) =>
        [`\rc032818082ff Downloading ${i + 1}MB`, `\r9ef18fb61f0c Downloading ${i + 1}MB`].join('')
      )
      const input = frames.join('\n')

      const result = collapseProgressOutput(input)
      // \r 处理后每行只保留最后内容，然后骨架去重折叠
      expect(result).toContain('similar lines collapsed')
    })

    it('大量输出中进度行折叠但非进度行保留', () => {
      const lines = [
        '$ docker build -t myapp .',
        'Step 1/5 : FROM node:18',
        // 20 行 Downloading 进度
        ...Array.from(
          { length: 20 },
          (_, i) => `a1b2c3d4e5f6 Downloading ${((i + 1) * 0.5).toFixed(1)}MB`
        ),
        'Step 2/5 : COPY . .',
        'Step 3/5 : RUN npm install',
        // 又 20 行 Downloading 进度
        ...Array.from(
          { length: 20 },
          (_, i) => `f6e5d4c3b2a1 Downloading ${((i + 1) * 0.3).toFixed(1)}MB`
        ),
        'Step 4/5 : RUN npm run build',
        'Step 5/5 : CMD ["node", "dist/index.js"]',
        'Successfully built abc123def456'
      ]

      const result = collapseProgressOutput(lines.join('\n'))
      const resultLines = result.split('\n')

      // 原始 47 行应大幅缩减
      expect(resultLines.length).toBeLessThan(20)
      // 所有 Step 行都保留
      expect(result).toContain('Step 1/5')
      expect(result).toContain('Step 2/5')
      expect(result).toContain('Step 3/5')
      expect(result).toContain('Step 4/5')
      expect(result).toContain('Step 5/5')
      expect(result).toContain('Successfully built')
    })
  })
})
