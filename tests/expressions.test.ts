import { describe, expect, it } from 'vitest'
import { evaluateCondition, type ExpressionContext, UNKNOWN } from '../src/expressions.ts'
import { evaluateJobIfCondition } from '../src/inventory-helpers.ts'
import type { ScenarioConfig } from '../src/types.ts'

const push: ScenarioConfig = {
  name: 'main-push',
  description: 'main',
  event: 'push',
  main: { branch: 'main', beforeSha: 'a'.repeat(40), afterSha: 'b'.repeat(40), changedPaths: [] },
  referenceRuns: [],
}
const pr: ScenarioConfig = {
  name: 'pr',
  description: 'pr',
  event: 'pull_request',
  pr: {
    prNumber: 7,
    baseRef: 'main',
    headRef: 'feature',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergeSha: 'c'.repeat(40),
    activityType: 'synchronize',
    changedPaths: [],
    labels: ['run-e2e'],
  },
  referenceRuns: [],
}
const ctx = (values: ExpressionContext['values']): ExpressionContext => ({
  values,
  status: { success: true, failure: false, cancelled: false },
})
const job = (condition: string | undefined, scenario = push, deps = {}) =>
  evaluateJobIfCondition(condition, scenario, 'Org/Repo', [], deps, 'bench/replay')

describe('GitHub expression evaluation before dispatch', () => {
  it('follows GitHub comparison, logical and function semantics', () => {
    const values = { 'github.ref': 'refs/heads/main', 'github.event_name': 'push' }
    expect(evaluateCondition("github.ref == 'REFS/HEADS/MAIN'", ctx(values)).value).toBe(true)
    // GitHub coerces null to 0 when the other side is not null.
    expect(evaluateCondition("null == ''", ctx({})).value).toBe(true)
    expect(evaluateCondition('null == false', ctx({})).value).toBe(true)
    expect(evaluateCondition('null == 0', ctx({})).value).toBe(true)
    expect(evaluateCondition('null == null', ctx({})).value).toBe(true)
    expect(evaluateCondition("null == 'x'", ctx({})).value).toBe(false)
    expect(evaluateCondition("startsWith(github.ref, 'refs/tags/')", ctx(values)).value).toBe(false)
    expect(
      evaluateCondition("!(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')", ctx(values))
        .value,
    ).toBe(true)
    expect(
      evaluateCondition('contains(fromJSON(\'["push","pull_request"]\'), github.event_name)', ctx(values)).value,
    ).toBe(true)
    expect(evaluateCondition("format('{0}-{1}', 'a', 'b') == 'a-b'", ctx({})).value).toBe(true)
    expect(evaluateCondition("'it''s' == 'IT''S'", ctx({})).value).toBe(true)
    expect(evaluateCondition('1 < 2 && 2 >= 2', ctx({})).value).toBe(true)
  })

  it('keeps runtime-only context unknown instead of guessing', () => {
    expect(evaluateCondition("needs.changes.outputs.src == 'true'", ctx({})).value).toBeUndefined()
    // A decidable false operand still decides && and a decidable true operand still decides ||.
    expect(
      evaluateCondition("github.event_name == 'pull_request' && vars.X == 'y'", ctx({ 'github.event_name': 'push' }))
        .value,
    ).toBe(false)
    expect(
      evaluateCondition("github.event_name == 'push' || vars.X == 'y'", ctx({ 'github.event_name': 'push' })).value,
    ).toBe(true)
    expect(
      evaluateCondition("github.event_name == 'push' && vars.X == 'y'", ctx({ 'github.event_name': 'push' })).value,
    ).toBeUndefined()
    const parsed = evaluateCondition('github.event_name ==', ctx({}))
    expect(parsed.value).toBeUndefined()
    expect(parsed.parseError).toBeTruthy()
    expect(UNKNOWN).toBeTypeOf('symbol')
  })

  it('applies the implicit success() check and status functions to job dependencies', () => {
    expect(job(undefined, push, { build: 'skipped' }).shouldExecute).toBe(false)
    expect(job("github.event_name == 'push'", push, { build: 'skipped' }).shouldExecute).toBe(false)
    expect(job("always() && github.event_name == 'push'", push, { build: 'skipped' }).shouldExecute).toBe(true)
    expect(job("needs.build.result == 'skipped'", push, { build: 'skipped' }).shouldExecute).toBe(false)
    expect(job("!cancelled() && needs.build.result == 'skipped'", push, { build: 'skipped' }).shouldExecute).toBe(true)
    // A dependency GitHub decides natively leaves its dependents to native evaluation as well.
    const dependent = job(undefined, push, { changes: 'conditional' })
    expect(dependent.shouldExecute).toBe(true)
    expect(dependent.unresolved).toBe(true)
  })

  it('knows the replay event context for push and pull_request scenarios', () => {
    expect(job("github.ref == 'refs/heads/main' && github.event_name == 'push'").shouldExecute).toBe(true)
    expect(job("github.ref_name != 'main'").shouldExecute).toBe(false)
    expect(job("github.base_ref == 'main'", pr).shouldExecute).toBe(true)
    expect(job("contains(github.event.pull_request.labels.*.name, 'run-e2e')", pr).shouldExecute).toBe(true)
    expect(job('github.event.pull_request.draft == false', pr).shouldExecute).toBe(true)
    expect(job("github.repository_owner == 'bench'").shouldExecute).toBe(true)
    expect(job("github.repository == 'Org/Repo'").requiresRepoIdentityAdaptation).toBe(true)
    const native = job('github.event.pull_request.head.repo.full_name == github.repository', pr)
    expect(native.unresolved).toBe(true)
    expect(native.shouldExecute).toBe(true)
  })
})
