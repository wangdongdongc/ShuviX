import { mkdirSync } from 'fs'
import { defineHandler } from './registry'
import { listDirectories } from '../services/directoryListing'
import type { ListDirectoriesParams } from '../../shared/serverFs'
import { entryFilePath, getUserKnowledgeRoot, locateBundle } from '../services/knowledge'
import {
  getDefaultAgentsDir,
  getDefaultBotsDir,
  getDefaultHooksDir,
  getDefaultPoliciesDir
} from '../utils/paths'

/** `fs:locateFolder` 认得的文件夹（与各自「在文件管理器中打开」的那条通道打开的是同一个目录） */
const FOLDER_OF: Readonly<Record<string, () => string>> = {
  /** subAgent:openFolder */
  agents: getDefaultAgentsDir,
  /** policy:openFolder */
  policies: getDefaultPoliciesDir,
  /** hook:openFolder */
  hooks: getDefaultHooksDir,
  /** bot:openFolder */
  bots: getDefaultBotsDir,
  /** knowledge:openFolder */
  knowledge: getUserKnowledgeRoot
}

/**
 * 服务端文件系统的两条只读通道（server mode phase D）—— 浏览器里的 web 客户端拿它们代替只有桌面才有的那几样：
 *
 *  - `fs:listDirectories({path?, showHidden?})`：页面里的目录浏览器一层一层地问（代替原生的「选择文件夹」框）；
 *  - `fs:locateFolder({kind, path?})`：「在文件管理器中打开」那几条通道打开的是哪个目录 / 文件（web 客户端把
 *    路径显示出来、给一个复制按钮，代替在这台电脑上打开 Finder）。与桌面那几条一样，目录不在就先建好；
 *    `knowledgeEntry` 是条目文件（落不进任何知识库 → `path: null`，与 `knowledge:revealFile` 同口径）。
 *
 * 桌面窗口也能调（没有什么只属于浏览器的）；不限路径（用户裁决）。
 */
export function registerFsHandlers(): void {
  defineHandler('fs:listDirectories', (_ctx, params?: ListDirectoriesParams) =>
    listDirectories(params)
  )

  defineHandler(
    'fs:locateFolder',
    (_ctx, params: { kind: string; path?: string }): { path: string | null } => {
      const kind = params?.kind
      if (kind === 'knowledgeEntry') {
        const abs = typeof params.path === 'string' && params.path ? entryFilePath(params.path) : ''
        return { path: abs && locateBundle(abs) ? abs : null }
      }
      const folder =
        typeof kind === 'string' && Object.hasOwn(FOLDER_OF, kind) ? FOLDER_OF[kind] : undefined
      if (folder === undefined) return { path: null }
      const dir = folder()
      mkdirSync(dir, { recursive: true })
      return { path: dir }
    }
  )
}
