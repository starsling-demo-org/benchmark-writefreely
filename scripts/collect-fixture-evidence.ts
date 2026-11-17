/** Fixture-only evidence adapter. OSS workloads provide their own semantic collectors. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { computeSha256 } from '../src/config.ts'
import { parseJsonVerdicts } from '../src/collectors.ts'
import type { SampleEvidence } from '../src/evidence.ts'
import type { PreparedExperiment } from '../src/prepared.ts'
import type { ExperimentRecord } from '../src/runtime.ts'

const { values } = parseArgs({
  options: { experiment: { type: 'string' }, prepared: { type: 'string' }, out: { type: 'string' } },
})
if (!values.experiment || !values.prepared || !values.out)
  throw new Error('Required: --experiment EXPERIMENT_JSON --prepared PREPARED_JSON --out DIRECTORY')
const record: ExperimentRecord = JSON.parse(readFileSync(values.experiment, 'utf8'))
const prepared: PreparedExperiment = JSON.parse(readFileSync(values.prepared, 'utf8'))
const directory = resolve(values.out)
mkdirSync(directory, { recursive: true })
const evidence: SampleEvidence[] = []
for (const sample of record.samples) {
  if (record.config.scenarios[sample.scenarioName]?.event !== 'push')
    throw new Error('This fixture collector currently supports main-push only')
  if (!sample.complete) throw new Error(`Incomplete sample: ${sample.sampleId}`)
  const payload = prepared.variants[sample.scenarioName]?.[sample.variant]
  const profile = record.config.profiles[sample.profileName]
  if (!payload || !profile) throw new Error('Missing prepared fixture or profile')
  const root = sample.workflows.find((w) => w.workflowPath === '.github/workflows/ci.yml')
  if (!root || !sample.artifacts.some((a) => a.run_id === root.runId && a.name === 'fixture-evidence'))
    throw new Error('Missing fixture artifact')
  const artifactDir = join(directory, String(root.runId))
  if (!existsSync(artifactDir))
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(root.runId),
        '-R',
        record.config.benchmarkRepository.repository,
        '-n',
        'fixture-evidence',
        '-D',
        artifactDir,
      ],
      { stdio: 'pipe' },
    )
  const testsPath = join(artifactDir, 'results.json')
  const cachePath = join(artifactDir, 'cache.json')
  const tests = parseJsonVerdicts(readFileSync(testsPath, 'utf8'))
  if (tests.length !== 4 || tests.some((t) => !/^sum-[0-3]$/.test(t.testId)))
    throw new Error('Not the acceptance fixture')
  const cache: { hit: string } = JSON.parse(readFileSync(cachePath, 'utf8'))
  if (!['', 'true', 'false'].includes(cache.hit)) throw new Error('Invalid cache observation')
  const jobs = sample.workflows.flatMap((w) => w.jobs)
  const rows: Record<string, number> = {}
  for (const job of jobs) {
    const key = `${job.workflowPath}#${job.logicalJobId}`
    rows[key] = (rows[key] ?? 0) + 1
  }
  evidence.push({
    sampleId: sample.sampleId,
    inputFingerprint: record.manifest.inputFingerprint,
    runIds: sample.workflows.map((w) => w.runId),
    sources: [
      { path: testsPath, sha256: computeSha256(readFileSync(testsPath)), kind: 'tests', format: 'json-verdicts' },
      { path: cachePath, sha256: computeSha256(readFileSync(cachePath)), kind: 'cache' },
    ],
    execution: {
      inventory: payload.inventory,
      semanticObligationsFulfilled: Object.keys(rows),
      executedWorkflows: sample.workflows.map((w) => w.workflowPath),
      executedMatrixRowCounts: rows,
      observedCommands: jobs.flatMap((j) =>
        j.steps.filter((s) => s.name === 'Verify workload').map(() => 'node test.mjs'),
      ),
      jobOutputs: {},
      tests,
    },
    cache: {
      sampleId: sample.sampleId,
      profile,
      expectedSourceSha: record.config.upstream.commitSha,
      consumerRef: 'refs/heads/main',
      defaultBranch: 'main',
      expectedCacheKeys: ['fixture'],
      cacheEvents: [
        {
          cacheKey: 'fixture',
          matchedKey: cache.hit === 'true' ? 'fixture' : null,
          hitKind: cache.hit === 'true' ? 'exact' : 'miss',
          sourceRef: 'refs/heads/main',
        },
      ],
      coldSeedTotalSeconds:
        record.seedSamples.find((s) => s.sampleId === `${sample.sampleId}-seed`)?.metrics.rawRunnerSeconds ?? 0,
      warmSampleTotalSeconds: sample.metrics.rawRunnerSeconds ?? 0,
    },
  })
}
writeFileSync(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(join(directory, 'evidence.json'))
