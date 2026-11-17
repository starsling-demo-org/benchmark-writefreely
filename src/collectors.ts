import { readFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
import { computeSha256 } from './config.ts'
import { object } from './github.ts'
import type { CoverageSummaryRecord, TestCaseVerdictRecord } from './parity.ts'

export function parseJsonVerdicts(content: string): TestCaseVerdictRecord[] {
  const parsed: unknown = JSON.parse(content)
  const tests = Array.isArray(parsed) ? parsed : object(parsed).tests
  if (!Array.isArray(tests)) throw new Error('Verdict JSON must contain a tests array')
  return tests.map((raw) => {
    const test = object(raw)
    if (
      typeof test.testId !== 'string' ||
      !test.testId ||
      !['passed', 'failed', 'skipped'].includes(String(test.verdict)) ||
      !['executed', 'reused', 'skipped'].includes(String(test.mode))
    )
      throw new Error('Invalid test verdict record')
    if ((test.mode === 'skipped') !== (test.verdict === 'skipped'))
      throw new Error('Skipped test mode/verdict mismatch')
    return test as unknown as TestCaseVerdictRecord
  })
}
export function parseJUnit(content: string): TestCaseVerdictRecord[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('DTD/entity declarations are not supported')
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'testcase' || name === 'testsuite',
  })
  const tests: TestCaseVerdictRecord[] = []
  const visit = (node: unknown, suite = ''): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, suite)
      return
    }
    const value = object(node)
    const suiteName = typeof value['@_name'] === 'string' ? `${suite}/${value['@_name']}` : suite
    if (Array.isArray(value.testcase))
      for (const raw of value.testcase) {
        const test = object(raw)
        if (typeof test['@_name'] !== 'string') throw new Error('JUnit testcase lacks a name')
        const skipped = 'skipped' in test
        tests.push({
          testId: `${suiteName}/${String(test['@_classname'] ?? '')}/${test['@_name']}`,
          verdict: skipped ? 'skipped' : 'failure' in test || 'error' in test ? 'failed' : 'passed',
          mode: skipped ? 'skipped' : 'executed',
        })
      }
    for (const [key, child] of Object.entries(value)) if (key !== 'testcase') visit(child, suiteName)
  }
  visit(parser.parse(content))
  if (!tests.length) throw new Error('JUnit contains no test cases')
  return tests
}
const metric = (covered: number, total: number) => ({
  covered,
  total,
  percentage: total ? (covered / total) * 100 : 100,
})
export function parseLcov(content: string): CoverageSummaryRecord {
  const lines = new Map<string, number>()
  let source = ''
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) source = line.slice(3)
    if (line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',')
      if (!source || !number || !Number.isFinite(Number(hits))) throw new Error('Invalid LCOV line')
      lines.set(`${source}:${number}`, Math.max(lines.get(`${source}:${number}`) ?? 0, Number(hits)))
    }
  }
  if (!lines.size) throw new Error('LCOV has no line coverage')
  return {
    lines: metric([...lines.values()].filter((n) => n > 0).length, lines.size),
    scopeHash: computeSha256(JSON.stringify([...lines.keys()].sort())),
  }
}
export function parseIstanbul(content: string): CoverageSummaryRecord {
  const files = object(JSON.parse(content))
  const lineCounts = new Map<string, number>()
  const statements: number[] = []
  const branches: number[] = []
  const functions: number[] = []
  const scope: string[] = []
  for (const [file, raw] of Object.entries(files)) {
    const coverage = object(raw)
    const counts = object(coverage.s)
    const locations = object(coverage.statementMap)
    for (const [id, count] of Object.entries(counts)) {
      if (!Number.isFinite(Number(count))) throw new Error('Invalid Istanbul count')
      statements.push(Number(count))
      const location = object(locations[id])
      const start = object(location.start)
      const key = `${file}:${String(start.line)}`
      lineCounts.set(key, Math.max(lineCounts.get(key) ?? 0, Number(count)))
      scope.push(`${file}:${JSON.stringify(location)}`)
    }
    for (const count of Object.values(object(coverage.f ?? {}))) functions.push(Number(count))
    for (const counts of Object.values(object(coverage.b ?? {}))) {
      if (!Array.isArray(counts)) throw new Error('Invalid branch coverage')
      branches.push(...counts.map(Number))
    }
  }
  if (!statements.length || [...branches, ...functions].some((n) => !Number.isFinite(n)))
    throw new Error('Invalid or empty Istanbul coverage')
  const summarize = (counts: number[]) => metric(counts.filter((n) => n > 0).length, counts.length)
  return {
    lines: summarize([...lineCounts.values()]),
    statements: summarize(statements),
    branches: summarize(branches),
    functions: summarize(functions),
    scopeHash: computeSha256(JSON.stringify(scope.sort())),
  }
}
/**
 * Check coverage for suites without instrumentation (for example, type-check-only CI): the verification units
 * the selection requires (`scope`) and the ones that ran and passed (`covered`). The scope hash pins which
 * units count, so a candidate cannot reach 100% by dropping units.
 */
export function unitCoverage(units: { scope: string[]; covered: string[] }): CoverageSummaryRecord {
  const scope = [...new Set(units.scope)].sort()
  const covered = new Set(units.covered)
  return {
    lines: metric(scope.filter((unit) => covered.has(unit)).length, scope.length),
    scopeHash: computeSha256(JSON.stringify(scope)),
  }
}
export function parseUnitCoverage(content: string): CoverageSummaryRecord {
  const value = object(JSON.parse(content))
  if (!Array.isArray(value.scope) || !Array.isArray(value.covered) || !value.scope.length)
    throw new Error('Unit coverage needs non-empty scope and covered arrays')
  return unitCoverage({ scope: value.scope.map(String), covered: value.covered.map(String) })
}
export function verifyEvidenceSource(path: string, expectedSha256: string): void {
  if (computeSha256(readFileSync(path)) !== expectedSha256) throw new Error(`Evidence digest mismatch: ${path}`)
}
