export interface TtsSynthesizeParams {
  text: string
  /** 由 TtsService 指定的输出文件路径 */
  outputPath: string
}

export interface TtsBackendMain {
  synthesize(params: TtsSynthesizeParams): Promise<void>
  /** 后端输出的音频格式扩展名（不含点），默认 'mp3' */
  readonly outputExtension?: string
}
