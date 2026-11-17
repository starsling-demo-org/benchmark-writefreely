import { describe, expect, it } from 'vitest'
import { validateCacheAndArtifactLifecycle } from '../src/cache-lifecycle.ts'
import { parseBuildkitLog } from '../src/buildkit-log.ts'
import { type EvidenceJob, observeCacheEvents } from '../src/evidence-collect.ts'
import type { CacheArtifactProfile } from '../src/types.ts'

// Plain-progress output as `docker/build-push-action` prints it with
// `cache-from: type=gha` and `cache-to: type=gha,mode=max`.
const COLD = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 [internal] load metadata for docker.io/library/golang:1.23
#2 DONE 0.6s

#3 importing cache manifest from gha:1234567890123456789
#3 DONE 0.2s

#4 [linux/amd64 build 1/4] FROM docker.io/library/golang:1.23
#4 DONE 3.1s

#5 [linux/amd64 build 2/4] COPY go.mod go.sum ./
#5 DONE 0.1s

#6 [linux/amd64 build 3/4] RUN go mod download
#6 DONE 21.4s

#7 [linux/amd64 build 4/4] RUN make build
#7 DONE 80.2s

#8 exporting to GitHub Actions Cache
#8 preparing build cache for export
#8 writing layer sha256:aaaa
#8 writing cache image manifest sha256:bbbb
#8 DONE 9.0s
`
const WARM = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 importing cache manifest from gha:1234567890123456789
#2 DONE 0.4s

#3 [linux/amd64 build 1/4] FROM docker.io/library/golang:1.23
#3 CACHED

#4 [linux/amd64 build 2/4] COPY go.mod go.sum ./
#4 CACHED

#5 [linux/amd64 build 3/4] RUN go mod download
#5 CACHED

#6 [linux/amd64 build 4/4] RUN make build
#6 DONE 80.2s

#7 exporting to GitHub Actions Cache
#7 DONE 2.0s
`
const ERROR_BUILD = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 importing cache manifest from gha:1234567890123456789
#2 ERROR: failed to configure gha cache importer: invalid response status 404 Not Found

#3 [linux/amd64 build 1/2] RUN make build
#3 ERROR: process "/bin/sh -c make build" did not complete successfully: exit code: 2
`
// Real shape from a pilot run: BuildKit prints "#10 DONE" twice inside ONE build, between the cache import
// and the first CACHED step.
const REPEATED_DONE = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#10 [internal] load metadata for docker.io/library/golang:1.23
#10 DONE 0.5s

#14 importing cache manifest from gha:123
#14 DONE 0.3s

#10 DONE 0.5s

#16 [linux/amd64 build 1/2] FROM docker.io/library/golang:1.23
#16 CACHED

#17 [linux/amd64 build 2/2] RUN make build
#17 CACHED
`
const TWO_BUILDS = `${COLD}\n${WARM}`
const NO_GHA = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 [1/2] FROM alpine
#2 CACHED
`

describe('BuildKit plain-progress parser', () => {
  it('counts steps and sees the gha import and export in a cold build', () => {
    expect(parseBuildkitLog(COLD)).toEqual([
      {
        done: 8,
        cached: 0,
        error: 0,
        cacheImports: [{ id: 'gha:1234567890123456789', failed: false }],
        cacheExports: 1,
      },
    ])
  })
  it('counts CACHED steps in a warm build', () => {
    expect(parseBuildkitLog(WARM)).toEqual([
      {
        done: 4,
        cached: 3,
        error: 0,
        cacheImports: [{ id: 'gha:1234567890123456789', failed: false }],
        cacheExports: 1,
      },
    ])
  })
  it('flags a failed import and failed steps', () => {
    expect(parseBuildkitLog(ERROR_BUILD)).toEqual([
      {
        done: 1,
        cached: 0,
        error: 2,
        cacheImports: [{ id: 'gha:1234567890123456789', failed: true }],
        cacheExports: 0,
      },
    ])
  })
  it('splits several builds in one log where step numbers restart', () => {
    expect(parseBuildkitLog(TWO_BUILDS).map((b) => b.cached)).toEqual([0, 3])
  })
  it('keeps one build when BuildKit repeats a "#N DONE" for an already-ended vertex', () => {
    expect(parseBuildkitLog(REPEATED_DONE)).toEqual([
      {
        done: 4,
        cached: 2,
        error: 0,
        cacheImports: [{ id: 'gha:123', failed: false }],
        cacheExports: 0,
      },
    ])
  })
  it('still splits two builds that each start with their own load build definition', () => {
    expect(parseBuildkitLog(`${REPEATED_DONE}\n${COLD}`).map((b) => [b.cached, b.cacheImports.length])).toEqual([
      [2, 1],
      [0, 1],
    ])
  })
  it('reports builds without gha lines (and empty logs) with no imports or exports', () => {
    expect(parseBuildkitLog(NO_GHA)).toEqual([{ done: 1, cached: 1, error: 0, cacheImports: [], cacheExports: 0 }])
    expect(parseBuildkitLog('Run actions/checkout\nnothing here')).toEqual([])
  })
})

const job = (log: string): EvidenceJob => ({
  workflowPath: '.github/workflows/docker.yml',
  jobName: 'image',
  logicalJobId: 'image',
  runId: 7,
  jobId: 70,
  conclusion: 'success',
  steps: [],
  log,
})
const sample = {
  sampleId: 's1',
  workflows: [{ startedAt: '2026-11-06T10:00:00Z' }],
} as unknown as Parameters<typeof observeCacheEvents>[0]['sample']
const caches = [
  { key: 'index-buildx-buildkit', ref: 'refs/heads/main', created_at: '2026-11-06T09:00:00Z' },
  { key: 'buildkit-blob-1-sha256:aaaa', ref: 'refs/heads/main', created_at: '2026-11-06T09:00:00Z' },
]
const observe = (log: string) => observeCacheEvents({ sample, jobs: [job(log)], caches })

describe('BuildKit cache events', () => {
  it('records a cold build as a miss', () => {
    const [event, ...rest] = observe(COLD)
    expect(rest).toEqual([])
    expect(event).toMatchObject({ cacheKey: 'buildkit-gha', matchedKey: null, hitKind: 'miss' })
    expect(event?.buildkit).toMatchObject({ cached: 0, done: 8, imported: true, exported: true })
  })
  it('records an import with CACHED steps as a hit bound to the producing ref', () => {
    expect(observe(WARM)[0]).toMatchObject({
      cacheKey: 'buildkit-gha',
      matchedKey: 'gha:1234567890123456789',
      hitKind: 'exact',
      sourceRef: 'refs/heads/main',
    })
  })
  it('records a hit when BuildKit repeats a "#N DONE" inside the build', () => {
    expect(observe(REPEATED_DONE)[0]).toMatchObject({
      cacheKey: 'buildkit-gha',
      matchedKey: 'gha:123',
      hitKind: 'exact',
    })
    expect(validate('warm', REPEATED_DONE)).toMatchObject({ valid: true })
  })
  it('does not count a failed import, or CACHED steps without an import, as a hit', () => {
    expect(observe(ERROR_BUILD)[0]?.hitKind).toBe('miss')
    expect(observe(NO_GHA)).toEqual([])
  })
  it('keeps actions/cache events and BuildKit events side by side', () => {
    const restore = '##[group]Run actions/cache@abc\nwith:\n  key: k1\n##[endgroup]\nCache not found for input keys: k1'
    expect(observe(`${restore}\n${WARM}`).map((e) => e.cacheKey)).toEqual(['buildkit-gha', 'k1'])
  })
})

const profile = (mode: 'cold' | 'warm'): CacheArtifactProfile => ({
  name: mode,
  actionsCache: mode,
  crossRunArtifacts: 'none',
  restoreExpectations: {},
  testResultReuseAllowed: false,
})
const validate = (mode: 'cold' | 'warm', log: string) =>
  validateCacheAndArtifactLifecycle({
    profile: profile(mode),
    expectedSourceSha: 'a'.repeat(40),
    consumerRef: 'refs/heads/main',
    defaultBranch: 'main',
    inventoryVerified: true,
    cacheEvents: observe(log),
  })

describe('claim gating on BuildKit cache evidence', () => {
  it('verifies a cold sample whose build imported nothing from cache', () => {
    expect(validate('cold', COLD)).toMatchObject({ valid: true, contaminated: false })
  })
  it('rejects a cold sample that reused an imported cache', () => {
    const result = validate('cold', WARM)
    expect(result.contaminated).toBe(true)
    expect(result.valid).toBe(false)
  })
  it('verifies a warm sample with an import and CACHED steps', () => {
    expect(validate('warm', WARM)).toMatchObject({ valid: true, contaminated: false })
  })
  it('does not verify a warm sample whose import found nothing', () => {
    const result = validate('warm', COLD)
    expect(result.valid).toBe(false)
    expect(result.violations.join(' ')).toContain('buildkit-gha')
  })
  it('leaves a build with no BuildKit gha cache lines unobserved (no event, no violation)', () => {
    expect(validate('warm', NO_GHA).valid).toBe(true)
  })
})
