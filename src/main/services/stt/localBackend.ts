import type { SttBackendMain } from './types'
import { whisperModelManager } from './whisperModelManager'
import { settingsDao } from '../../dao/settingsDao'
import { createLogger } from '../../logger'
import { t } from '../../i18n'
import type { WhisperContext } from 'whisper-cpp-node'

const log = createLogger('LocalStt')

// whisper-cpp-node 上下文缓存（避免每次调用都重新加载模型）
let cachedCtx: WhisperContext | null = null
let cachedModelId: string | null = null

/** 懒加载 whisper-cpp-node（原生模块，module.require 避免 ESM 解析问题） */
function getWhisper(): typeof import('whisper-cpp-node') {
  return module.require('whisper-cpp-node')
}

/**
 * 本地 Whisper.cpp 后端 — 使用 whisper-cpp-node 原生绑定进行本地推理
 * 接收渲染进程发来的 16kHz mono Float32 PCM 数据，直接传给 whisper-cpp-node
 */
export class LocalSttBackend implements SttBackendMain {
  async transcribe(
    _audioBase64: string,
    language?: string,
    pcmf32Base64?: string
  ): Promise<{ text: string }> {
    // 渲染进程对极短/不完整的 WebM 解码可能失败，pcmf32 为空时静默跳过
    if (!pcmf32Base64) {
      log.warn('No PCM data received (audio segment too short or decode failed), skipping')
      return { text: '' }
    }

    const modelId = settingsDao.findByKey('voice.localModel') || 'large-v3-turbo'
    const modelPath = whisperModelManager.getModelPath(modelId)
    if (!whisperModelManager.isDownloaded(modelId)) {
      throw new Error(t('voice.errorModelNotDownloaded', { modelId }))
    }

    const whisper = getWhisper()

    // 模型上下文复用（模型切换时重建）
    if (!cachedCtx || cachedModelId !== modelId) {
      if (cachedCtx) {
        try {
          cachedCtx.free()
        } catch {
          /* ignore */
        }
      }
      log.info(`Loading whisper model: ${modelId}`)
      cachedCtx = whisper.createWhisperContext({ model: modelPath, use_gpu: true })
      cachedModelId = modelId
    }

    // 将 base64 PCM 还原为 Float32Array
    const pcmBuffer = Buffer.from(pcmf32Base64, 'base64')
    const pcmf32 = new Float32Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.byteLength / 4
    )

    if (pcmf32.length < 100) {
      return { text: '' }
    }

    const lang = language && language !== 'auto' ? language.split('-')[0] : 'auto'
    log.info(`Local transcribe: model=${modelId}, pcm=${pcmf32.length} samples, lang=${lang}`)

    const result = await whisper.transcribeAsync(cachedCtx, {
      pcmf32,
      language: lang,
      // 幻觉抑制参数
      no_speech_thold: 0.6, // 无语音概率 > 60% 则不输出该段
      entropy_thold: 2.4, // 高熵（胡言乱语）片段被抑制
      logprob_thold: -1.0, // 低置信度片段被过滤
      suppress_blank: true, // 抑制空白输出
      suppress_nst: true // 抑制非语音 token
    })

    const text = result.segments
      .map((seg) => seg.text.trim())
      .filter(Boolean)
      .join('')

    return { text }
  }
}
