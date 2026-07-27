import { describe, expect, it } from 'vitest'
import { buildToolSummary } from './toolSummaries'

describe('buildToolSummary', () => {
  it('includes the bash timeout after its description', () => {
    expect(
      buildToolSummary('bash', {
        command: 'npm run build',
        description: 'Build the desktop app',
        timeout: 300
      })
    ).toBe('Build the desktop app · 300s')
  })

  it('keeps the bash description unchanged when timeout is omitted', () => {
    expect(
      buildToolSummary('bash', {
        command: 'pwd',
        description: 'Show the working directory'
      })
    ).toBe('Show the working directory')
  })
})
