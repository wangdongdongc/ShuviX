#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 扫描 src/ 下的 t('...') 调用，找出 locale 文件中未使用的键。
//
// 用法:
//   node scripts/check-i18n-unused.mjs           # 报告未使用的键
//   node scripts/check-i18n-unused.mjs --json    # 以 JSON 输出
//
// 检测规则:
//   - 静态调用: t('a.b.c') / t("a.b.c") / t(`a.b.c`) → 精确匹配
//   - 动态调用: t(`a.b.${x}`) / t(`a.${x}.c`) → 用正则匹配该 pattern 下的所有键
//   - i18nKey="a.b.c" 形式的属性也算使用
//
// 注意: 该脚本采用保守策略 —— 任何能匹配上动态前缀/中缀的键都视为可能使用。
// 真正确认是否能删，仍需人工复核。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const LOCALE_FILE = path.join(ROOT, 'src/shared/i18n/locales/en.json')

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, files)
    } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, key, out)
    } else {
      out.push(key)
    }
  }
  return out
}

// 从源文件中抽取 t() 调用的字面量与动态 pattern
function extractUsages(text) {
  const staticKeys = new Set()
  const dynamicPatterns = [] // { regex } —— 把 ${...} 视为 [^`'"]+

  // 1) t('key') / t("key") / t(`key`)
  const staticRe = /\bt\(\s*(['"`])([^'"`$]+?)\1\s*[,)]/g
  for (const m of text.matchAll(staticRe)) {
    staticKeys.add(m[2])
  }

  // 2) i18nKey="key" / i18nKey='key'
  const propRe = /\bi18nKey\s*=\s*(['"])([^'"]+?)\1/g
  for (const m of text.matchAll(propRe)) {
    staticKeys.add(m[2])
  }

  // 3) t(`...${...}...`) —— 含模板插值的动态 key
  const dynRe = /\bt\(\s*`([^`]*\$\{[^`]*)`/g
  for (const m of text.matchAll(dynRe)) {
    const raw = m[1]
    // 把模板片段转成正则：${...} → [^`'"]+；其他字符转义
    // 注意 ${...} 可能嵌套花括号，这里简单按非嵌套处理（已覆盖大部分 i18n 用法）
    let regexStr = '^'
    let i = 0
    while (i < raw.length) {
      if (raw[i] === '$' && raw[i + 1] === '{') {
        let depth = 1
        i += 2
        while (i < raw.length && depth > 0) {
          if (raw[i] === '{') depth++
          else if (raw[i] === '}') depth--
          i++
        }
        regexStr += '[^`]+?'
      } else {
        regexStr += raw[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        i++
      }
    }
    regexStr += '$'
    // 只有包含至少一个字面字符的 pattern 才有意义；纯 ${x} 的会匹配所有键，跳过
    if (regexStr === '^[^`]+?$') continue
    try {
      dynamicPatterns.push(new RegExp(regexStr))
    } catch {
      // ignore
    }
  }

  return { staticKeys, dynamicPatterns }
}

function main() {
  const jsonMode = process.argv.includes('--json')

  const locale = JSON.parse(fs.readFileSync(LOCALE_FILE, 'utf8'))
  const allKeys = flatten(locale)

  const files = walk(SRC_DIR)
  const usedStatic = new Set()
  const dynamicPatterns = []

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const { staticKeys, dynamicPatterns: dyn } = extractUsages(text)
    for (const k of staticKeys) usedStatic.add(k)
    for (const p of dyn) dynamicPatterns.push(p)
  }

  const unused = []
  const matchedByDynamic = []

  for (const key of allKeys) {
    if (usedStatic.has(key)) continue
    const dyn = dynamicPatterns.find((re) => re.test(key))
    if (dyn) {
      matchedByDynamic.push({ key, pattern: dyn.source })
    } else {
      unused.push(key)
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          total: allKeys.length,
          usedStatic: usedStatic.size,
          dynamicPatterns: dynamicPatterns.length,
          unused,
          matchedByDynamic
        },
        null,
        2
      )
    )
    return
  }

  console.log(`Locale: ${path.relative(ROOT, LOCALE_FILE)}`)
  console.log(`总键数: ${allKeys.length}`)
  console.log(`静态命中: ${[...usedStatic].filter((k) => allKeys.includes(k)).length}`)
  console.log(`动态 pattern 数: ${dynamicPatterns.length}`)
  console.log(`仅被动态 pattern 命中 (需复核): ${matchedByDynamic.length}`)
  console.log(`未使用键: ${unused.length}`)
  console.log('')

  if (unused.length) {
    console.log('=== 未使用键 (可考虑删除) ===')
    for (const k of unused) console.log(`  ${k}`)
    console.log('')
  }

  if (matchedByDynamic.length) {
    console.log('=== 仅被动态 pattern 命中 (人工复核是否真的在用) ===')
    for (const { key, pattern } of matchedByDynamic) {
      console.log(`  ${key}   <-  /${pattern}/`)
    }
  }
}

main()
