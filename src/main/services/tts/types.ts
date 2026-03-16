export interface TtsSynthesizeParams {
  text: string
  /** 由 TtsService 指定的输出文件路径 */
  outputPath: string
}

export interface TtsBackendMain {
  synthesize(params: TtsSynthesizeParams): Promise<void>
}
