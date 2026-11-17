/**
 * Evidence extractor for writefreely/writefreely CI (docker-publish.yml).
 *
 * WriteFreely's CI has no test suite: its one job builds the release image for linux/amd64 and linux/arm64. Its check
 * coverage is the build's own units: the Go binary for each target platform (`make build`), the UI (`make ui`, the same
 * for every platform) and each platform's final image stage. Units and verdicts come only from BuildKit's plain
 * progress in the replay's job log: a unit passes when BuildKit ran it to completion in this sample (`#N DONE`), fails
 * on `#N ERROR` or when it never appears, and is `reused` when BuildKit restored it from cache instead of running it.
 */
import type { EvidenceExtractor } from '../src/evidence-collect.ts'
import type { TestCaseVerdictRecord } from '../src/parity.ts'

export const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const

export interface BuildkitVertex {
  /** Target platform: `linux/arm64` for both a native `[linux/arm64 ...]` and a cross `[linux/amd64->arm64 ...]` step. */
  target: string
  stage: string
  command: string
  done: boolean
  cached: boolean
  error: boolean
}

/** BuildKit's plain-progress vertices (`#N [platform stage k/n] COMMAND` followed by `#N DONE|CACHED|ERROR`). */
export function buildkitVertices(log: string): BuildkitVertex[] {
  const vertices = new Map<string, BuildkitVertex>()
  for (const line of log.split('\n')) {
    const step = /^#(\d+) \[(linux\/\w+)(?:->(\w+))? ([\w-]+) \d+\/\d+\] (.*)$/.exec(line)
    if (step) {
      const [, id = '', platform = '', cross, stage = '', command = ''] = step
      if (!vertices.has(id))
        vertices.set(id, {
          target: cross ? `linux/${cross}` : platform,
          stage,
          command: command.replace(/\s+/g, ' ').trim(),
          done: false,
          cached: false,
          error: false,
        })
      continue
    }
    const end = /^#(\d+) (DONE|CACHED|ERROR)\b/.exec(line)
    const vertex = end ? vertices.get(end[1] ?? '') : undefined
    if (!vertex) continue
    if (end?.[2] === 'DONE') vertex.done = true
    else if (end?.[2] === 'CACHED') vertex.cached = true
    else vertex.error = true
  }
  return [...vertices.values()]
}

function verdictOf(vertices: BuildkitVertex[]): Pick<TestCaseVerdictRecord, 'verdict' | 'mode'> {
  if (!vertices.length || vertices.some((v) => v.error)) return { verdict: 'failed', mode: 'executed' }
  if (vertices.every((v) => v.done)) return { verdict: 'passed', mode: 'executed' }
  // Restored from BuildKit's cache: the unit did not run in this sample.
  if (vertices.every((v) => v.done || v.cached)) return { verdict: 'passed', mode: 'reused' }
  return { verdict: 'failed', mode: 'executed' }
}

const extract: EvidenceExtractor = ({ jobs }) => {
  const build = jobs.find((job) => job.workflowPath.endsWith('docker-publish.yml'))
  const vertices = build ? buildkitVertices(build.log) : []
  const stepPassed = build?.steps.find((s) => s.name === 'Build and push Docker images')?.conclusion === 'success'
  const units = new Map<string, BuildkitVertex[]>([
    ['ui', vertices.filter((v) => /\bmake ui\b/.test(v.command))],
    ...PLATFORMS.flatMap(
      (platform) =>
        [
          [`go-binary:${platform}`, vertices.filter((v) => v.target === platform && /\bmake build\b/.test(v.command))],
          [
            `image:${platform}`,
            vertices.filter((v) => v.target === platform && v.command.startsWith('COPY --from=build')),
          ],
        ] as [string, BuildkitVertex[]][],
    ),
  ])
  const tests: TestCaseVerdictRecord[] = [...units]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([testId, unit]) => {
      const { verdict, mode } = verdictOf(unit)
      return { testId, verdict: stepPassed ? verdict : 'failed', mode }
    })
  const passed = new Set(tests.filter((t) => t.verdict === 'passed').map((t) => t.testId))
  const obligations = PLATFORMS.filter((p) => passed.has(`go-binary:${p}`) && passed.has(`image:${p}`)).map(
    (p) => `release-image:${p}`,
  )
  if (passed.has('ui')) obligations.push('ui-assets')
  return {
    tests,
    coverage: { scope: [...units.keys()].sort(), covered: [...passed].sort() },
    obligations: obligations.sort(),
    commands: [...new Set(vertices.filter((v) => /\bmake (build|ui)\b/.test(v.command)).map((v) => v.command))].sort(),
  }
}

export default extract
