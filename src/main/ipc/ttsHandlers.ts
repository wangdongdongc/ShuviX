import { ipcMain } from 'electron'
import { ttsService } from '../services/tts'

export function registerTtsHandlers(): void {
  ipcMain.handle('tts:speakOnce', async (_event, params: { text: string }) => {
    const filePath = await ttsService.speakOnce(params)
    return { filePath }
  })
}
