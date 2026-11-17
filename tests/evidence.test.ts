import { describe, expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import { parseLcov } from '../src/collectors.ts'
import { computeSha256 } from '../src/config.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import { verifyEvidenceBundle, type SampleEvidence } from '../src/evidence.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'
import type { ScenarioReference } from '../src/reference.ts'

describe('assessment to report contract', () => {
  it('qualifies only complete bound evidence and invalidates it after an observation changes', async () => {
    const config = structuredClone(fixtureConfig)
    config.execution.repetitions = 5
    const manifest = createExperimentManifest({
      config,
      experimentId: 'proof',
      scenarioNames: ['main-push'],
      profileNames: ['cold'],
    })
    const samples: SampleMeasurementResult[] = manifest.samples.map((request, i) => ({
      ...request,
      inputFingerprint: manifest.inputFingerprint,
      complete: true,
      incompleteReasons: [],
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: [],
      partialTimestampJobs: [],
      timestampResolution: '1s',
      artifacts: [],
      metrics: {
        rawRunnerSeconds: 60,
        repoMinutes: 1,
        wallClockSeconds: 60,
        prWallClockSeconds: null,
        mainWallClockSeconds: 60,
        triggerLatencySeconds: 1,
        harnessOverheadSeconds: 0,
      },
      workflows: [
        {
          runId: i + 1,
          runAttempt: 1,
          priorAttemptsCount: 0,
          workflowPath: 'ci.yml',
          workflowName: 'CI',
          event: 'push',
          conclusion: 'success',
          durationSeconds: 60,
          startedAt: '2026-11-06T00:00:00Z',
          completedAt: '2026-11-06T00:01:00Z',
          htmlUrl: 'https://github.com/example/repo/actions/runs/1',
          artifacts: [],
          jobs: [
            {
              jobRecordId: i + 1,
              runId: i + 1,
              runAttempt: 1,
              workflowPath: 'ci.yml',
              jobName: 'test',
              logicalJobId: 'test',
              conclusion: 'success',
              durationSeconds: 60,
              dependencyWaitSeconds: null,
              runnerQueueSeconds: null,
              resolution: '1s',
              labels: ['ubuntu-24.04'],
              steps: [],
            },
          ],
        },
      ],
    }))
    const source = Buffer.from(JSON.stringify({ tests: [{ testId: 'sum', verdict: 'passed', mode: 'executed' }] }))
    const profile = config.profiles.cold
    if (!profile) throw new Error('Missing profile')
    const evidence: SampleEvidence[] = samples.map((sample) => ({
      sampleId: sample.sampleId,
      inputFingerprint: manifest.inputFingerprint,
      runIds: sample.workflows.map((w) => w.runId),
      sources: [{ path: 'evidence.txt', sha256: computeSha256(source), kind: 'tests' }],
      execution: {
        inventory: {
          scenarioName: 'main-push',
          triggeredWorkflows: ['ci.yml'],
          excludedWorkflows: [],
          downstreamWorkflowRuns: [],
          jobExpectations: [
            {
              workflowFile: 'ci.yml',
              workflowName: 'CI',
              jobId: 'test',
              triggeredBy: 'direct',
              expectedStatus: 'executed',
              isDynamicMatrix: false,
              mappedRunsOn: { github: 'ubuntu-24.04', starsling: 'starsling-ubuntu-24.04', retainedOnGitHub: false },
            },
          ],
          mixedRunnerOnStarSling: false,
          movedJobs: [],
          retainedJobs: [],
          blockers: [],
        },
        semanticObligationsFulfilled: ['ci.yml#test'],
        executedWorkflows: ['ci.yml'],
        executedMatrixRowCounts: { 'ci.yml#test': 1 },
        observedCommands: ['node --test'],
        jobOutputs: {},
        tests: [{ testId: 'sum', verdict: 'passed', mode: 'executed' }],
      },
      cache: {
        profile,
        expectedSourceSha: config.upstream.commitSha,
        consumerRef: 'refs/heads/main',
        defaultBranch: 'main',
        cacheEvents: [],
        inventoryVerified: true,
        expectedCacheKeys: [],
      },
    }))
    const assessments = await verifyEvidenceBundle({
      manifest,
      samples,
      evidence,
      profiles: config.profiles,
      readSource: async () => source,
    })
    // Without its same-runner baseline, a self-improving CI sample stays unassessed; the other samples still are.
    const withoutStarSlingBaseline = samples.filter((s) => s.variant !== 'starsling-baseline')
    const partial = await verifyEvidenceBundle({
      manifest,
      samples: withoutStarSlingBaseline,
      evidence: evidence.filter((e) => withoutStarSlingBaseline.some((s) => s.sampleId === e.sampleId)),
      profiles: config.profiles,
      readSource: async () => source,
    })
    expect(Object.keys(partial).sort()).toEqual(
      withoutStarSlingBaseline
        .filter((s) => s.variant !== 'starsling-patched')
        .map((s) => s.sampleId)
        .sort(),
    )
    const upstreamRun = (jobConclusion: string): ScenarioReference => ({
      schemaVersion: 1,
      scenarioName: 'main-push',
      upstreamRepository: config.upstream.repository,
      event: 'push',
      headSha: config.upstream.commitSha,
      retrievedAt: '2026-11-06T00:00:00Z',
      metrics: { wallClockSeconds: 70, runnerSeconds: 70 },
      runs: [
        {
          runId: 900,
          attempt: 1,
          workflowPath: 'ci.yml',
          workflowName: 'CI',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/upstream/repo/actions/runs/900',
          createdAt: '2026-11-01T00:00:00Z',
          startedAt: '2026-11-01T00:00:00Z',
          jobs: [
            {
              id: 1,
              name: 'test',
              status: 'completed',
              conclusion: jobConclusion,
              startedAt: '2026-11-01T00:00:00Z',
              completedAt: '2026-11-01T00:01:10Z',
              durationSeconds: 70,
              labels: ['ubuntu-24.04'],
              steps: [],
            },
          ],
        },
      ],
    })
    const withoutReference = generateExperimentReport({ experimentId: 'proof', config, manifest, samples, assessments })
    expect(withoutReference.comparisons[0]?.publishableHeadlineAllowed).toBe(false)
    expect(withoutReference.comparisons[0]?.withheldReasons.join(' ')).toContain('No upstream run is locked')
    const divergent = generateExperimentReport({
      experimentId: 'proof',
      config,
      manifest,
      samples,
      assessments,
      references: { 'main-push': upstreamRun('failure') },
    })
    expect(divergent.comparisons[0]?.upstreamParity.passed).toBe(false)
    expect(divergent.comparisons[0]?.publishableHeadlineAllowed).toBe(false)
    const references = { 'main-push': upstreamRun('success') }
    const report = generateExperimentReport({
      experimentId: 'proof',
      config,
      manifest,
      samples,
      assessments,
      references,
    })
    expect(report.comparisons[0]?.upstreamParity.passed).toBe(true)
    expect(report.comparisons[0]?.publishableHeadlineAllowed).toBe(true)
    expect(report.comparisons[0]?.evidenceLevel).toBe('test/verdict parity')
    const verify = (records: SampleEvidence[]) =>
      verifyEvidenceBundle({
        manifest,
        samples,
        evidence: records,
        profiles: config.profiles,
        readSource: async () => source,
      })
    const fabricated = structuredClone(evidence)
    const fabricatedFirst = fabricated[0]
    if (!fabricatedFirst) throw new Error('Missing evidence')
    fabricatedFirst.execution.tests = [{ testId: 'invented-success', verdict: 'passed', mode: 'executed' }]
    await expect(verify(fabricated)).rejects.toThrow('Test declarations differ')
    const noTests = structuredClone(evidence)
    const noTestsFirst = noTests[0]
    if (!noTestsFirst) throw new Error('Missing evidence')
    noTestsFirst.sources = noTestsFirst.sources.map((entry) => ({ ...entry, kind: 'context' as const }))
    await expect(verify(noTests)).rejects.toThrow('Test declarations differ')
    const fakeCoverage = structuredClone(evidence)
    const fakeCoverageFirst = fakeCoverage[0]
    if (!fakeCoverageFirst) throw new Error('Missing evidence')
    fakeCoverageFirst.execution.coverage = {
      lines: { total: 100, covered: 100, percentage: 100 },
      scopeHash: 'invented',
    }
    await expect(verify(fakeCoverage)).rejects.toThrow('Coverage declaration requires')
    const lcov = Buffer.from('SF:sum.ts\nDA:1,1\nend_of_record\n')
    const coveredEvidence = structuredClone(evidence)
    for (const record of coveredEvidence) {
      record.execution.coverage = parseLcov(lcov.toString())
      record.sources.push({ path: 'coverage.info', sha256: computeSha256(lcov), kind: 'coverage', format: 'lcov' })
    }
    const verifyCovered = () =>
      verifyEvidenceBundle({
        manifest,
        samples,
        evidence: coveredEvidence,
        profiles: config.profiles,
        readSource: async (path) => (path === 'coverage.info' ? lcov : source),
      })
    const covered = await verifyCovered()
    expect(Object.values(covered).every((assessment) => assessment.parity.satisfies01PpCoverageRequirement)).toBe(true)
    const coverageFirst = coveredEvidence[0]?.execution.coverage
    if (!coverageFirst) throw new Error('Missing coverage')
    coverageFirst.lines.percentage = 99
    await expect(verifyCovered()).rejects.toThrow('Coverage declaration differs')
    const wrongBinding = structuredClone(assessments)
    const firstAssessment = Object.values(wrongBinding)[0]
    if (!firstAssessment) throw new Error('Missing assessment')
    firstAssessment.sampleId = 'another-sample'
    expect(
      generateExperimentReport({
        experimentId: 'proof',
        config,
        manifest,
        samples,
        assessments: wrongBinding,
        references,
      }).comparisons[0]?.publishableHeadlineAllowed,
    ).toBe(false)
    const first = samples[0]
    if (!first) throw new Error('Missing sample')
    first.metrics.wallClockSeconds = 1
    const stale = generateExperimentReport({
      experimentId: 'proof',
      config,
      manifest,
      samples,
      assessments,
      references,
    })
    expect(stale.comparisons[0]?.publishableHeadlineAllowed).toBe(false)
    await expect(
      verifyEvidenceBundle({
        manifest,
        samples,
        evidence,
        profiles: config.profiles,
        readSource: async () => Buffer.from('changed'),
      }),
    ).rejects.toThrow('digest mismatch')
  })
})
