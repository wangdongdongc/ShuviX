import { writeFileSync } from 'fs'
import type { TtsBackendMain, TtsSynthesizeParams } from './types'
import { providerDao } from '../../dao/providerDao'
import { settingsDao } from '../../dao/settingsDao'
import { createLogger } from '../../logger'

const log = createLogger('OpenAITts')

/** 将字节数格式化为人类可读形式 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * OpenAI TTS 后端 — 调用远程 API 进行文字转语音
 * voice / model / speed 等参数从 voice.tts.openai.* 设置中读取
 */
export class OpenAITtsBackend implements TtsBackendMain {
  async synthesize(params: TtsSynthesizeParams): Promise<void> {
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

    // OpenAI TTS 限制 4096 字符，截断到 4000 留安全余量
    const input = params.text.slice(0, 4000)
    if (!input.trim()) {
      throw new Error('文本内容为空')
    }

    const voice = settingsDao.findByKey('voice.tts.openai.voice') || 'alloy'
    const model = settingsDao.findByKey('voice.tts.openai.model') || 'tts-1'
    const speed = Number(settingsDao.findByKey('voice.tts.openai.speed')) || 1.0

    log.info(
      `Synthesizing TTS (${input.length} chars, voice=${voice}, model=${model}) via ${baseUrl}`
    )

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        speed,
        response_format: 'mp3'
      })
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`TTS API error (${response.status}): ${errText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    log.info(`TTS audio received (${formatBytes(arrayBuffer.byteLength)})`)

    writeFileSync(params.outputPath, Buffer.from(arrayBuffer))
  }
}
