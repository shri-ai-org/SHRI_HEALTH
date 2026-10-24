// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PROBLEM_CODES, fieldErrorMessage, fieldKey, isProblem, problemCopy } from './problem'

describe('problem codes', () => {
  it('matches the contract catalogue exactly', () => {
    const yaml = readFileSync(
      new URL('../../../../contracts/openapi/components/schemas/ProblemCode.yaml', import.meta.url),
      'utf8',
    )
    const contractCodes = [...yaml.matchAll(/^ {2}- ([a-z-]+)$/gm)].map((m) => m[1])
    expect([...PROBLEM_CODES].sort()).toEqual([...contractCodes].sort())
  })

  it('routes codes that need a dedicated flow', () => {
    expect(problemCopy({ code: 'break-glass-required' }).action).toBe('break-glass')
    expect(problemCopy({ code: 'precondition-failed' }).action).toBe('record-changed')
    expect(problemCopy({ code: 'session-expired' }).action).toBe('sign-in')
    expect(problemCopy({ code: 'possible-duplicate' }).action).toBe('review-duplicates')
    expect(problemCopy({ code: 'validation-failed' }).action).toBe('fix-fields')
  })

  it('handles codes added after this release', () => {
    expect(problemCopy({ code: 'brand-new-code' })).toMatchObject({ title: 'Something went wrong', tone: 'critical' })
  })

  it('recognises Problem bodies', () => {
    expect(isProblem({ code: 'not-found', status: 404, title: 'Not found', type: 'x' })).toBe(true)
    expect(isProblem({ message: 'nope' })).toBe(false)
    expect(isProblem(null)).toBe(false)
  })

  it('maps field errors to fields and plain messages', () => {
    expect(fieldKey({ in: 'body', pointer: '/address/postalCode', code: 'invalid-format' })).toBe('/address/postalCode')
    expect(fieldKey({ in: 'query', name: 'date', code: 'invalid-format' })).toBe('date')
    expect(fieldErrorMessage('required')).toBe('This is required.')
    expect(fieldErrorMessage('something-new')).toBe('Check this field.')
  })
})
