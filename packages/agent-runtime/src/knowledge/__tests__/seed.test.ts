/**
 * SCHEMA.md 种子 —— 宿主首次初始化根目录时写出的编辑规范。它自己必须是一份干净的概念
 * （否则第一次投影就带着诊断），且要把词汇表 / 目录布局 / 扩展键 / 保留文件都讲到 ——
 * agent 只从这里学规则。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KNOWLEDGE_DIRS,
  KNOWLEDGE_TYPES,
  OKF_INDEX_FILE,
  OKF_LOG_FILE,
  SHUVIX_PINNED_KEY
} from '@shuvix/chat-protocol/knowledge'
import { KNOWLEDGE_SCHEMA_SEED } from '../seed'
import { parseConceptText } from '../conceptFile'
import { validateConceptText } from '../validate'

describe('KNOWLEDGE_SCHEMA_SEED', () => {
  it('SD-1 种子本身是零诊断的 stable Schema 概念，不带宿主章', () => {
    expect(validateConceptText(KNOWLEDGE_SCHEMA_SEED, 'SCHEMA.md')).toEqual([])
    const concept = parseConceptText(KNOWLEDGE_SCHEMA_SEED, 'SCHEMA.md')!
    expect(concept).not.toBeNull()
    expect(concept.type).toBe('Schema')
    expect(concept.status).toBe('stable')
    expect(concept.generated).toBeUndefined()
    expect(concept.verified).toEqual([])
  })

  it('SD-1 正文讲到每个 type、每个作用域目录、扩展键与两个保留文件', () => {
    const body = parseConceptText(KNOWLEDGE_SCHEMA_SEED, 'SCHEMA.md')!.body
    for (const type of KNOWLEDGE_TYPES) expect(body, type).toContain(`\`${type}\``)
    for (const dir of Object.values(KNOWLEDGE_DIRS)) expect(body, dir).toContain(`${dir}/`)
    expect(body).toContain(SHUVIX_PINNED_KEY)
    expect(body).toContain(`\`${OKF_INDEX_FILE}\``)
    expect(body).toContain(`\`${OKF_LOG_FILE}\``)
  })

  it('SD-1 ?raw 内联与磁盘上的 seed/SCHEMA.md 逐字节相同', () => {
    const onDisk = readFileSync(
      fileURLToPath(new URL('../seed/SCHEMA.md', import.meta.url)),
      'utf-8'
    )
    expect(KNOWLEDGE_SCHEMA_SEED).toBe(onDisk)
  })
})
