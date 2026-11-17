/**
 * Evidence extractor for DefinitelyTyped/DefinitelyTyped CI (CI.yml and format-and-commit.yml).
 *
 * DefinitelyTyped's CI type-checks packages; it has no line coverage. Its check coverage is the set of units
 * upstream's own selection requires: every changed, dependent and attw-affected package dtslint-runner reports,
 * the `scripts` TypeScript project, Danger on pull requests and the dprint format check on main. A unit is
 * covered when it ran and passed. Units and verdicts come only from the replay's job logs.
 */
import type { EvidenceExtractor, EvidenceJob } from '../src/evidence-collect.ts'
import type { TestCaseVerdictRecord } from '../src/parity.ts'

function packageSet(log: string, label: RegExp): string[] | undefined {
  const match = label.exec(log)
  if (!match) return undefined
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort()
}

/** Danger's observable outcome. Upstream's read-only token can read the PR but not post a status. */
export function dangerOutcome(log: string): string {
  const status = /statuses\/[0-9a-f]{40} - (\d{3})/.exec(log)
  if (status) return `status-${status[1]}`
  if (/All good|No issues found/i.test(log)) return 'clean'
  if (/Danger: (?:x|✗)|Failing the build/i.test(log)) return 'failed-checks'
  const error = /(HttpError|Error): ([^\n]{0,80})/.exec(log)
  return error ? `error:${(error[2] ?? '').trim()}` : 'no-output'
}

function stepConclusion(job: EvidenceJob, pattern: RegExp): string | null | undefined {
  return job.steps.find((s) => pattern.test(s.name))?.conclusion
}

const extract: EvidenceExtractor = ({ scenario, jobs }) => {
  const verdicts = new Map<string, TestCaseVerdictRecord['verdict']>()
  const scope = new Set<string>()
  const commands = new Set<string>()
  const obligations = new Set<string>()
  let selected = false
  for (const job of jobs) {
    const log = job.log
    const changed = packageSet(log, /^Testing \d+ changed packages: Set\(\d+\) \{(.*)\}$/m)
    const dependent = packageSet(log, /^Testing \d+ dependent packages: Set\(\d+\) \{(.*)\}$/m)
    const attw = packageSet(log, /^Testing \d+ packages from attw\.json changes: Set\(\d+\) \{(.*)\}$/m)
    if (changed) selected = true
    for (const name of [...(changed ?? []), ...(dependent ?? []), ...(attw ?? [])]) scope.add(`package:${name}`)
    for (const match of log.matchAll(/^\d+> (\S+) (\S+)/gm)) {
      const [, name, status] = match
      if (!name || status === 'START') continue
      verdicts.set(`package:${name}`, status === 'OK' ? 'passed' : 'failed')
    }
    for (const match of log.matchAll(
      /^##\[group\]Run (pnpm (?:run test-all|danger ci|dprint fmt|tsc -p \.\/scripts|exec tsc -p \.)[^\n]*)/gm,
    ))
      if (match[1]) commands.add(match[1].replace(/--shard(Count|Id) \S+/g, '--shard$1 N').trim())
    const tsc = stepConclusion(job, /tsc -p \.\/scripts/)
    if (tsc) {
      scope.add('scripts:tsc')
      verdicts.set('scripts:tsc', tsc === 'success' && !/error TS\d+/.test(log) ? 'passed' : 'failed')
    }
    const danger = stepConclusion(job, /^Run Danger$/)
    if (danger && scenario.pr) {
      const outcome = dangerOutcome(log.slice(log.lastIndexOf('pnpm danger ci')))
      scope.add('danger')
      verdicts.set('danger', danger === 'success' && !outcome.startsWith('error') ? 'passed' : 'failed')
      commands.add(`danger outcome: ${outcome}`)
    }
    const dprint = stepConclusion(job, /dprint fmt/)
    if (dprint) {
      scope.add('format:dprint')
      verdicts.set('format:dprint', dprint === 'success' && /Nothing to commit/.test(log) ? 'passed' : 'failed')
    }
  }
  const tests: TestCaseVerdictRecord[] = [...verdicts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([testId, verdict]) => ({ testId, verdict, mode: 'executed' }))
  const packages = [...scope].filter((unit) => unit.startsWith('package:'))
  if (selected && packages.every((unit) => verdicts.get(unit) === 'passed')) obligations.add('test-changed-packages')
  if (verdicts.get('scripts:tsc') === 'passed') obligations.add('typecheck-scripts')
  if (verdicts.get('danger') === 'passed') obligations.add('danger-pr-check')
  if (verdicts.get('format:dprint') === 'passed') obligations.add('format-check')
  return {
    tests,
    coverage: {
      scope: [...scope].sort(),
      covered: [...scope].filter((unit) => verdicts.get(unit) === 'passed').sort(),
    },
    obligations: [...obligations].sort(),
    commands: [...commands].sort(),
  }
}

export default extract
