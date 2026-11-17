import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { computeParityInputFingerprint, computeSha256 } from './config.ts'
import { verifyDeterministicRegeneration } from './generator.ts'
import { setConfiguredCommitIdentity } from './git.ts'
import { object } from './github.ts'
import { inspectRepository } from './inventory.ts'
import { evaluateParityGates, type VariantExecutionEvidence, verifyParityCertificateValid } from './parity.ts'
import { currentHarnessHash } from './prepared.ts'
import type { generateExperimentReport } from './reporter.ts'
import type { ExperimentRecord } from './runtime.ts'
import { type GitHubReplayBackend, ReplayStagingController } from './staging.ts'
import type { BenchmarkConfig, BenchmarkLockfile } from './types.ts'

export const BENCH_COMMANDS = [
  'init',
  'reference',
  'inspect',
  'prepare',
  'verify',
  'run',
  'collect',
  'parity',
  'evidence',
  'report',
  'showcase',
  'publish',
  'recover',
] as const
export type BenchCommandName = (typeof BENCH_COMMANDS)[number]

export interface BenchCommandResponse<T = unknown> {
  command: BenchCommandName
  ok: boolean
  data: T
  errors?: string[]
}

export function executeBenchInspect(params: {
  upstreamSourceDir: string
  config: BenchmarkConfig
}): BenchCommandResponse<ReturnType<typeof inspectRepository>> {
  const inventory = inspectRepository(params.upstreamSourceDir, params.config)
  return {
    command: 'inspect',
    ok: inventory.blockers.length === 0,
    data: inventory,
    ...(inventory.blockers.length > 0
      ? { errors: inventory.blockers.map((b) => `[${b.category}] ${b.evidence}`) }
      : {}),
  }
}

export function executeBenchVerify(params: {
  upstreamSourceDir: string
  workRootDir: string
  config: BenchmarkConfig
  lockfile: BenchmarkLockfile
  scenarioName: string
  profileName: string
  parityEvidence?: {
    baseline: VariantExecutionEvidence
    candidate: VariantExecutionEvidence
  }
}): BenchCommandResponse<{
  regenerationVerified: boolean
  regenerationMismatches: string[]
  certificateValid: boolean
  parityEvaluation?: ReturnType<typeof evaluateParityGates>
}> {
  const { upstreamSourceDir, workRootDir, config, lockfile, scenarioName, profileName, parityEvidence } = params
  const expectedLocks = lockfile.variantTrees[scenarioName]
  if (!expectedLocks) {
    return {
      command: 'verify',
      ok: false,
      data: {
        regenerationVerified: false,
        regenerationMismatches: [`Scenario "${scenarioName}" not found in lockfile.variantTrees`],
        certificateValid: false,
      },
      errors: [`Scenario "${scenarioName}" not found in lockfile`],
    }
  }
  const regen = verifyDeterministicRegeneration({
    upstreamSourceDir,
    workRootDir,
    config,
    patches: lockfile.patches,
    expectedVariantLocks: expectedLocks,
  })
  const currentFp = computeParityInputFingerprint({
    config,
    scenarioName,
    profileName,
    lockedPatches: lockfile.patches,
  })
  const certCheck = verifyParityCertificateValid(
    lockfile.parityCertificates[`${scenarioName}::${profileName}`],
    currentFp,
  )
  let parityEval: ReturnType<typeof evaluateParityGates> | undefined
  if (parityEvidence) {
    const profile = config.profiles[profileName]
    parityEval = evaluateParityGates({
      baseline: parityEvidence.baseline,
      candidate: parityEvidence.candidate,
      allowTestResultReuse: profile?.testResultReuseAllowed ?? false,
      adaptationBlocksFullParity: config.adaptations.some((a) => a.blocksFullParity),
    })
  }
  const ok = regen.verified && (parityEval ? parityEval.passed : certCheck.valid)
  const errors: string[] = [...regen.mismatches]
  if (parityEval && !parityEval.passed)
    errors.push(...parityEval.structural.issues, ...parityEval.observed.issues, ...parityEval.semantic.issues)
  else if (!parityEval && !certCheck.valid && certCheck.reason) errors.push(certCheck.reason)
  return {
    command: 'verify',
    ok,
    data: {
      regenerationVerified: regen.verified,
      regenerationMismatches: regen.mismatches,
      certificateValid: certCheck.valid,
      ...(parityEval ? { parityEvaluation: parityEval } : {}),
    },
    ...(errors.length > 0 ? { errors } : {}),
  }
}

export async function executeBenchRecover(params: {
  stagingStateFilePath: string
  replayBackend: GitHubReplayBackend
}): Promise<BenchCommandResponse<Awaited<ReturnType<ReplayStagingController['recover']>>>> {
  const controller = new ReplayStagingController(params.stagingStateFilePath, params.replayBackend)
  return { command: 'recover', ok: true, data: await controller.recover() }
}

export async function loadConfig(path: string): Promise<BenchmarkConfig> {
  const value: unknown = path.endsWith('.json')
    ? JSON.parse(readFileSync(path, 'utf8'))
    : (await import(pathToFileURL(path).href)).default
  const config = object(value) as unknown as BenchmarkConfig
  if (
    config.schemaVersion !== 1 ||
    !config.upstream ||
    !config.scenarios ||
    !config.profiles ||
    !config.execution ||
    !Array.isArray(config.patches)
  )
    throw new Error('Invalid benchmark configuration schema')
  const identity = config.execution.commitIdentity
  if (identity !== undefined) {
    const valid = (v: unknown) => typeof v === 'string' && v.trim() !== ''
    if (!identity || !valid(identity.name) || !valid(identity.email))
      throw new Error('execution.commitIdentity needs a non-empty name and email')
  }
  setConfiguredCommitIdentity(identity)
  return config
}

/** Prepared payloads for one configuration and harness version live in one deterministic directory. */
export function defaultPreparedDir(root: string, config: BenchmarkConfig): string {
  const key = computeSha256(`${JSON.stringify(config)}:${currentHarnessHash()}`).slice(0, 12)
  return join(root, '.bench-work', 'prepared', key)
}

export interface ExperimentInput {
  experimentId: string
  manifest?: ExperimentRecord['manifest']
  samples: ExperimentRecord['samples']
  apiUsage?: ExperimentRecord['apiUsage']
  assessments?: Parameters<typeof generateExperimentReport>[0]['assessments']
}

export function loadExperimentInput(inputPath: string): ExperimentInput {
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as ExperimentInput
  if (!Array.isArray(input.samples)) throw new Error(`${inputPath} is not an experiment record`)
  return { ...input, experimentId: input.manifest?.experimentId ?? input.experimentId }
}
