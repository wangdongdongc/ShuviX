import { ipcMain } from 'electron'
import { ttsService } from '../services/tts'
import { qwen3ModelManager } from '../services/tts/qwen3ModelManager'

export function registerTtsHandlers(): void {
  ipcMain.handle('tts:speakOnce', async (_event, params: { text: string }) => {
    const filePath = await ttsService.speakOnce(params)
    return { filePath }
  })

  // ---- Qwen3 本地 TTS 管理 ----

  ipcMain.handle('tts:getQwen3Status', () => {
    return qwen3ModelManager.getStatus()
  })

  ipcMain.handle('tts:getQwen3Voices', () => {
    return qwen3ModelManager.listVoices()
  })

  ipcMain.handle('tts:setupQwen3', async () => {
    await qwen3ModelManager.setup((progress) => {
      qwen3ModelManager.broadcastProgress(progress)
    })
    return { success: true }
  })

  ipcMain.handle('tts:cancelSetupQwen3', () => {
    qwen3ModelManager.cancelSetup()
    return { success: true }
  })
}
