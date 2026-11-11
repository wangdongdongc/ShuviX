import type {
  LibraryItemKind,
  LibraryItemSource,
  LibraryLinkRelation,
  LibraryLinkTarget
} from '@shuvix/chat-protocol/fileLibrary'

/** 库里的一件文件连同它的当前版本（表 library_items ⨝ library_versions，迁移 v41） */
export interface LibraryItemRow {
  id: string
  name: string
  storage: 'managed' | 'linked'
  externalPath: string | null
  currentVersion: number
  kind: LibraryItemKind
  source: LibraryItemSource
  description: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  sha256: string
  size: number
  mime: string
  fileName: string
  width: number | null
  height: number | null
  durationMs: number | null
}

/** 新建一件（只有一个版本） */
export interface NewLibraryItem {
  id: string
  name: string
  storage: 'managed' | 'linked'
  externalPath?: string
  kind: LibraryItemKind
  source: LibraryItemSource
  sha256: string
  size: number
  mime: string
  fileName: string
  width?: number
  height?: number
  createdAt: number
}

/** 一条关联（表 library_links） */
export interface LibraryLinkRow {
  itemId: string
  targetType: LibraryLinkTarget
  targetId: string
  relation: LibraryLinkRelation
  origin: 'derived' | 'manual'
  /** JSON，如 entryId */
  context: string | null
  createdAt: number
}
