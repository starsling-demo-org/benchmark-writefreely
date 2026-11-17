import { describe, expect, it } from 'vitest'
import { parseIstanbul, parseJsonVerdicts, parseJUnit, parseLcov } from '../src/collectors.ts'

describe('native evidence parsers', () => {
  it('preserves executed, failed and skipped JUnit cases and rejects entity declarations', () => {
    const cases = parseJUnit(
      '<testsuites><testsuite name="unit"><testcase name="ok" classname="sum"/><testcase name="bad"><failure>oops</failure></testcase><testcase name="skip"><skipped/></testcase></testsuite></testsuites>',
    )
    expect(cases.map((c) => c.verdict)).toEqual(['passed', 'failed', 'skipped'])
    expect(() => parseJUnit('<!DOCTYPE root><testsuite/>')).toThrow('DTD')
  })
  it('does not turn skipped or malformed JSON cases into executed successes', () => {
    expect(() => parseJsonVerdicts('[{"testId":"x","verdict":"passed","mode":"skipped"}]')).toThrow('mismatch')
    expect(parseJsonVerdicts('{"tests":[{"testId":"x","verdict":"passed","mode":"executed"}]}')).toHaveLength(1)
  })
  it('fingerprints coverage scope independently of coverage percentage', () => {
    const a = parseLcov('SF:a.ts\nDA:1,1\nDA:2,0\nend_of_record\n')
    const b = parseLcov('SF:b.ts\nDA:1,1\nDA:2,0\nend_of_record\n')
    expect(a.lines.percentage).toBe(50)
    expect(a.scopeHash).not.toBe(b.scopeHash)
  })
  it('uses statement locations for Istanbul line coverage and reports separate metrics', () => {
    const result = parseIstanbul(
      JSON.stringify({
        'a.ts': {
          s: { 0: 1, 1: 0 },
          statementMap: {
            0: { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
            1: { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
          },
          f: { 0: 1 },
          b: { 0: [1, 0] },
        },
      }),
    )
    expect(result.lines.percentage).toBe(50)
    expect(result.functions?.percentage).toBe(100)
    expect(result.branches?.percentage).toBe(50)
  })
})
