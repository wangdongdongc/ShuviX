import { ipcMain } from 'electron'
import { sttService } from '../services/sttService'

/**
 * 注册 STT（语音转文字）IPC 处理器
 */
export function registerSttHandlers(): void {
  ipcMain.handle(
    'stt:transcribe',
    async (_event, params: { audioData: string; language?: string }) => {
      return sttService.transcribe(params.audioData, params.language)
    }
  )
}
