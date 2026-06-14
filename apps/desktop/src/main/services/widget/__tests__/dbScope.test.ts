import { describe, it, expect } from 'vitest'
import {
  widgetIdToSchema,
  quoteIdent,
  isValidIdent,
  assertValidIdent,
  detectCrossWidgetReferences
} from '../dbScope'

describe('widgetIdToSchema', () => {
  it('replaces dashes with underscores and prefixes widget_', () => {
    expect(widgetIdToSchema('json-formatter')).toBe('widget_json_formatter')
    expect(widgetIdToSchema('my-todo-list')).toBe('widget_my_todo_list')
  })

  it('handles bare-but-with-dash id (kebab-case minimum)', () => {
    expect(widgetIdToSchema('a-b')).toBe('widget_a_b')
  })

  it('lowercase + digits + dashes only — id format is validated upstream', () => {
    expect(widgetIdToSchema('todo-app-7a')).toBe('widget_todo_app_7a')
  })
})

describe('quoteIdent', () => {
  it('wraps in double quotes', () => {
    expect(quoteIdent('todos')).toBe('"todos"')
  })

  it('escapes embedded double quotes', () => {
    expect(quoteIdent('wei"rd')).toBe('"wei""rd"')
  })
})

describe('isValidIdent / assertValidIdent', () => {
  it('accepts standard identifiers', () => {
    expect(isValidIdent('todos')).toBe(true)
    expect(isValidIdent('user_id')).toBe(true)
    expect(isValidIdent('_secret')).toBe(true)
    expect(isValidIdent('col1')).toBe(true)
  })

  it('rejects identifiers that could enable injection', () => {
    expect(isValidIdent('1col')).toBe(false)
    expect(isValidIdent('a b')).toBe(false)
    expect(isValidIdent('a;b')).toBe(false)
    expect(isValidIdent('a"b')).toBe(false)
    expect(isValidIdent('--')).toBe(false)
    expect(isValidIdent('')).toBe(false)
  })

  it('assertValidIdent throws on invalid', () => {
    expect(() => assertValidIdent('a;b', 'column')).toThrow(/Invalid column/)
    expect(() => assertValidIdent('todos', 'table name')).not.toThrow()
  })
})

describe('detectCrossWidgetReferences', () => {
  it('passes when SQL only references own schema', () => {
    const r = detectCrossWidgetReferences(
      'SELECT * FROM widget_my_todo.items WHERE id = 1',
      'widget_my_todo'
    )
    expect(r.hasViolation).toBe(false)
    expect(r.foreignSchemas).toEqual([])
  })

  it('passes when SQL has no widget_ references at all', () => {
    const r = detectCrossWidgetReferences(
      'SELECT id, name FROM todos ORDER BY id',
      'widget_my_todo'
    )
    expect(r.hasViolation).toBe(false)
  })

  it('flags foreign widget schema references', () => {
    const r = detectCrossWidgetReferences(
      'SELECT * FROM widget_other_app.secrets',
      'widget_my_todo'
    )
    expect(r.hasViolation).toBe(true)
    expect(r.foreignSchemas).toContain('widget_other_app')
  })

  it('flags multiple foreign schemas', () => {
    const r = detectCrossWidgetReferences(
      'SELECT * FROM widget_a.foo, widget_b.bar',
      'widget_my_todo'
    )
    expect(r.hasViolation).toBe(true)
    expect(r.foreignSchemas.sort()).toEqual(['widget_a', 'widget_b'])
  })

  it('is case-insensitive (SQL identifiers can be lowercased by callers)', () => {
    const r = detectCrossWidgetReferences('SELECT * FROM WIDGET_OTHER.foo', 'widget_my_todo')
    expect(r.hasViolation).toBe(true)
  })
})
