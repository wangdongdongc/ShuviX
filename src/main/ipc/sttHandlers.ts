import { ipcMain } from 'electron'
import { sttService, whisperModelManager } from '../services/stt'

/**
 * 注册 STT（语音转文字）IPC 处理器
 */
export function registerSttHandlers(): void {
  // 转写音频（路由到 OpenAI / 本地）
  ipcMain.handle(
    'stt:transcribe',
    async (_event, params: { audioData: string; pcmf32?: string; language?: string }) => {
      return sttService.transcribe(params.audioData, params.language, params.pcmf32)
    }
  )

  // 获取本地 Whisper 状态（模型列表 + 下载状态）
  ipcMain.handle('stt:getLocalStatus', () => {
    return {
      models: whisperModelManager.listModels()
    }
  })

  // 下载模型
  ipcMain.handle('stt:downloadModel', async (_event, modelId: string) => {
    await whisperModelManager.download(modelId)
    return { success: true }
  })

  // 删除模型
  ipcMain.handle('stt:deleteModel', (_event, modelId: string) => {
    whisperModelManager.delete(modelId)
    return { success: true }
  })
}
