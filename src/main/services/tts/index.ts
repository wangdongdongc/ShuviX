import { join } from 'path'
import { rmSync } from 'fs'
import { randomUUID } from 'crypto'
import type { TtsBackendMain } from './types'
import { cleanMarkdownForTts } from './cleanMarkdown'
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
 * TTS 服务 — 统一管控后端路由、输出路径和缓存清理
 */
class TtsService {
  private getBackend(): TtsBackendMain {
    const id = settingsDao.findByKey('voice.tts.backend') || 'openai'
    if (id === 'qwen3' && process.platform === 'darwin') {
      return getQwen3Backend()
    }
    return openaiBackend
  }

  /** 一次性语音合成（用于即时播报），结果存入临时缓存，下次调用前自动清理 */
  async speakOnce(params: { text: string }): Promise<string> {
    this.clearCache()

    const backend = this.getBackend()
    const ext = backend.outputExtension ?? 'mp3'
    const outputPath = join(getTtsCacheDir(), `tts-${randomUUID()}.${ext}`)
    const cleanedText = cleanMarkdownForTts(params.text)
    log.info(`Cleaned text for TTS:\n${cleanedText}`)
    await backend.synthesize({ text: cleanedText, outputPath })

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
