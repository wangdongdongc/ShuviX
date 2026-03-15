import { providerDao } from '../dao/providerDao'
import { createLogger } from '../logger'

const log = createLogger('SttService')

/**
 * STT 服务 — 调用 OpenAI Whisper API 进行语音转写
 */
export class SttService {
  /**
   * 将 base64 编码的音频数据转写为文字
   * @param audioBase64 base64 编码的 webm/opus 音频
   * @param language BCP-47 语言标签（可选）
   */
  async transcribe(audioBase64: string, language?: string): Promise<{ text: string }> {
    // 固定使用内置 OpenAI 提供商
    const providers = providerDao.findAll()
    const openai = providers.find((p) => p.name === 'openai' && p.isBuiltin)
    if (!openai) {
      throw new Error('未找到内置 OpenAI 提供商')
    }
    const apiKey = openai.apiKey?.trim()
    if (!apiKey) {
      throw new Error('请先在 设置 → 提供商 → OpenAI 中配置 API Key')
    }

    const baseUrl = (openai.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')

    const audioBuffer = Buffer.from(audioBase64, 'base64')

    // 跳过过短的音频（不完整的 webm 容器会导致 Whisper 400）
    if (audioBuffer.length < 4000) {
      log.info(`Skipping too-short audio (${audioBuffer.length} bytes)`)
      return { text: '' }
    }

    // 构造 multipart/form-data — 使用 File 确保文件名 + MIME 正确传递
    const file = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' })

    const formData = new FormData()
    formData.append('file', file)
    formData.append('model', 'whisper-1')
    if (language && language !== 'auto') {
      // Whisper 使用 ISO 639-1 语言代码（如 zh, en, ja），不含区域
      const langCode = language.split('-')[0]
      formData.append('language', langCode)
    }

    log.info(`Transcribing audio (${audioBuffer.length} bytes) via ${baseUrl}`)

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      // 400 通常是音频片段无效（太短/格式错误），静默跳过而非抛异常
      if (response.status === 400) {
        log.warn(`Whisper rejected audio: ${errText}`)
        return { text: '' }
      }
      throw new Error(`Whisper API error (${response.status}): ${errText}`)
    }

    const result = (await response.json()) as { text: string }
    return { text: result.text || '' }
  }
}

export const sttService = new SttService()
