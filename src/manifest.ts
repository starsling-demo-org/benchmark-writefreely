import { computeSha256 } from './config.ts'
import { deterministicShuffleOrder } from './cache-lifecycle.ts'
import type { BenchmarkConfig, VariantId } from './types.ts'
import type { SampleMeasurementResult } from './collector.ts'
export const VARIANTS: VariantId[] = ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched']
/** A warm sample's seed attempts: `<sample>-seed`, then `<sample>-seed-r2`, `-r3`, ... */
export const seedSampleId = (sampleId: string, attempt: number): string =>
  `${sampleId}-seed${attempt === 1 ? '' : `-r${attempt}`}`
/** A failed or voided sample's replacement: `<sample>-retry1`, `-retry2`, ... It fills the same slot. */
export const replacementSampleId = (sampleId: string, replacement: number): string => `${sampleId}-retry${replacement}`
/** The manifest sample whose slot an attempt fills: strips the replacement suffix. */
export const slotSampleId = (sampleId: string): string => sampleId.replace(/-retry\d+$/, '')
export const isSeedOf = (seedId: string, sampleId: string): boolean => seedId.startsWith(`${sampleId}-seed`)
export interface RequestedSample {
  sampleId: string
  scenarioName: string
  profileName: string
  variant: VariantId
  repetition: number
}
export interface ExperimentManifest {
  schemaVersion: 1
  experimentId: string
  inputFingerprint: string
  samples: RequestedSample[]
}
export function createExperimentManifest(params: {
  experimentId: string
  config: BenchmarkConfig
  inputFingerprint?: string
  scenarioNames?: string[]
  profileNames?: string[]
  variants?: VariantId[]
  /** Overrides `execution.repetitions` (repetitions do not change prepared payloads). */
  repetitions?: number
}): ExperimentManifest {
  const { config, experimentId } = params
  const repetitions = params.repetitions ?? config.execution.repetitions
  if (!/^[a-zA-Z0-9_-]+$/.test(experimentId))
    throw new Error('Experiment ID must use letters, digits, underscore or dash')
  // Seed-only scenarios (cache producers) run as warm seeds, not as measured samples, unless selected.
  const scenarios =
    params.scenarioNames ?? Object.keys(config.scenarios).filter((name) => config.scenarios[name]?.role !== 'seed')
  const profiles = params.profileNames ?? Object.keys(config.profiles)
  const variants = params.variants ?? VARIANTS
  for (const [kind, values, allowed] of [
    ['scenario', scenarios, Object.keys(config.scenarios)],
    ['profile', profiles, Object.keys(config.profiles)],
    ['variant', variants, VARIANTS],
  ] as const) {
    if (
      !values.length ||
      new Set(values).size !== values.length ||
      values.some((v) => !/^[a-zA-Z0-9_-]+$/.test(v) || !(allowed as readonly string[]).includes(v))
    )
      throw new Error(`Invalid or empty ${kind} selection`)
  }
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('repetitions must be a positive integer')
  const samples: RequestedSample[] = []
  for (const scenarioName of scenarios)
    for (const profileName of profiles)
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        for (const variant of deterministicShuffleOrder(
          variants,
          `${experimentId}:${scenarioName}:${profileName}:${repetition}`,
        ))
          samples.push({
            sampleId: `${experimentId}-${scenarioName}-${profileName}-rep${repetition}-${variant}`,
            scenarioName,
            profileName,
            variant,
            repetition,
          })
      }
  return {
    schemaVersion: 1,
    experimentId,
    inputFingerprint: params.inputFingerprint ?? computeSha256(JSON.stringify(config)),
    samples,
  }
}
export function sampleKey(s: RequestedSample): string {
  return JSON.stringify([s.scenarioName, s.profileName, s.variant, s.repetition])
}
export function reconcileSamples(manifest: ExperimentManifest, samples: SampleMeasurementResult[]): string[] {
  const issues: string[] = []
  if (manifest.schemaVersion !== 1 || !manifest.samples.length || !manifest.inputFingerprint)
    issues.push('Invalid or empty experiment manifest')
  const expected = new Map(manifest.samples.map((s) => [sampleKey(s), s]))
  if (expected.size !== manifest.samples.length) issues.push('Duplicate requested sample')
  const seen = new Set<string>()
  const ids = new Set<string>()
  // A slot may hold failed or voided attempts (excluded, replaced) next to its one complete sample.
  const attempts = new Map<string, SampleMeasurementResult[]>()
  for (const s of samples) attempts.set(sampleKey(s), [...(attempts.get(sampleKey(s)) ?? []), s])
  for (const [key, list] of attempts)
    if (list.filter((s) => s.complete).length > 1) issues.push(`Duplicate sample: ${list[0]?.sampleId ?? key}`)
  for (const s of samples) {
    const key = sampleKey(s)
    if (ids.has(s.sampleId)) issues.push(`Duplicate sample: ${s.sampleId}`)
    seen.add(key)
    ids.add(s.sampleId)
    if (!expected.has(key)) issues.push(`Unrequested sample: ${s.sampleId}`)
    if (expected.get(key)?.sampleId !== slotSampleId(s.sampleId)) issues.push(`Sample identity mismatch: ${s.sampleId}`)
    if (s.inputFingerprint !== manifest.inputFingerprint) issues.push(`Input fingerprint mismatch: ${s.sampleId}`)
    // A replaced attempt failed before it was measured fully; only a slot's counted samples need timings.
    if ((attempts.get(key) ?? []).some((other) => other !== s && other.complete) && !s.complete) continue
    if (!s.workflows.some((w) => w.jobs.some((j) => j.conclusion !== 'skipped')))
      issues.push(`No executed jobs: ${s.sampleId}`)
    if (
      s.metrics.wallClockSeconds === null ||
      s.metrics.repoMinutes === null ||
      !Number.isFinite(s.metrics.wallClockSeconds) ||
      !Number.isFinite(s.metrics.repoMinutes) ||
      s.metrics.wallClockSeconds < 0 ||
      s.metrics.repoMinutes < 0
    )
      issues.push(`Invalid timing: ${s.sampleId}`)
  }
  for (const [key, s] of expected) if (!seen.has(key)) issues.push(`Missing sample: ${s.sampleId}`)
  return issues
}
/** The samples that count: every one except a failed or voided attempt whose slot has a complete sample. */
export function countedSamples(samples: SampleMeasurementResult[]): SampleMeasurementResult[] {
  const filled = new Set(samples.filter((s) => s.complete).map(sampleKey))
  return samples.filter((s) => s.complete || !filled.has(sampleKey(s)))
}
/** Requested samples whose slot has no complete sample yet (a replaced attempt does not count). */
export function unfilledSlots(manifest: ExperimentManifest, samples: SampleMeasurementResult[]): RequestedSample[] {
  return manifest.samples.filter((r) => !samples.some((s) => s.complete && sampleKey(s) === sampleKey(r)))
}
