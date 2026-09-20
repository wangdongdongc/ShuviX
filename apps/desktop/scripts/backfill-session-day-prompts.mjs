/**
 * 一次性回填 session_day_prompts（不进 migration、不进 CI、不在启动时跑）。
 *
 * 扫本机 JSONL 会话树，把真正的用户开口按写入瞬间的本地 YYYY-MM-DD 写入索引。
 * 可重复跑（INSERT OR IGNORE）。不改 lastActiveAt。
 *
 * Usage:
 *   node apps/desktop/scripts/backfill-session-day-prompts.mjs
 *
 * 路径默认：
 *   ~/Library/Application Support/shuvix/data/shuvix.db
 *   ~/Library/Application Support/shuvix/data/sessions/*.jsonl
 * 可用 SHUVIX_DB / SHUVIX_SESSIONS_DIR 覆盖。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const NOTICE_TAGS = ['background-task', 'sub-session']
const NOTICE_RE = new RegExp(`<(${NOTICE_TAGS.join('|')})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, 'g')
const INSTRUCTION_CUSTOM_TYPE = 'shuvix:instruction'
const SYSTEM_NOTICE_CUSTOM_TYPE = 'shuvix:system_notice'

function defaultDataDir() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library/Application Support/shuvix/data')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shuvix', 'data')
  }
  return join(homedir(), '.config', 'shuvix', 'data')
}

const dataDir = defaultDataDir()
const dbPath = process.env.SHUVIX_DB || join(dataDir, 'shuvix.db')
const sessionsDir = process.env.SHUVIX_SESSIONS_DIR || join(dataDir, 'sessions')

function localDayKey(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isSystemNoticeText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('<')) return false
  const rest = trimmed.replace(new RegExp(NOTICE_RE.source, 'g'), '').trim()
  return rest.length === 0 && trimmed.length > 0
}

function userText(message) {
  const c = message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Date.parse(value)
    return Number.isNaN(n) ? null : n
  }
  return null
}

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
const insert = db.prepare(
  'INSERT OR IGNORE INTO session_day_prompts (sessionId, entryId, day, timestamp) VALUES (?, ?, ?, ?)'
)

let files = 0
let inserted = 0
let skippedNotice = 0
const sessionsTouched = new Set()

const names = existsSync(sessionsDir)
  ? readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'))
  : []

for (const name of names) {
  files++
  const sessionId = name.slice(0, -'.jsonl'.length)
  const raw = readFileSync(join(sessionsDir, name), 'utf8')
  let pendingNotice = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'session') continue
    if (entry.type === 'custom' && entry.customType === SYSTEM_NOTICE_CUSTOM_TYPE) {
      pendingNotice = true
      continue
    }
    if (entry.type === 'custom_message' && entry.customType === INSTRUCTION_CUSTOM_TYPE) {
      continue
    }
    if (entry.type !== 'message') {
      if (entry.type !== 'custom') pendingNotice = false
      continue
    }
    const message = entry.message
    if (!message || message.role !== 'user') {
      pendingNotice = false
      continue
    }
    const text = userText(message)
    const notice = pendingNotice || isSystemNoticeText(text)
    pendingNotice = false
    if (notice) {
      skippedNotice++
      continue
    }
    const ts = parseTimestamp(entry.timestamp) ?? parseTimestamp(message.timestamp)
    if (ts == null) continue
    const day = localDayKey(ts)
    if (!day) continue
    const result = insert.run(sessionId, entry.id, day, ts)
    if (result.changes > 0) {
      inserted++
      sessionsTouched.add(sessionId)
    }
  }
}

db.close()

console.log(
  `backfill-session-day-prompts: files=${files} inserted=${inserted} sessions=${sessionsTouched.size} skippedNotice=${skippedNotice}`
)
console.log(`db=${dbPath}`)
console.log(`sessions=${sessionsDir}`)
