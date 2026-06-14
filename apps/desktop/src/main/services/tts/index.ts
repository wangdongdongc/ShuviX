import { join } from 'path'
import { rmSync } from 'fs'
import { randomUUID } from 'crypto'
import type { TtsBackendMain } from './types'
import { cleanMarkdownForTts } from './cleanMarkdown'
import { splitTextForTts } from './splitText'
import { OpenAITtsBackend } from './openaiBackend'
import { getTtsCacheDir } from '../../utils/paths'
import { settingsDao } from '../../dao/settingsDao'
import { createLogger } from '../../logger'

const log = createLogger('TtsService')
const openaiBackend = new OpenAITtsBackend()

// qwen3Backend 延迟实例化（仅 macOS 可用）
import { Qwen3TtsBackend } from './qwen3Backend'
let _qwen3Backend: TtsBackendMain | undefined
function getQwen3Backend(): TtsBackendMain {
  if (!_qwen3Backend) {
    _qwen3Backend = new Qwen3TtsBackend()
  }
  return _qwen3Backend
}

/**
 * TTS 服务 — 统一管控后端路由、切片合成和缓存清理
 */
class TtsService {
  private currentAbort: AbortController | null = null

  private getBackend(): TtsBackendMain {
    const id = settingsDao.findByKey('voice.tts.backend') || 'openai'
    if (id === 'qwen3' && process.platform === 'darwin') {
      return getQwen3Backend()
    }
    return openaiBackend
  }

  /**
   * 语音合成 — 切片后逐片合成，每片完成即回调 onChunk
   * 调用前会自动中止上一次未完成的合成
   */
  async speakOnce(
    params: { text: string },
    onChunk: (filePath: string, index: number) => void
  ): Promise<void> {
    this.abortSpeakOnce()
    this.clearSpeakOnceCache()

    const ac = new AbortController()
    this.currentAbort = ac

    const backend = this.getBackend()
    const ext = backend.outputExtension ?? 'mp3'
    const cleanedText = cleanMarkdownForTts(params.text)

    const chunks = splitTextForTts(cleanedText)
    log.info(`Split into ${chunks.length} chunk(s)`)

    for (let i = 0; i < chunks.length; i++) {
      if (ac.signal.aborted) {
        log.info(`Synthesis aborted at chunk ${i}/${chunks.length}`)
        break
      }

      const chunkText = chunks[i]
      log.info(`speakOnce Chunk: ${chunkText}`)

      const outputPath = join(getTtsCacheDir(), `tts-${randomUUID()}.${ext}`)
      await backend.synthesize({ text: chunkText, outputPath })

      if (ac.signal.aborted) {
        log.info(`Synthesis aborted after chunk ${i}/${chunks.length}`)
        break
      }

      onChunk(outputPath, i)
    }

    this.currentAbort = null
  }

  /** 中止当前正在进行的合成 */
  abortSpeakOnce(): void {
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
      log.info('Synthesis aborted by user')
    }
  }

  /** 清空临时缓存目录 */
  clearSpeakOnceCache(): void {
    try {
      const dir = getTtsCacheDir()
      rmSync(dir, { recursive: true, force: true })
      getTtsCacheDir() // 重建空目录
    } catch {
      /* ignore */
    }
  }
}

export const ttsService = new TtsService()
