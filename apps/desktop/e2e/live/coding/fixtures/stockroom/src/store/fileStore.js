import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * One collection = one JSON file (an array of rows), loaded once and then kept in memory.
 *
 * Rows go in and come out as copies, so nobody can change the cache by mutating an object they got
 * back (that bit us twice: a report sorted an item's lots in place and corrupted valuations).
 * Writes replace the whole file atomically (temp file + rename) and are queued, so two writes never
 * interleave on disk.
 */
export class Collection {
  constructor(file, key) {
    this.file = file
    this.key = key
    this.rows = null
    this.loading = null
    this.writes = Promise.resolve()
  }

  async load() {
    if (this.rows) return
    this.loading ??= (async () => {
      let list = []
      try {
        list = JSON.parse(await readFile(this.file, 'utf8'))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      this.rows = new Map(list.map((row) => [row[this.key], row]))
    })()
    await this.loading
  }

  async get(id) {
    await this.load()
    const row = this.rows.get(id)
    return row === undefined ? undefined : structuredClone(row)
  }

  /** Every row, in insertion order. */
  async all() {
    await this.load()
    return structuredClone([...this.rows.values()])
  }

  async put(row) {
    await this.load()
    this.rows.set(row[this.key], structuredClone(row))
    await this.flush()
  }

  async putMany(rows) {
    await this.load()
    for (const row of rows) this.rows.set(row[this.key], structuredClone(row))
    await this.flush()
  }

  async delete(id) {
    await this.load()
    const existed = this.rows.delete(id)
    if (existed) await this.flush()
    return existed
  }

  flush() {
    const write = this.writes.then(() => this.write())
    this.writes = write.catch(() => {})
    return write
  }

  async write() {
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify([...this.rows.values()]))
    await rename(tmp, this.file)
  }
}
