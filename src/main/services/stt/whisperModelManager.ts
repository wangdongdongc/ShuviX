import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { getWhisperModelsDir } from '../../utils/paths'
import { downloadManager } from '../downloadManager'
import { createLogger } from '../../logger'

const log = createLogger('WhisperModel')

/** HuggingFace 模型下载基础 URL */
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** 模型定义 */
export interface WhisperModelInfo {
  /** 模型 ID（对应文件名 ggml-{id}.bin） */
  id: string
  /** 显示名称 */
  name: string
  /** 大小（MB） */
  sizeMB: number
  /** 简短描述 */
  description: string
  /** 是否推荐 */
  recommended: boolean
}

/** 完整模型清单 */
export const MODEL_CATALOG: WhisperModelInfo[] = [
  {
    id: 'large-v3-turbo',
    name: 'Large V3 Turbo',
    sizeMB: 1600,
    description: 'Fast and accurate, best choice',
    recommended: true
  },
  {
    id: 'tiny',
    name: 'Tiny',
    sizeMB: 75,
    description: 'Fastest, lowest accuracy',
    recommended: false
  },
  {
    id: 'tiny.en',
    name: 'Tiny (English)',
    sizeMB: 75,
    description: 'English only, fastest',
    recommended: false
  },
  {
    id: 'base',
    name: 'Base',
    sizeMB: 142,
    description: 'Good balance for daily use',
    recommended: false
  },
  {
    id: 'base.en',
    name: 'Base (English)',
    sizeMB: 142,
    description: 'English only, balanced',
    recommended: false
  },
  {
    id: 'small',
    name: 'Small',
    sizeMB: 466,
    description: 'Good for most users',
    recommended: false
  },
  {
    id: 'small.en',
    name: 'Small (English)',
    sizeMB: 466,
    description: 'English only, good accuracy',
    recommended: false
  },
  { id: 'medium', name: 'Medium', sizeMB: 1500, description: 'High accuracy', recommended: false },
  {
    id: 'medium.en',
    name: 'Medium (English)',
    sizeMB: 1500,
    description: 'English only, high accuracy',
    recommended: false
  },
  {
    id: 'large-v3',
    name: 'Large V3',
    sizeMB: 3100,
    description: 'Best accuracy, slowest',
    recommended: false
  }
]

/**
 * Whisper 模型管理器 — 下载、删除、查询 GGML 模型文件
 */
class WhisperModelManager {
  /** 获取模型文件路径 */
  getModelPath(modelId: string): string {
    return join(getWhisperModelsDir(), `ggml-${modelId}.bin`)
  }

  /** 模型是否已下载 */
  isDownloaded(modelId: string): boolean {
    return existsSync(this.getModelPath(modelId))
  }

  /** 获取所有模型信息（含下载状态） */
  listModels(): Array<WhisperModelInfo & { downloaded: boolean }> {
    return MODEL_CATALOG.map((m) => ({
      ...m,
      downloaded: this.isDownloaded(m.id)
    }))
  }

  /** 下载指定模型 */
  async download(modelId: string): Promise<string> {
    const model = MODEL_CATALOG.find((m) => m.id === modelId)
    if (!model) throw new Error(`Unknown model: ${modelId}`)

    const destPath = this.getModelPath(modelId)
    if (existsSync(destPath)) return destPath

    const url = `${HF_BASE}/ggml-${modelId}.bin`
    log.info(`Downloading model: ${modelId} from ${url}`)

    await downloadManager.start({
      id: `whisper-model-${modelId}`,
      url,
      destPath
    })

    log.info(`Model downloaded: ${modelId}`)
    return destPath
  }

  /** 取消下载 */
  cancelDownload(modelId: string): void {
    downloadManager.cancel(`whisper-model-${modelId}`)
  }

  /** 删除已下载的模型 */
  delete(modelId: string): void {
    const path = this.getModelPath(modelId)
    if (existsSync(path)) {
      unlinkSync(path)
      log.info(`Model deleted: ${modelId}`)
    }
  }

  /** 获取第一个已下载的模型 ID（优先推荐模型） */
  getFirstDownloaded(): string | null {
    // 先查推荐
    for (const m of MODEL_CATALOG) {
      if (m.recommended && this.isDownloaded(m.id)) return m.id
    }
    // 再查其他
    for (const m of MODEL_CATALOG) {
      if (this.isDownloaded(m.id)) return m.id
    }
    return null
  }
}

export const whisperModelManager = new WhisperModelManager()
