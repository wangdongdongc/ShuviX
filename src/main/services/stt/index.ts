import type { SttBackendMain } from './types'
import { OpenAISttBackend } from './openaiBackend'
import { LocalSttBackend } from './localBackend'
import { settingsDao } from '../../dao/settingsDao'

const openaiBackend = new OpenAISttBackend()
const localBackend = new LocalSttBackend()

/**
 * STT 服务 — 根据 voice.sttBackend 设置路由到对应后端
 */
class SttService implements SttBackendMain {
  async transcribe(audioBase64: string, language?: string, pcmf32?: string): Promise<{ text: string }> {
    const backend = settingsDao.findByKey('voice.sttBackend') || 'openai'
    if (backend === 'local') {
      return localBackend.transcribe(audioBase64, language, pcmf32)
    }
    return openaiBackend.transcribe(audioBase64, language)
  }
}

export const sttService = new SttService()

// 重新导出子模块供 IPC handlers 使用
export { whisperModelManager } from './whisperModelManager'
