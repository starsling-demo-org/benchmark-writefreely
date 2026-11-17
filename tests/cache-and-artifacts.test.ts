import { describe, expect, it } from 'vitest'
import { isCacheVisibleInGitHubScope, validateCacheAndArtifactLifecycle } from '../src/cache-lifecycle.ts'
import type { CacheArtifactProfile } from '../src/types.ts'

describe('Stage 4: Cold/warm cache and artifact lifecycle adapters', () => {
  const coldProfile: CacheArtifactProfile = {
    name: 'cold',
    actionsCache: 'cold',
    crossRunArtifacts: 'none',
    restoreExpectations: {},
    testResultReuseAllowed: false,
  }

  const warmProfile: CacheArtifactProfile = {
    name: 'warm',
    actionsCache: 'warm',
    crossRunArtifacts: 'seeded',
    seedScenario: 'main-push',
    seedSourceRevision: 'a'.repeat(40),
    restoreExpectations: {
      'linux-pnpm-store-exact': 'required-hit',
      'setup-cache:actions/setup-node:pnpm': 'required-hit',
      'optional-turbo-cache': 'allowed-miss',
    },
    testResultReuseAllowed: true,
    amortizationHorizonRuns: 10,
  }

  it('validates cold cache misses with measured population and save costs, and flags cold cache contamination', () => {
    const cleanCold = validateCacheAndArtifactLifecycle({
      profile: coldProfile,
      expectedSourceSha: 'a'.repeat(40),
      consumerRef: 'refs/heads/bench/pr/1/head',
      consumerBaseRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-abc',
          matchedKey: null,
          hitKind: 'miss',
          sourceRef: 'refs/heads/bench/pr/1/head',
          populateSeconds: 24.5,
          saveSeconds: 6.2,
        },
      ],
    })
    expect(cleanCold.valid).toBe(true)
    expect(cleanCold.contaminated).toBe(false)
    expect(cleanCold.costBreakdown.coldPopulationSeconds).toBeCloseTo(24.5)
    expect(cleanCold.costBreakdown.coldSaveSeconds).toBeCloseTo(6.2)

    // Cold run with unexpected hit -> contaminated!
    const contaminatedCold = validateCacheAndArtifactLifecycle({
      profile: coldProfile,
      expectedSourceSha: 'a'.repeat(40),
      consumerRef: 'refs/heads/bench/pr/1/head',
      consumerBaseRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-abc',
          matchedKey: 'linux-pnpm-store-abc',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
      ],
    })
    expect(contaminatedCold.valid).toBe(false)
    expect(contaminatedCold.contaminated).toBe(true)
    expect(contaminatedCold.violations[0]).toContain('Cache contamination detected in cold profile')
  })

  it('validates warm hits, restore-key fallback, nested setup-action caches, PR cache scope, and amortized costs', () => {
    // Valid warm run with exact hit on nested setup-action cache, restore-key fallback on pnpm store, and allowed miss on turbo
    const validWarm = validateCacheAndArtifactLifecycle({
      profile: warmProfile,
      expectedSourceSha: 'a'.repeat(40),
      consumerRef: 'refs/heads/bench/pr/1/head',
      consumerBaseRef: 'refs/heads/main',
      defaultBranch: 'main',
      coldSeedTotalSeconds: 40,
      warmSampleTotalSeconds: 12,
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-exact',
          requestedRestoreKeys: ['linux-pnpm-store-'],
          matchedKey: 'linux-pnpm-store-base123',
          hitKind: 'restore-key-fallback',
          sourceRef: 'refs/heads/main',
        },
        {
          cacheKey: 'setup-cache:actions/setup-node:pnpm',
          matchedKey: 'setup-cache:actions/setup-node:pnpm',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
          isNestedSetupActionCache: true,
        },
        {
          cacheKey: 'optional-turbo-cache',
          matchedKey: null,
          hitKind: 'miss',
          sourceRef: 'refs/heads/bench/pr/1/head',
        },
      ],
    })

    expect(validWarm.valid).toBe(true)
    expect(validWarm.contaminated).toBe(false)
    expect(validWarm.costBreakdown.warmConsumerSeconds).toBe(12)
    // Amortized over 10 runs: 12 + 40 / 10 = 16.0 s
    expect(validWarm.costBreakdown.amortizedTotalSeconds).toBe(16)

    // PR cache scope check: cache created on another PR branch is NOT visible and invalidates warm sample
    expect(
      isCacheVisibleInGitHubScope({
        cacheProducerRef: 'refs/heads/bench/pr/other-pr/head',
        consumerRef: 'refs/heads/bench/pr/1/head',
        consumerBaseRef: 'refs/heads/main',
        defaultBranch: 'main',
      }),
    ).toBe(false)

    const outOfScopeWarm = validateCacheAndArtifactLifecycle({
      profile: warmProfile,
      expectedSourceSha: 'a'.repeat(40),
      consumerRef: 'refs/heads/bench/pr/1/head',
      consumerBaseRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-exact',
          matchedKey: 'linux-pnpm-store-exact',
          hitKind: 'exact',
          sourceRef: 'refs/heads/bench/pr/999-unrelated/head',
        },
        {
          cacheKey: 'setup-cache:actions/setup-node:pnpm',
          matchedKey: 'setup-cache:actions/setup-node:pnpm',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
      ],
    })
    expect(outOfScopeWarm.valid).toBe(false)
    expect(outOfScopeWarm.contaminated).toBe(true)
    expect(outOfScopeWarm.violations[0]).toContain('Out-of-scope warm cache hit')
  })

  it('enforces artifact producer/consumer provenance and rejects missing/corrupt seeds, source mismatches, or stripped within-scenario producers', () => {
    const sha = 'a'.repeat(40)
    // 1. Removing within-scenario artifact producer without cross-run patch is rejected
    const strippedProducer = validateCacheAndArtifactLifecycle({
      profile: warmProfile,
      expectedSourceSha: sha,
      consumerRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-exact',
          matchedKey: 'linux-pnpm-store-exact',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
        {
          cacheKey: 'setup-cache:actions/setup-node:pnpm',
          matchedKey: 'setup-cache:actions/setup-node:pnpm',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
      ],
      baselineWithinScenarioProducers: ['dist-bundle'],
      candidateWithinScenarioProducers: [],
      patchExplicitlyIntroducesCrossRunReuse: false,
    })
    expect(strippedProducer.valid).toBe(false)
    expect(
      strippedProducer.violations.some((v) =>
        v.includes('Within-scenario artifact producer "dist-bundle" was removed'),
      ),
    ).toBe(true)

    // 2. Corrupt seed SHA-256 or mismatched source SHA is rejected
    const corruptSeed = validateCacheAndArtifactLifecycle({
      profile: warmProfile,
      expectedSourceSha: sha,
      consumerRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [
        {
          cacheKey: 'linux-pnpm-store-exact',
          matchedKey: 'linux-pnpm-store-exact',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
        {
          cacheKey: 'setup-cache:actions/setup-node:pnpm',
          matchedKey: 'setup-cache:actions/setup-node:pnpm',
          hitKind: 'exact',
          sourceRef: 'refs/heads/main',
        },
      ],
      seedArtifacts: {
        'compiled-types': {
          artifactName: 'compiled-types',
          producerScenario: 'main-push',
          producerRunId: 5001,
          sourceCommitSha: sha,
          sha256: 'expected-digest-111',
          inputFingerprint: 'fp-111',
          sizeInBytes: 4096,
        },
      },
      artifactEvents: [
        {
          artifactName: 'compiled-types',
          consumerWorkflow: '.github/workflows/ci.yml',
          consumerJobId: 'test',
          isCrossRun: true,
          seedRunId: 5001,
          observedSha256: 'corrupted-digest-999',
          observedSourceSha: 'b'.repeat(40),
          observedInputFingerprint: 'fp-111',
        },
      ],
    })
    expect(corruptSeed.valid).toBe(false)
    expect(corruptSeed.violations.some((v) => v.includes('source SHA mismatch'))).toBe(true)
    expect(corruptSeed.violations.some((v) => v.includes('Corrupt or mismatched artifact seed'))).toBe(true)

    // 3. Unknown state on external/persistent-disk adapter invalidates controlled run
    const unknownDisk = validateCacheAndArtifactLifecycle({
      profile: coldProfile,
      expectedSourceSha: sha,
      consumerRef: 'refs/heads/main',
      defaultBranch: 'main',
      cacheEvents: [],
      externalAdapterStates: [
        {
          adapter: {
            id: 'starsling-disk-1',
            kind: 'persistent-disk',
            resetCommand: 'starsling disk reset',
          },
          stateKnownAndClean: false,
        },
      ],
    })
    expect(unknownDisk.valid).toBe(false)
    expect(unknownDisk.contaminated).toBe(true)
  })
})
