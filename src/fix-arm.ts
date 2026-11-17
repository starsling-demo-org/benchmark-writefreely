/**
 * `bench showcase --fix-arm-experiment <id>`: the "StarSling + agent PRs" arm (starsling-patched) comes from a second
 * experiment record, measured after the agent PRs were fixed or changed; the github-baseline and starsling-baseline
 * arms come from the first. The second record must have run the same scenarios and profiles with the same harness
 * and config; only the patches may differ. The result is one merged record the report reads like any other.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SampleMeasurementResult } from './collector.ts'
import { type ExperimentInput, loadExperimentInput } from './commands.ts'
import { loadInterference } from './evidence-collect.ts'
import { type BoundAssessment, boundAssessment, observationHash } from './evidence.ts'
import type { ExperimentManifest } from './manifest.ts'
import type { ExperimentRecord } from './runtime.ts'
import type { BenchmarkConfig } from './types.ts'

const FIX_VARIANT = 'starsling-patched'

/** One experiment record and what sits beside it. */
export interface FixArmSource {
  input: ExperimentInput
  /** The configuration the record was run with (`experiment.json` → `config`). */
  config: BenchmarkConfig
  /** Content hash of the harness that ran it, when the record names it. */
  harnessHash?: string
  interference?: Record<string, string[]>
}

export interface FixArmInfo {
  baseId: string
  fixId: string
  /** Seconds from the base record's last sample finishing to the fix record's first sample starting (negative: the fix ran first). */
  gapSeconds: number
  /** `matched`: both records name the same harness. `not-recorded`: one or both predate the harness hash. */
  harness: 'matched' | 'not-recorded'
}

export interface FixArmMerge {
  input: ExperimentInput
  interference: Record<string, string[]>
  info: FixArmInfo
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      )
    return item
  }
  return JSON.stringify(normalize(value))
}

const names = (manifest: ExperimentManifest, pick: 'scenarioName' | 'profileName') =>
  [...new Set(manifest.samples.map((s) => s[pick]))].sort()

function manifestOf(source: FixArmSource, role: string): ExperimentManifest {
  const manifest = source.input.manifest
  if (!manifest) throw new Error(`The ${role} experiment record has no manifest`)
  return manifest
}

function checkSameRun(
  base: FixArmSource,
  fix: FixArmSource,
  baseManifest: ExperimentManifest,
  fixManifest: ExperimentManifest,
) {
  if (baseManifest.experimentId === fixManifest.experimentId)
    throw new Error('--fix-arm-experiment must name a different experiment from --experiment')
  for (const [label, key] of [
    ['scenarios', 'scenarioName'],
    ['profiles', 'profileName'],
  ] as const) {
    const a = names(baseManifest, key)
    const b = names(fixManifest, key)
    if (a.join() !== b.join())
      throw new Error(
        `The fix-arm experiment "${fixManifest.experimentId}" ran other ${label} (${b.join(', ')}) than "${baseManifest.experimentId}" (${a.join(', ')})`,
      )
  }
  const { patches: _a, ...baseRest } = base.config
  const { patches: _b, ...fixRest } = fix.config
  const keys = [...new Set([...Object.keys(baseRest), ...Object.keys(fixRest)])].sort()
  const differing = keys.filter(
    (k) => canonical((baseRest as Record<string, unknown>)[k]) !== canonical((fixRest as Record<string, unknown>)[k]),
  )
  if (differing.length)
    throw new Error(
      `The fix-arm experiment "${fixManifest.experimentId}" ran with a different configuration (${differing.join(', ')}); only the patches may differ from "${baseManifest.experimentId}"`,
    )
  if (base.harnessHash && fix.harnessHash && base.harnessHash !== fix.harnessHash)
    throw new Error(
      `The fix-arm experiment "${fixManifest.experimentId}" ran with a different harness version than "${baseManifest.experimentId}"`,
    )
}

const retarget = (sampleId: string, from: string, to: string): string =>
  sampleId.startsWith(`${from}-`) ? `${to}-${sampleId.slice(from.length + 1)}` : sampleId

const times = (samples: SampleMeasurementResult[], pick: 'startedAt' | 'completedAt'): number[] =>
  samples.flatMap((s) => s.workflows.map((w) => Date.parse(w[pick] ?? ''))).filter(Number.isFinite)

export function mergeFixArm(base: FixArmSource, fix: FixArmSource): FixArmMerge {
  const baseManifest = manifestOf(base, 'base')
  const fixManifest = manifestOf(fix, 'fix-arm')
  checkSameRun(base, fix, baseManifest, fixManifest)
  const baseId = baseManifest.experimentId
  const fixId = fixManifest.experimentId
  const fixSlots = fixManifest.samples.filter((s) => s.variant === FIX_VARIANT)
  const fixSamples = fix.input.samples.filter((s) => s.variant === FIX_VARIANT)
  if (!fixSlots.length || !fixSamples.length)
    throw new Error(`The fix-arm experiment "${fixId}" has no ${FIX_VARIANT} samples`)
  if (fix.input.samples.some((s) => s.inputFingerprint !== fixManifest.inputFingerprint))
    throw new Error(`The fix-arm experiment "${fixId}" has samples that do not match its manifest fingerprint`)

  // The merged record is the base record, with its starsling-patched slots replaced by the fix record's, re-slotted
  // under the base id and fingerprint. Evidence travels only if it was bound to the fix record as measured.
  const rewrite = (s: SampleMeasurementResult): SampleMeasurementResult => ({
    ...s,
    sampleId: retarget(s.sampleId, fixId, baseId),
    inputFingerprint: baseManifest.inputFingerprint,
  })
  const merged: ExperimentManifest = {
    ...baseManifest,
    samples: [
      ...baseManifest.samples.filter((s) => s.variant !== FIX_VARIANT),
      ...fixSlots.map((s) => ({ ...s, sampleId: retarget(s.sampleId, fixId, baseId) })),
    ],
  }
  const samples = [...base.input.samples.filter((s) => s.variant !== FIX_VARIANT), ...fixSamples.map(rewrite)]
  const assessments: Record<string, BoundAssessment> = {}
  for (const s of base.input.samples)
    if (s.variant !== FIX_VARIANT && base.input.assessments?.[s.sampleId])
      assessments[s.sampleId] = base.input.assessments[s.sampleId] as BoundAssessment
  for (const s of fixSamples) {
    const held = boundAssessment(fix.input.assessments?.[s.sampleId], s, fixManifest)
    if (!held) continue
    const moved = rewrite(s)
    assessments[moved.sampleId] = {
      ...held,
      sampleId: moved.sampleId,
      inputFingerprint: baseManifest.inputFingerprint,
      observationHash: observationHash(moved),
    }
  }
  const interference: Record<string, string[]> = {}
  for (const [id, runs] of Object.entries(base.interference ?? {}))
    if (!id.includes(`-${FIX_VARIANT}`)) interference[id] = runs
  for (const [id, runs] of Object.entries(fix.interference ?? {}))
    if (id.includes(`-${FIX_VARIANT}`)) interference[retarget(id, fixId, baseId)] = runs

  const baseEnd = Math.max(
    ...times(
      base.input.samples.filter((s) => s.variant !== FIX_VARIANT),
      'completedAt',
    ),
  )
  const fixStart = Math.min(...times(fixSamples, 'startedAt'))
  return {
    input: {
      ...base.input,
      experimentId: baseId,
      manifest: merged,
      samples,
      assessments,
    },
    interference,
    info: {
      baseId,
      fixId,
      gapSeconds: Number.isFinite(baseEnd) && Number.isFinite(fixStart) ? (fixStart - baseEnd) / 1000 : Number.NaN,
      harness: base.harnessHash && fix.harnessHash ? 'matched' : 'not-recorded',
    },
  }
}

/** "3 days 4 hours", "5 hours 10 minutes", "12 minutes": a gap in plain words. */
export function describeGap(seconds: number): string {
  const abs = Math.abs(seconds)
  const days = Math.floor(abs / 86_400)
  const hours = Math.floor((abs % 86_400) / 3600)
  const minutes = Math.floor((abs % 3600) / 60)
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const parts = days
    ? [unit(days, 'day'), ...(hours ? [unit(hours, 'hour')] : [])]
    : hours
      ? [unit(hours, 'hour'), ...(minutes ? [unit(minutes, 'minute')] : [])]
      : [unit(minutes, 'minute')]
  return parts.join(' ')
}

/** One experiment directory as a merge source: its input, the config and harness it ran with, and its interference. */
export function loadFixArmSource(inputPath: string): FixArmSource {
  const dir = dirname(inputPath)
  const recordPath = join(dir, 'experiment.json')
  if (!existsSync(recordPath)) throw new Error(`${dir} has no experiment.json`)
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as ExperimentRecord
  const interference = loadInterference(dir)
  return {
    input: loadExperimentInput(inputPath),
    config: record.config,
    ...(record.harnessHash ? { harnessHash: record.harnessHash } : {}),
    ...(interference ? { interference } : {}),
  }
}

/** Merges the experiment at `basePath` (an assessed.json or experiment.json) with experiments/<fixId> from `root`. */
export function mergeFixArmFromDisk(root: string, basePath: string, fixId: string): FixArmMerge {
  const dir = join(root, 'experiments', fixId)
  const assessed = join(dir, 'assessed.json')
  return mergeFixArm(
    loadFixArmSource(basePath),
    loadFixArmSource(existsSync(assessed) ? assessed : join(dir, 'experiment.json')),
  )
}
