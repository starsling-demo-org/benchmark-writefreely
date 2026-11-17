/**
 * `bench showcase --fix-arm-experiment <id>`: the StarSling + agent PRs arm comes from a second experiment record,
 * the other two arms from the first. These tests cover the validation (same scenario, profiles, harness and config
 * except patches) and the merge. The merged report and README are covered in tests/showcase-layout.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import { type BoundAssessment, boundAssessment, observationHash } from '../src/evidence.ts'
import { type FixArmSource, mergeFixArm } from '../src/fix-arm.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import type { BenchmarkConfig } from '../src/types.ts'

const baseConfig: BenchmarkConfig = structuredClone(fixtureConfig)
const DAY = 86_400_000
const at = (ms: number) => new Date(Date.UTC(2026, 10, 6) + ms).toISOString()

function source(
  experimentId: string,
  options: {
    config?: BenchmarkConfig
    harnessHash?: string
    startMs?: number
    fingerprint?: string
    scenarioNames?: string[]
    profileNames?: string[]
    variants?: Parameters<typeof createExperimentManifest>[0]['variants']
    interference?: Record<string, string[]>
  } = {},
): FixArmSource {
  const config = options.config ?? baseConfig
  const manifest = createExperimentManifest({
    config,
    experimentId,
    inputFingerprint: options.fingerprint ?? `fp-${experimentId}`,
    scenarioNames: options.scenarioNames ?? ['main-push'],
    profileNames: options.profileNames ?? ['cold'],
    ...(options.variants ? { variants: options.variants } : {}),
    repetitions: 2,
  })
  const start = options.startMs ?? 0
  const samples = manifest.samples.map((request, i) => {
    const started = start + i * 600_000
    return {
      ...request,
      inputFingerprint: manifest.inputFingerprint,
      complete: true,
      workflows: [{ runId: 1, startedAt: at(started), completedAt: at(started + 300_000), jobs: [] }],
      metrics: { wallClockSeconds: 300 },
    } as unknown as SampleMeasurementResult
  })
  const assessments = Object.fromEntries(
    samples.map((s): [string, BoundAssessment] => [
      s.sampleId,
      {
        sampleId: s.sampleId,
        inputFingerprint: manifest.inputFingerprint,
        observationHash: observationHash(s),
        sourceHashes: ['0'.repeat(64)],
      } as unknown as BoundAssessment,
    ]),
  )
  return {
    input: { experimentId, manifest, samples, assessments },
    config,
    ...(options.harnessHash ? { harnessHash: options.harnessHash } : {}),
    ...(options.interference ? { interference: options.interference } : {}),
  }
}
const withPatches = (patchCount: number): BenchmarkConfig => ({
  ...structuredClone(baseConfig),
  patches: baseConfig.patches.slice(0, patchCount),
})

describe('mergeFixArm', () => {
  it('takes starsling-patched from the fix record and the other arms from the base record', () => {
    const base = source('base', { harnessHash: 'h1', startMs: 0 })
    const fix = source('fix', { harnessHash: 'h1', startMs: 3 * DAY, config: withPatches(1) })
    const { input, info } = mergeFixArm(base, fix)
    const bySample = (v: string) => input.samples.filter((s) => s.variant === v)
    expect(bySample('github-baseline').every((s) => s.sampleId.startsWith('base-'))).toBe(true)
    expect(bySample('starsling-baseline').every((s) => s.sampleId.startsWith('base-'))).toBe(true)
    // Fix samples are re-slotted into the base manifest under its id and fingerprint.
    expect(bySample('starsling-patched')).toHaveLength(2)
    expect(bySample('starsling-patched').every((s) => s.sampleId.startsWith('base-'))).toBe(true)
    expect(
      bySample('starsling-patched').every((s) => s.inputFingerprint === base.input.manifest?.inputFingerprint),
    ).toBe(true)
    expect(input.manifest?.experimentId).toBe('base')
    expect(input.manifest?.samples.map((s) => s.sampleId).sort()).toEqual(input.samples.map((s) => s.sampleId).sort())
    expect(info).toMatchObject({ baseId: 'base', fixId: 'fix', harness: 'matched' })
    // Gap: the fix record's first sample started 3 days after the base record's last sample finished (minus 1 sample).
    const baseEnd = Math.max(
      ...base.input.samples
        .filter((s) => s.variant !== 'starsling-patched')
        .map((s) => Date.parse(s.workflows[0]?.completedAt ?? '')),
    )
    const fixStart = Math.min(
      ...fix.input.samples
        .filter((s) => s.variant === 'starsling-patched')
        .map((s) => Date.parse(s.workflows[0]?.startedAt ?? '')),
    )
    expect(info.gapSeconds).toBe((fixStart - baseEnd) / 1000)
    expect(info.gapSeconds).toBeGreaterThan((2 * DAY) / 1000)
  })

  it('keeps the evidence of a fix sample, rebound to the merged identity, and drops evidence that did not hold', () => {
    const base = source('base', { harnessHash: 'h1' })
    const fix = source('fix', { harnessHash: 'h1', startMs: DAY })
    const { input } = mergeFixArm(base, fix)
    for (const s of input.samples)
      expect(boundAssessment(input.assessments?.[s.sampleId], s, input.manifest as never)).toBeDefined()
    // A fix assessment bound to a different observation is not carried over, so that sample is unverified.
    const broken = source('fix', { harnessHash: 'h1', startMs: DAY })
    const first = broken.input.samples.find((s) => s.variant === 'starsling-patched' && s.repetition === 1)
    if (!first || !broken.input.assessments?.[first.sampleId]) throw new Error('fixture')
    broken.input.assessments[first.sampleId] = {
      ...broken.input.assessments[first.sampleId],
      observationHash: 'x',
    } as never
    const merged = mergeFixArm(base, broken).input
    const rebound = merged.samples.find((s) => s.variant === 'starsling-patched' && s.repetition === 1)
    expect(rebound && merged.assessments?.[rebound.sampleId]).toBeUndefined()
  })

  it('carries over interference by sample, under the merged ids', () => {
    const base = source('base', {
      harnessHash: 'h1',
      interference: { 'base-main-push-cold-rep1-github-baseline': ['run 9'] },
    })
    const fix = source('fix', {
      harnessHash: 'h1',
      startMs: DAY,
      interference: {
        'fix-main-push-cold-rep2-starsling-patched': ['run 7'],
        'fix-main-push-cold-rep2-github-baseline': ['run 8'],
      },
    })
    const { interference } = mergeFixArm(base, fix)
    expect(interference).toEqual({
      'base-main-push-cold-rep1-github-baseline': ['run 9'],
      'base-main-push-cold-rep2-starsling-patched': ['run 7'],
    })
  })

  it('refuses a fix record whose config differs from the base config in anything but patches, naming the key', () => {
    const base = source('base', { harnessHash: 'h1' })
    const changed = structuredClone(withPatches(1))
    changed.execution = { ...changed.execution, repetitions: changed.execution.repetitions + 1 }
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h1', config: changed }))).toThrow(/execution/)
    const otherUpstream = { ...withPatches(1), upstream: { ...baseConfig.upstream, commitSha: 'f'.repeat(40) } }
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h1', config: otherUpstream }))).toThrow(/upstream/)
    // Different patches are the one thing allowed to differ.
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h1', config: withPatches(1) }))).not.toThrow()
  })

  it('refuses a fix record that ran other scenarios or profiles', () => {
    const base = source('base', { harnessHash: 'h1', profileNames: ['cold'] })
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h1', profileNames: ['cold', 'warm'] }))).toThrow(
      /profiles/,
    )
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h1', scenarioNames: ['pr-single-package'] }))).toThrow(
      /scenarios/,
    )
  })

  it('refuses a different harness, and says so plainly when a record does not name its harness', () => {
    const base = source('base', { harnessHash: 'h1' })
    expect(() => mergeFixArm(base, source('fix', { harnessHash: 'h2' }))).toThrow(/harness/)
    expect(mergeFixArm(base, source('fix', { harnessHash: 'h1' })).info.harness).toBe('matched')
    expect(mergeFixArm(base, source('fix')).info.harness).toBe('not-recorded')
    expect(mergeFixArm(source('base'), source('fix', { harnessHash: 'h1' })).info.harness).toBe('not-recorded')
  })

  it('refuses a fix record with no starsling-patched samples, or the same record twice', () => {
    const base = source('base', { harnessHash: 'h1' })
    expect(() =>
      mergeFixArm(base, source('fix', { harnessHash: 'h1', variants: ['github-baseline', 'starsling-baseline'] })),
    ).toThrow(/starsling-patched/)
    expect(() => mergeFixArm(base, source('base', { harnessHash: 'h1' }))).toThrow(/different/)
  })

  it('refuses a fix record whose samples do not carry its own manifest fingerprint', () => {
    const fix = source('fix', { harnessHash: 'h1' })
    fix.input.samples[0] = { ...fix.input.samples[0], inputFingerprint: 'other' } as SampleMeasurementResult
    expect(() => mergeFixArm(source('base', { harnessHash: 'h1' }), fix)).toThrow(/fingerprint/)
  })
})
