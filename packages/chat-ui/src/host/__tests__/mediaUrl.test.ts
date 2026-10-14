/**
 * `host/mediaUrl.tsx` 的 `mediaFileUrl` 口子（server mode phase D）—— 本机文件直接喂给 `<audio>` 的地址：桌面是
 * `shuvix-media://<绝对路径>`；浏览器里的 web 客户端启动时用 `setMediaFileUrlBuilder` 换成网络服务的 HTTP 路由。
 * 拼法是模块级的：每条用例 resetModules 后重新导入（mediaUrl、ttsPlayer、chatApi 在同一张新图里）。node 环境。
 *
 *   MU-1 缺省：`shuvix-media://` + 原样的路径（不编码）
 *   MU-2 setMediaFileUrlBuilder 换掉拼法；再换一次以后一次为准
 *   MU-3 TTS 播放器（试听的 play 与切片队列的 speak）用的都是此刻的拼法（Audio 换成记录构造参数的假件，
 *        会话渠道 api 注入假的 tts）
 *   MU-4 shuvixPreviewResolver 不变（`shuvix-preview://load/?session=…&path=…`）
 *   MU-5 源码扫描：chat-ui / app-shell / 桌面渲染层里，除了 mediaUrl.tsx 自己，没有谁再写 `shuvix-media://` 的字符串字面量
 *        （注释里提到不算；测试文件不扫）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/chat-ui/src/host/__tests__` 往上五层 */
const REPO_ROOT = resolve(HERE, '../../../../..')
/** 拆开写：本文件自己不该被 MU-5 的扫描当成一处字面量 */
const SCHEME = ['shuvix', 'media'].join('-') + '://'

type MediaUrlModule = typeof import('../mediaUrl')
type TtsModule = typeof import('../../services/tts/ttsPlayer')
type ChatApiModule = typeof import('../../api/chatApi')

let media: MediaUrlModule
let tts: TtsModule
let chatApi: ChatApiModule

/** Audio 的假件：记下构造参数 */
const audios: string[] = []
class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly src: string) {
    audios.push(src)
  }
  play(): Promise<void> {
    return Promise.resolve()
  }
  paused = false
  pause(): void {
    this.paused = true
  }
}

beforeEach(async () => {
  vi.resetModules()
  media = await import('../mediaUrl')
  tts = await import('../../services/tts/ttsPlayer')
  chatApi = await import('../../api/chatApi')
  audios.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  // 播放器的 stop() 每次都通知 main 中止合成：缺省给一个什么也不做的渠道（MU-3 自己换成会推切片的）
  chatApi.setSessionChannelApi({
    tts: { abortTts: () => {}, onChunk: () => () => {}, speakOnce: async () => {} }
  } as never)
})

afterEach(() => {
  tts.ttsPlayer.stop()
  vi.unstubAllGlobals()
})

describe('MU-1 / MU-2 拼法', () => {
  it('MU-1 缺省：shuvix-media:// + 原样的路径', () => {
    expect(media.mediaFileUrl('/a b/c.mp3')).toBe(`${SCHEME}/a b/c.mp3`)
  })

  it('MU-2 换掉拼法；再换一次以后一次为准', () => {
    media.setMediaFileUrlBuilder((p) => `/files/media?path=${encodeURIComponent(p)}`)
    expect(media.mediaFileUrl('/a b/c.mp3')).toBe('/files/media?path=%2Fa%20b%2Fc.mp3')
    media.setMediaFileUrlBuilder((p) => `X:${p}`)
    expect(media.mediaFileUrl('/a b/c.mp3')).toBe('X:/a b/c.mp3')
  })
})

describe('MU-3 TTS 播放器跟着拼法走', () => {
  function injectTts(chunks: string[]): { speakOnce: ReturnType<typeof vi.fn> } {
    let onChunk: ((data: { filePath: string }) => void) | null = null
    const speakOnce = vi.fn(async () => {
      for (const filePath of chunks) onChunk?.({ filePath })
    })
    chatApi.setSessionChannelApi({
      tts: {
        abortTts: vi.fn(),
        onChunk: (cb: (data: { filePath: string }) => void) => {
          onChunk = cb
          return () => {
            onChunk = null
          }
        },
        speakOnce
      }
    } as never)
    return { speakOnce }
  }

  it('MU-3 play：缺省（桌面）是 shuvix-media://；换了拼法就用新的', async () => {
    injectTts([])
    await tts.ttsPlayer.play('/tmp/a b.mp3')
    expect(audios).toStrictEqual([`${SCHEME}/tmp/a b.mp3`])

    media.setMediaFileUrlBuilder((p) => `/files/media?path=${encodeURIComponent(p)}`)
    await tts.ttsPlayer.play('/tmp/a b.mp3')
    expect(audios[1]).toBe('/files/media?path=%2Ftmp%2Fa%20b.mp3')
  })

  it('MU-3 speak：切片队列里的每一片都用此刻的拼法', async () => {
    media.setMediaFileUrlBuilder((p) => `/files/media?path=${encodeURIComponent(p)}`)
    const { speakOnce } = injectTts(['/tmp/c1.mp3'])
    await tts.ttsPlayer.speak('hello')
    expect(speakOnce).toHaveBeenCalledWith({ text: 'hello' })
    expect(audios).toStrictEqual(['/files/media?path=%2Ftmp%2Fc1.mp3'])
  })
})

describe('MU-4 预览解析器', () => {
  it('MU-4 shuvixPreviewResolver 不变', () => {
    expect(media.shuvixPreviewResolver({ sessionId: 's 1', path: '/a b/c.pdf' })).toStrictEqual({
      url: 'shuvix-preview://load/?session=s%201&path=%2Fa%20b%2Fc.pdf'
    })
  })
})

describe('MU-5 没有别处自己拼 shuvix-media://', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
    }
    return out
  }

  it('MU-5 字符串字面量只在 mediaUrl.tsx 里', () => {
    const roots = [
      'packages/chat-ui/src',
      'packages/app-shell/src',
      'apps/desktop/src/renderer/src'
    ].map((dir) => join(REPO_ROOT, dir))
    const allowed = join(REPO_ROOT, 'packages/chat-ui/src/host/mediaUrl.tsx')
    // 引号 / 反引号紧接着协议名：拼地址的写法（注释里顺口提到不算）
    const literal = new RegExp(`["'\`]${SCHEME.replace(/[/]/g, '\\/')}`)
    const files = roots.flatMap(sourceFiles)
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(allowed)
    expect(literal.test(readFileSync(allowed, 'utf8')), '正控制组：mediaUrl.tsx 里确实有').toBe(
      true
    )
    const offenders = files
      .filter((file) => file !== allowed)
      .filter((file) => literal.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file))
    expect(offenders).toStrictEqual([])
  })
})
