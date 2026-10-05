import {
  bootProcess,
  broadcastsOf,
  insert,
  probeCalls,
  proc,
  role,
  setupRig,
  storageIds,
  teardownRig,
  transcriptOf
} from './support/desktopRig'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answer, callTool, withTimeout } from './support/realHost'

beforeEach(async () => {
  await setupRig()
  await bootProcess()
})

afterEach(async () => {
  await teardownRig()
})

describe('K5 spawned agents through the real desktop ToolHost', () => {
  it('K5-01 smoke', async () => {
    const p = proc()
    insert('s1')
    p.router.on(
      'explore',
      role('explore'),
      callTool('probe', {}, 'call-probe'),
      answer('found')
    )
    p.router.on(
      'root',
      role('chat'),
      callTool('agent', { name: 'explore', prompt: 'find', description: 'look' }, 'call-agent'),
      answer('done')
    )
    expect(await withTimeout(p.chatGateway.prompt('s1', 'go'), 15000, 'prompt')).toEqual({})
    expect(p.router.served).toEqual(['root', 'explore', 'explore', 'root'])
    require('node:fs').writeFileSync('/private/tmp/claude-501/-Users-agent-github-projects-ShuviX/f3dcfd89-8038-4e57-bf4f-25572c5969a1/scratchpad/dbg.json', JSON.stringify({t: await transcriptOf('s1'), probeCalls, reg: broadcastsOf('sub_session_register'), end: broadcastsOf('sub_session_end'), ids: storageIds(), tools: p.kit.requests.map(r => r.tools.map(t => t.name))}, null, 1))
  }, 30000)
})
