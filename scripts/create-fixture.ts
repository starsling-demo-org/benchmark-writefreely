/** Creates a deterministic local workload for exercising the native replay controller. */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createDefaultProfiles, createDefaultRunnerMapping } from '../src/config.ts'
import type { BenchmarkConfig } from '../src/types.ts'

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    config: { type: 'string' },
    repository: { type: 'string' },
    runner: { type: 'string' },
  },
})
if (!values.source || !values.config || !values.repository)
  throw new Error('Required: --source NEW_DIRECTORY --config OUTPUT_JSON --repository OWNER/DEDICATED_REPLAY')
const source = resolve(values.source)
if (existsSync(source) || existsSync(values.config)) throw new Error('Fixture source and configuration must not exist')
mkdirSync(source, { recursive: true })
cpSync(new URL('../examples/native-fixture', import.meta.url), source, { recursive: true })
const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
git('init', '-b', 'main')
git('config', 'user.name', 'Benchmark Fixture')
git('config', 'user.email', 'bench@starsling.dev')
writeFileSync(join(source, '.gitignore'), '.cache/\nresults.json\ncache.json\n')
const commit = (message: string) => {
  git('add', '-A')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
const baseSha = commit('Fixture base')
writeFileSync(
  join(source, 'test.mjs'),
  `${readFileSync(join(source, 'test.mjs'), 'utf8')}\n// Native event workload change.\n`,
)
const headSha = commit('Fixture workload')
const runnerMapping = createDefaultRunnerMapping()
if (values.runner) for (const mapping of Object.values(runnerMapping.defaultMap)) mapping.starsling = values.runner
const profiles = createDefaultProfiles()
if (profiles.warm) profiles.warm.crossRunArtifacts = 'none'
const config: BenchmarkConfig = {
  schemaVersion: 1,
  instrumentation: true,
  upstream: { repository: values.repository, commitSha: headSha, defaultBranch: 'main' },
  benchmarkRepository: { repository: values.repository, defaultBranch: 'main', controlBranch: 'bench/control' },
  scenarios: {
    'main-push': {
      name: 'main-push',
      description: 'Fixture main event',
      event: 'push',
      main: { branch: 'main', beforeSha: baseSha, afterSha: headSha, changedPaths: ['test.mjs'] },
      referenceRuns: [],
    },
    'pr-synchronize': {
      name: 'pr-synchronize',
      description: 'Fixture PR event',
      event: 'pull_request',
      pr: {
        baseRef: 'main',
        headRef: 'bench/fixture-pr',
        baseSha,
        headSha,
        mergeSha: headSha,
        activityType: 'synchronize',
        changedPaths: ['test.mjs'],
        labels: [],
      },
      referenceRuns: [],
    },
  },
  patches: [],
  adaptations: [],
  runnerMapping,
  profiles,
  collectors: [{ id: 'tests', kind: 'json-verdicts', artifactOrPath: 'fixture-evidence/results.json', required: true }],
  execution: {
    repetitions: 1,
    timeoutMinutes: 5,
    pollIntervalSeconds: 5,
    maxConcurrentExperiments: 1,
    publicRepoGitHubFree: false,
  },
}
mkdirSync(dirname(resolve(values.config)), { recursive: true })
writeFileSync(values.config, `${JSON.stringify(config, null, 2)}\n`)
console.log(JSON.stringify({ source, config: resolve(values.config), baseSha, headSha }))
