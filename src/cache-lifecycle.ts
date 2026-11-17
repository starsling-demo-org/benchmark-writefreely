import type { CacheArtifactProfile, ExternalCacheAdapterSpec, RestoreExpectation } from './types.ts'

export interface ObservedCacheEvent {
  producerSampleId?: string
  producerRunId?: number
  sourceCommitSha?: string
  inputFingerprint?: string
  cacheKey: string
  requestedRestoreKeys?: string[]
  matchedKey: string | null
  hitKind: 'exact' | 'restore-key-fallback' | 'miss'
  sourceRef: string
  isNestedSetupActionCache?: boolean
  populateSeconds?: number
  saveSeconds?: number
  /** Set on events read from BuildKit's `type=gha` layer cache (one per build) rather than actions/cache. */
  buildkit?: { done: number; cached: number; error: number; imported: boolean; exported: boolean }
}

export interface ArtifactSeedRecord {
  artifactName: string
  producerScenario: string
  producerRunId: number
  sourceCommitSha: string
  sha256: string
  inputFingerprint: string
  sizeInBytes: number
}

export interface ArtifactConsumptionEvent {
  artifactName: string
  consumerWorkflow: string
  consumerJobId: string
  isCrossRun: boolean
  seedRunId?: number
  observedSha256: string
  observedSourceSha: string
  observedInputFingerprint: string
}

export interface CacheLifecycleValidationResult {
  profileName: string
  mode: CacheArtifactProfile['actionsCache']
  valid: boolean
  contaminated: boolean
  violations: string[]
  cacheEvents: ObservedCacheEvent[]
  artifactEvents: ArtifactConsumptionEvent[]
  costBreakdown: {
    coldPopulationSeconds: number
    coldSaveSeconds: number
    warmConsumerSeconds: number
    amortizationHorizonRuns: number | null
    amortizedTotalSeconds: number | null
  }
}

/**
 * Enforces GitHub Actions cache scope rules:
 * A workflow run on `consumerRef` (with `baseRef` and `defaultBranch`) can only restore caches created on:
 * - the exact same `consumerRef`
 * - the target `baseRef` (for PRs)
 * - the repository's `defaultBranch`
 * Caches created on another PR or unrelated feature branch are out-of-scope.
 */
export function isCacheVisibleInGitHubScope(params: {
  cacheProducerRef: string
  consumerRef: string
  consumerBaseRef?: string
  defaultBranch: string
}): boolean {
  const { cacheProducerRef, consumerRef, consumerBaseRef, defaultBranch } = params
  const norm = (r: string) => r.replace(/^refs\/heads\//, '')
  const prod = norm(cacheProducerRef)
  const cons = norm(consumerRef)
  const def = norm(defaultBranch)
  const base = consumerBaseRef ? norm(consumerBaseRef) : undefined

  if (prod === cons) return true
  if (prod === def) return true
  if (base && prod === base) return true
  return false
}

export function deterministicShuffleOrder<T>(items: readonly T[], seedText: string): T[] {
  const arr = [...items]
  let h = 2166136261
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = arr.length - 1; i > 0; i--) {
    h ^= i + 1
    h = Math.imul(h, 16777619)
    const j = Math.abs(h) % (i + 1)
    const tmp = arr[i]
    const swapVal = arr[j]
    if (tmp !== undefined && swapVal !== undefined) {
      arr[i] = swapVal
      arr[j] = tmp
    }
  }
  return arr
}

export function validateCacheAndArtifactLifecycle(params: {
  sampleId?: string
  expectedCacheKeys?: string[]
  inventoryVerified?: boolean
  profile: CacheArtifactProfile
  expectedSourceSha: string
  consumerRef: string
  consumerBaseRef?: string
  defaultBranch: string
  cacheEvents: ObservedCacheEvent[]
  seedArtifacts?: Record<string, ArtifactSeedRecord>
  artifactEvents?: ArtifactConsumptionEvent[]
  baselineWithinScenarioProducers?: string[]
  candidateWithinScenarioProducers?: string[]
  patchExplicitlyIntroducesCrossRunReuse?: boolean
  coldSeedTotalSeconds?: number
  warmSampleTotalSeconds?: number
  externalAdapterStates?: { adapter: ExternalCacheAdapterSpec; stateKnownAndClean: boolean }[]
}): CacheLifecycleValidationResult {
  const {
    profile,
    expectedSourceSha,
    consumerRef,
    consumerBaseRef,
    defaultBranch,
    cacheEvents,
    seedArtifacts = {},
    artifactEvents = [],
    baselineWithinScenarioProducers = [],
    candidateWithinScenarioProducers = [],
    patchExplicitlyIntroducesCrossRunReuse = false,
    coldSeedTotalSeconds = 0,
    warmSampleTotalSeconds = 0,
    externalAdapterStates = [],
  } = params

  const violations: string[] = []
  let contaminated = false
  if (!params.inventoryVerified && cacheEvents.length === 0) violations.push('Cache inventory/observations are missing')
  for (const key of params.expectedCacheKeys ?? [])
    if (!cacheEvents.some((e) => e.cacheKey === key)) violations.push(`Missing cache observation: ${key}`)
  for (const adapter of profile.externalCacheAdapters ?? [])
    if (!externalAdapterStates.some((e) => e.adapter.id === adapter.id && e.stateKnownAndClean))
      violations.push(`Missing verified external state: ${adapter.id}`)

  // 1. Verify external cache / persistent disk / Docker cache adapters have known, controlled state
  for (const ext of externalAdapterStates) {
    if (!ext.stateKnownAndClean && profile.actionsCache !== 'unmanaged-diagnostic') {
      contaminated = true
      violations.push(
        `External cache adapter "${ext.adapter.id}" (${ext.adapter.kind}) is in an unknown or unreset state, invalidating controlled ${profile.actionsCache} result.`,
      )
    }
  }

  // 2. Never remove within-scenario artifact producers merely to manufacture a warm result
  for (const prodArt of baselineWithinScenarioProducers) {
    if (!candidateWithinScenarioProducers.includes(prodArt) && !patchExplicitlyIntroducesCrossRunReuse) {
      violations.push(
        `Within-scenario artifact producer "${prodArt}" was removed without an optimization patch introducing verified cross-run reuse.`,
      )
    }
  }

  // 3. Evaluate cold vs warm cache events
  let coldPopulationSeconds = 0
  let coldSaveSeconds = 0

  for (const evt of cacheEvents) {
    coldPopulationSeconds += evt.populateSeconds ?? 0
    coldSaveSeconds += evt.saveSeconds ?? 0

    if (profile.actionsCache === 'cold') {
      if (
        (evt.hitKind !== 'miss' || evt.matchedKey !== null) &&
        !(params.sampleId && evt.producerSampleId === params.sampleId && evt.producerRunId !== undefined)
      ) {
        contaminated = true
        violations.push(
          `Cache contamination detected in cold profile: cache key "${evt.cacheKey}" hit "${evt.matchedKey}" (${evt.hitKind}).`,
        )
      }
    } else if (profile.actionsCache === 'warm') {
      // Check GitHub branch/PR cache visibility scope
      if (evt.hitKind !== 'miss') {
        const visible = isCacheVisibleInGitHubScope({
          cacheProducerRef: evt.sourceRef,
          consumerRef,
          ...(consumerBaseRef ? { consumerBaseRef } : {}),
          defaultBranch,
        })
        if (!visible) {
          contaminated = true
          violations.push(
            `Out-of-scope warm cache hit on "${evt.cacheKey}": cache produced on "${evt.sourceRef}" is not visible to "${consumerRef}" under GitHub cache scope rules.`,
          )
        }
      }

      const expectation: RestoreExpectation = profile.restoreExpectations[evt.cacheKey] ?? 'required-hit'
      if (expectation === 'required-hit' && evt.hitKind === 'miss') {
        violations.push(`Warm profile missed required cache key "${evt.cacheKey}".`)
      }
    }
  }

  // Check if any required-hit expectation was never even queried
  if (profile.actionsCache === 'warm') {
    for (const [expectedKey, expMode] of Object.entries(profile.restoreExpectations)) {
      if (expMode === 'required-hit') {
        const found = cacheEvents.some((e) => e.cacheKey === expectedKey || e.cacheKey.startsWith(expectedKey))
        if (!found) {
          violations.push(`Required warm cache key "${expectedKey}" was never queried by any workflow step.`)
        }
      }
    }
  }

  // 4. Verify cross-run artifact seed provenance
  for (const artEvt of artifactEvents) {
    if (!artEvt.isCrossRun) continue
    if (profile.crossRunArtifacts === 'none') {
      violations.push(
        `Cross-run artifact "${artEvt.artifactName}" consumed in profile "${profile.name}" where crossRunArtifacts="none".`,
      )
      continue
    }

    const seed = seedArtifacts[artEvt.artifactName]
    if (!seed) {
      violations.push(`Missing locked artifact seed provenance for cross-run artifact "${artEvt.artifactName}".`)
      continue
    }
    if (artEvt.seedRunId !== seed.producerRunId)
      violations.push(`Artifact producer run mismatch: ${artEvt.artifactName}`)
    if (seed.sourceCommitSha !== expectedSourceSha || artEvt.observedSourceSha !== expectedSourceSha) {
      violations.push(
        `Artifact seed "${artEvt.artifactName}" source SHA mismatch: seed=${seed.sourceCommitSha}, observed=${artEvt.observedSourceSha}, expected=${expectedSourceSha}.`,
      )
    }
    if (seed.sha256 !== artEvt.observedSha256) {
      violations.push(
        `Corrupt or mismatched artifact seed "${artEvt.artifactName}": expected digest ${seed.sha256}, observed ${artEvt.observedSha256}.`,
      )
    }
    if (seed.inputFingerprint !== artEvt.observedInputFingerprint) {
      violations.push(
        `Artifact seed "${artEvt.artifactName}" input fingerprint mismatch: expected ${seed.inputFingerprint}, observed ${artEvt.observedInputFingerprint}.`,
      )
    }
  }

  const horizon = profile.amortizationHorizonRuns ?? null
  const effectiveColdSeedCost =
    coldSeedTotalSeconds > 0 ? coldSeedTotalSeconds : coldPopulationSeconds + coldSaveSeconds
  const amortizedTotalSeconds =
    profile.actionsCache === 'warm' && horizon !== null && horizon > 0
      ? Number((warmSampleTotalSeconds + effectiveColdSeedCost / horizon).toFixed(2))
      : null

  return {
    profileName: profile.name,
    mode: profile.actionsCache,
    valid: violations.length === 0 && !contaminated,
    contaminated,
    violations,
    cacheEvents,
    artifactEvents,
    costBreakdown: {
      coldPopulationSeconds,
      coldSaveSeconds,
      warmConsumerSeconds: warmSampleTotalSeconds,
      amortizationHorizonRuns: horizon,
      amortizedTotalSeconds,
    },
  }
}
