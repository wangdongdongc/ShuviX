/**
 * 极简 IndexedDB 封装（无外部依赖）。
 *
 * 单库 `shuvix`，object store：
 *  - sessions  (keyPath: id)
 *  - messages  (keyPath: id, index `by-session` → sessionId)
 *  - projects  (keyPath: id) —— 文件夹项目：记录含 FileSystemDirectoryHandle
 *               （chrome.storage 无法存句柄，必须用 IndexedDB 的结构化克隆）
 *
 * schema 变更走 onupgradeneeded 迁移。
 */
const DB_NAME = 'shuvix'
const DB_VERSION = 2

/** 业务 store 名 */
export type IdbStore = 'sessions' | 'messages' | 'projects'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' })
        store.createIndex('by-session', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const idb = {
  async getAll<T>(store: IdbStore): Promise<T[]> {
    const db = await openDb()
    return promisify(tx(db, store, 'readonly').getAll() as IDBRequest<T[]>)
  },

  async getAllByIndex<T>(store: 'messages', index: string, key: IDBValidKey): Promise<T[]> {
    const db = await openDb()
    return promisify(tx(db, store, 'readonly').index(index).getAll(key) as IDBRequest<T[]>)
  },

  async put<T>(store: IdbStore, value: T): Promise<void> {
    const db = await openDb()
    await promisify(tx(db, store, 'readwrite').put(value as unknown as object))
  },

  async bulkPut<T>(store: IdbStore, values: T[]): Promise<void> {
    if (values.length === 0) return
    const db = await openDb()
    const os = tx(db, store, 'readwrite')
    await Promise.all(values.map((v) => promisify(os.put(v as unknown as object))))
  },

  async delete(store: IdbStore, key: IDBValidKey): Promise<void> {
    const db = await openDb()
    await promisify(tx(db, store, 'readwrite').delete(key))
  },

  async deleteByIndex(store: 'messages', index: string, key: IDBValidKey): Promise<void> {
    const db = await openDb()
    const os = tx(db, store, 'readwrite')
    const keys = await promisify(os.index(index).getAllKeys(key))
    await Promise.all(keys.map((k) => promisify(os.delete(k))))
  }
}
