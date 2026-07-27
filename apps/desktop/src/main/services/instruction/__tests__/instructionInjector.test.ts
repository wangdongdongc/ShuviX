import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  insert: vi.fn(),
  touch: vi.fn()
}))

vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.pick,
    touch: mocks.touch
  }
}))

vi.mock('../../../dao/messageDao', () => ({
  messageDao: {
    insert: mocks.insert
  }
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}))

import { buildInstructionMessages } from '../instructionInjector'

let workingDir: string

beforeEach(() => {
  vi.clearAllMocks()
  workingDir = mkdtempSync(join(tmpdir(), 'shuvix-instructions-'))
  writeFileSync(join(workingDir, 'AGENTS.md'), 'Follow the project rules.')
  writeFileSync(join(workingDir, 'CLAUDE.md'), 'Use the Claude conventions.')
})

afterEach(() => {
  rmSync(workingDir, { recursive: true, force: true })
})

describe('buildInstructionMessages', () => {
  it('automatically loads AGENTS.md when the session has no explicit configuration', () => {
    mocks.pick.mockReturnValue({ settings: {} })

    const messages = buildInstructionMessages('session-1', workingDir)

    expect(messages).toHaveLength(1)
    expect(messages[0].metadata?.instructionFilename).toBe('AGENTS.md')
    expect(messages[0].content).toContain('Follow the project rules.')
  })

  it('falls back to CLAUDE.md when AGENTS.md is absent', () => {
    rmSync(join(workingDir, 'AGENTS.md'))
    mocks.pick.mockReturnValue({ settings: {} })

    const messages = buildInstructionMessages('session-1', workingDir)

    expect(messages).toHaveLength(1)
    expect(messages[0].metadata?.instructionFilename).toBe('CLAUDE.md')
    expect(messages[0].content).toContain('Use the Claude conventions.')
  })

  it('does not load instructions when the user explicitly opts out', () => {
    mocks.pick.mockReturnValue({ settings: { instructionFile: null } })

    expect(buildInstructionMessages('session-1', workingDir)).toEqual([])
  })

  it('respects the explicitly configured instruction file', () => {
    mocks.pick.mockReturnValue({ settings: { instructionFile: 'CLAUDE.md' } })

    const messages = buildInstructionMessages('session-1', workingDir)

    expect(messages).toHaveLength(1)
    expect(messages[0].metadata?.instructionFilename).toBe('CLAUDE.md')
  })

  it('injects nothing when the configured file no longer exists on disk', () => {
    rmSync(join(workingDir, 'CLAUDE.md'))
    mocks.pick.mockReturnValue({ settings: { instructionFile: 'CLAUDE.md' } })

    expect(buildInstructionMessages('session-1', workingDir)).toEqual([])
  })
})
