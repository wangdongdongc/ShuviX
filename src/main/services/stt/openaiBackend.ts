import type { SttBackendMain } from './types'
import { providerDao } from '../../dao/providerDao'
import { createLogger } from '../../logger'
import { t } from '../../i18n'

const log = createLogger('OpenAIStt')

/**
 * OpenAI Whisper API 后端 — 调用远程 API 进行语音转写
 */
export class OpenAISttBackend implements SttBackendMain {
  async transcribe(audioBase64: string, language?: string): Promise<{ text: string }> {
    // 固定使用内置 OpenAI 提供商
    const providers = providerDao.findAll()
    const openai = providers.find((p) => p.name === 'openai' && p.isBuiltin)
    if (!openai) {
      throw new Error(t('voice.errorProviderNotFound'))
    }
    const apiKey = openai.apiKey?.trim()
    if (!apiKey) {
      throw new Error(t('voice.errorApiKeyMissing'))
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
      const langCode = language.split('-')[0]
      formData.append('language', langCode)
    }

    log.info(`Transcribing audio (${audioBuffer.length} bytes) via ${baseUrl}`)

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
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
