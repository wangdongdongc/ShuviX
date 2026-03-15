/** 主进程 STT 后端接口 */
export interface SttBackendMain {
  transcribe(audioBase64: string, language?: string, pcmf32?: string): Promise<{ text: string }>
}
