import { join } from 'path'
import { rmSync } from 'fs'
import { randomUUID } from 'crypto'
import type { TtsBackendMain } from './types'
import { OpenAITtsBackend } from './openaiBackend'
import { getTtsCacheDir } from '../../utils/paths'

const openaiBackend = new OpenAITtsBackend()

/**
 * TTS 服务 — 统一管控合成参数、输出路径和缓存清理
 */
class TtsService {
  private backend: TtsBackendMain = openaiBackend

  /** 一次性语音合成（用于即时播报），结果存入临时缓存，下次调用前自动清理 */
  async speakOnce(params: { text: string }): Promise<string> {
    this.clearCache()

    const outputPath = join(getTtsCacheDir(), `tts-${randomUUID()}.mp3`)
    await this.backend.synthesize({ text: params.text, outputPath })

    return outputPath
  }

  /** 清空临时缓存目录 */
  clearCache(): void {
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
