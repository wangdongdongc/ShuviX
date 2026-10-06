/**
 * 旧格式读取器在运行时不依赖 pi —— pi 1.0 把 harness 连同这些类型一起删了，而 `harness-v3-jsonl`
 * 的旧会话永远不迁移，只能靠本目录继续被查看。所以这条依赖链必须是 pi-free 的：
 * 引到 pi（`@earendil-works/*`，今天是 pi-ai 的消息类型）的地方只能是 `import type`（编译后整句消失）。
 *
 * 单独成文件：vi.mock 作用于整个文件，而这里要让 pi 的模块一被加载就炸。
 *
 *   BG-1  pi-ai / pi-durable / chord 一加载就抛：动态导入 legacy 模块、在一份合法文本上渲染，照常工作
 *   BG-2  静态扫描：本目录（除 __tests__）引 `@earendil-works/*` 只能是 `import type`；reader.ts 一处都不引
 */
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

vi.mock('@earendil-works/pi-ai', () => {
  throw new Error('pi loaded')
})
vi.mock('@earendil-works/pi-ai/compat', () => {
  throw new Error('pi loaded')
})
vi.mock('@earendil-works/pi-durable', () => {
  throw new Error('pi loaded')
})
vi.mock('@earendil-works/chord', () => {
  throw new Error('pi loaded')
})

const PI_SCOPE = '@earendil-works/'
const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('BG-1 运行时不加载 pi', () => {
  it('对照：本文件里 pi 一加载就抛（否则下面那条什么也证明不了）', async () => {
    for (const specifier of [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-durable',
      '@earendil-works/chord'
    ]) {
      const error = await import(/* @vite-ignore */ specifier).then(
        () => null,
        (err: unknown) => err as Error & { cause?: unknown }
      )
      expect(error, specifier).toBeInstanceOf(Error)
      // vitest 把工厂抛的错包一层（"There was an error when mocking a module"），原错误在 cause 里
      expect(String((error!.cause as Error | undefined)?.message ?? error!.message)).toMatch(
        /pi loaded/
      )
    }
  })

  it('动态导入 legacy 模块并渲染一份合法文本', async () => {
    const legacy = await import('../index')
    const text =
      [
        { type: 'session', version: 3, id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/ws' },
        {
          type: 'model_change',
          id: 'm',
          parentId: null,
          timestamp: '2026-01-01T00:00:01.000Z',
          provider: 'p',
          modelId: 'mm'
        },
        {
          type: 'message',
          id: 'a',
          parentId: 'm',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }
        }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'

    const view = legacy.harnessV3TextToChatMessages(text, 'sid')
    expect(view.issues).toEqual([])
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({
      id: 'a',
      sessionId: 'sid',
      role: 'user',
      content: 'hi',
      model: 'mm',
      provider: 'p'
    })
  })
})

/** 一份源码里每一处提到 `@earendil-works/*` 的 import / export 语句 */
function piStatements(source: string): { statements: string[]; mentions: number } {
  const mentions = source.split(PI_SCOPE).length - 1
  const statements: string[] = []
  const fromRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\1/gm
  const bareRe = /^\s*import\s*(['"])([^'"]+)\1/gm
  for (const re of [fromRe, bareRe]) {
    for (const m of source.matchAll(re)) {
      if (m[2].startsWith(PI_SCOPE)) statements.push(m[0].trim())
    }
  }
  return { statements, mentions }
}

describe('BG-2 静态扫描', () => {
  const files = readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts'))

  it('目录里确实有要扫的文件', () => {
    expect(files).toEqual(
      expect.arrayContaining(['index.ts', 'projection.ts', 'reader.ts', 'types.ts'])
    )
  })

  it('引 pi 只能是 import type（不是 import { type X }，也不是动态导入 / require）', () => {
    for (const file of files) {
      const { statements, mentions } = piStatements(readFileSync(join(MODULE_DIR, file), 'utf8'))
      // 每一处提及都落在一条静态 import / export 语句里：动态 import()、require、注释里的字面量都会让两数对不上
      expect(
        statements.length,
        `${file}: every mention of ${PI_SCOPE} is an import statement`
      ).toBe(mentions)
      for (const statement of statements) {
        expect(statement, file).toMatch(/^import\s+type\s/)
      }
    }
  })

  it('reader.ts 一处都不引 pi', () => {
    expect(readFileSync(join(MODULE_DIR, 'reader.ts'), 'utf8')).not.toContain(PI_SCOPE)
  })
})
