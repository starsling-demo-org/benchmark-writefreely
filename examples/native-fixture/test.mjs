import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
const sum = (values) => values.reduce((total, value) => total + value, 0)
const cases = [[], [1], [1, 2, 3], [-1, 1]]
const expected = [0, 1, 6, 0]
for (let i = 0; i < cases.length; i++) assert.equal(sum(cases[i]), expected[i])
mkdirSync('.cache', { recursive: true })
writeFileSync('.cache/populated', 'fixture-state')
writeFileSync(
  'results.json',
  JSON.stringify({ tests: cases.map((_, i) => ({ testId: `sum-${i}`, verdict: 'passed', mode: 'executed' })) }),
)

// Pinned workload change for PR and main replay.
