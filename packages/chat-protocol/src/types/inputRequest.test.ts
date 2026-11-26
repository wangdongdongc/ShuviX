import { describe, expect, it } from 'vitest'
import {
  hasSecretFields,
  inputRequestSummary,
  type AskInputRequest,
  type ChoiceInputRequest,
  type FormInputRequest
} from './inputRequest'

const formReq = (fields: FormInputRequest['fields']): FormInputRequest => ({
  id: 'f1',
  kind: 'form',
  toolName: 'ask',
  question: 'Enter credentials',
  fields,
  createdAt: 0
})

describe('hasSecretFields', () => {
  it('AF-01 含 secret 字段时返回 true，纯 text 或空数组返回 false', () => {
    expect(
      hasSecretFields(
        formReq([
          { key: 'user', label: 'User', type: 'text' },
          { key: 'pass', label: 'Pass', type: 'secret' }
        ])
      )
    ).toBe(true)
    expect(hasSecretFields(formReq([{ key: 'token', label: 'Token', type: 'secret' }]))).toBe(true)
    expect(
      hasSecretFields(
        formReq([
          { key: 'host', label: 'Host', type: 'text' },
          { key: 'port', label: 'Port', type: 'text' }
        ])
      )
    ).toBe(false)
    expect(hasSecretFields(formReq([]))).toBe(false)
  })
})

describe('inputRequestSummary', () => {
  it('AF-01 form / choice 返回 question，ask 优先 description（trim）否则回落 command', () => {
    const form = formReq([{ key: 'u', label: 'U', type: 'text' }])
    expect(inputRequestSummary(form)).toBe('Enter credentials')

    const choice: ChoiceInputRequest = {
      id: 'c1',
      kind: 'choice',
      toolName: 'ask',
      question: 'Pick one',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' }
      ],
      createdAt: 0
    }
    expect(inputRequestSummary(choice)).toBe('Pick one')

    const askWithDesc: AskInputRequest = {
      id: 'a1',
      kind: 'ask',
      toolName: 'bash',
      command: 'rm -rf dist',
      description: '  Clean build output  ',
      createdAt: 0
    }
    expect(inputRequestSummary(askWithDesc)).toBe('Clean build output')

    const askBlankDesc: AskInputRequest = {
      id: 'a2',
      kind: 'ask',
      toolName: 'bash',
      command: 'ls -la',
      description: '   ',
      createdAt: 0
    }
    expect(inputRequestSummary(askBlankDesc)).toBe('ls -la')

    const askNoDesc: AskInputRequest = {
      id: 'a3',
      kind: 'ask',
      toolName: 'bash',
      command: 'pwd',
      createdAt: 0
    }
    expect(inputRequestSummary(askNoDesc)).toBe('pwd')
  })
})
