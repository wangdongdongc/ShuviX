import { describe, expect, it } from 'vitest'
import { groupSessionsByDay, type Session } from '../chatStore'

const session = (over: Partial<Session>): Session => ({
  id: 's',
  title: 't',
  projectId: null,
  parentId: null,
  settings: {},
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0,
  ...over
})

describe('groupSessionsByDay', () => {
  it('按 lastActiveAt 落日，不看 updatedAt', () => {
    const lastActiveAt = new Date(2024, 0, 15, 12).getTime()
    const updatedAt = new Date(2024, 5, 1, 12).getTime()
    const map = groupSessionsByDay([session({ id: 'a', lastActiveAt, updatedAt })])
    expect([...map.keys()]).toEqual(['2024-01-15'])
  })

  it('缺 lastActiveAt 时回落 updatedAt（扩展旧行）', () => {
    const updatedAt = new Date(2024, 5, 1, 12).getTime()
    const map = groupSessionsByDay([session({ id: 'a', lastActiveAt: 0, updatedAt })])
    expect([...map.keys()]).toEqual(['2024-06-01'])
  })
})
