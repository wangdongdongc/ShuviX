import { describe, expect, it } from 'vitest'
import { answer, callTool, held } from './support/faux'
import { registerHostCleanup } from './support/host'
import { anchors, hookRig, promptPayload, queueRoles, requestsOfRole } from './support/hookRig'
import { liveTasks } from './support/spawn'
import { waitFor } from './support/wait'

registerHostCleanup()
import { appendFileSync } from 'node:fs'
const dbg = (...a: unknown[]): void => appendFileSync('/private/tmp/claude-501/-Users-agent-github-projects-ShuviX/f3dcfd89-8038-4e57-bf4f-25572c5969a1/scratchpad/dbg.log', JSON.stringify(a) + '\n')

describe('smoke', () => {
  it('titler runs', async () => {
    const rig = await hookRig()
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [callTool('titleProbe', { title: 'x' }), h.step] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await h.reached
    const a = await anchors(rig.session)
    dbg('anchors while held', a.map((t) => [t.id, t.state.status, t.background]))
    dbg('runState', rig.session.runState, rig.t.statesOf('s1'))
    h.release()
    await waitFor(() => rig.ends().length === 1)
    dbg(rig.ends(), rig.warns())
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
    dbg('anchors after', (await anchors(rig.session)).map((t) => [t.id, t.state.status]))
    dbg('states', rig.t.statesOf('s1'), requestsOfRole(rig.kit, 'titler').length, rig.titleCalls)
    expect(rig.ends()[0]!.ok).toBe(true)
  })
})
