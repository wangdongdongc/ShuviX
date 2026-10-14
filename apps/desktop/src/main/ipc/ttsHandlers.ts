import { defineHandler, pushTo } from './registry'
import { ttsService } from '../services/tts'
import { qwen3ModelManager } from '../services/tts/qwen3ModelManager'

export function registerTtsHandlers(): void {
  defineHandler('tts:speakOnce', async (ctx, params: { text: string }) => {
    // 每片合成好就推给发起方（它已经没了就不推）
    await ttsService.speakOnce(params, (filePath, index) => {
      pushTo(ctx.client, 'tts:chunk', { filePath, index })
    })
  })

  defineHandler('tts:abort', () => {
    ttsService.abortSpeakOnce()
  })

  // ---- Qwen3 本地 TTS 管理 ----

  defineHandler('tts:getQwen3Status', () => {
    return qwen3ModelManager.getStatus()
  })

  defineHandler('tts:getQwen3Voices', () => {
    return qwen3ModelManager.listVoices()
  })

  defineHandler('tts:setupQwen3', async () => {
    await qwen3ModelManager.setup((progress) => {
      qwen3ModelManager.broadcastProgress(progress)
    })
    return { success: true }
  })

  defineHandler('tts:cancelSetupQwen3', () => {
    qwen3ModelManager.cancelSetup()
    return { success: true }
  })
}
