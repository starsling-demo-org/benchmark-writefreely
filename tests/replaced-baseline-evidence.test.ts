import { describe, expect, it } from 'vitest'
import fixtureConfig from './fixtures/definitelytyped.config.ts'
import { computeSha256 } from '../src/config.ts'
import { createExperimentManifest } from '../src/manifest.ts'
import { verifyEvidenceBundle, type SampleEvidence } from '../src/evidence.ts'
import { generateExperimentReport } from '../src/reporter.ts'
import type { SampleMeasurementResult } from '../src/collector.ts'

describe('replaced baseline slot', () => {
  it('compares against the complete retry of a replaced baseline, not the failed attempt', async () => {
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
    // The github-baseline of repetition 1 failed and was replaced by a complete -retry1.
    const original = samples.find((s) => s.variant === 'github-baseline' && s.repetition === 1)
    const originalEvidence = evidence.find((e) => e.sampleId === original?.sampleId)
    if (!original || !originalEvidence) throw new Error('Missing baseline')
    const retry = { ...structuredClone(original), sampleId: `${original.sampleId}-retry1` }
    const retryEvidence = { ...structuredClone(originalEvidence), sampleId: retry.sampleId }
    const failed = {
      ...original,
      complete: false,
      incompleteReasons: ['Workflow not successful: CI: failure'],
      failedJobs: ['ci.yml#test'],
    }
    const all = [failed, retry, ...samples.filter((s) => s !== original)]
    const records = [retryEvidence, ...evidence.filter((e) => e !== originalEvidence)]
    const assessments = await verifyEvidenceBundle({
      manifest,
      samples: all,
      evidence: records,
      profiles: config.profiles,
      readSource: async () => source,
    })
    const patched = samples.find((s) => s.variant === 'github-patched' && s.repetition === 1)
    expect(Object.keys(assessments)).toContain(patched?.sampleId)
    expect(Object.keys(assessments)).not.toContain(failed.sampleId)
    const report = generateExperimentReport({ experimentId: 'proof', config, manifest, samples: all, assessments })
    expect(report.comparisons[0]?.evidenceLevel).toBe('test/verdict parity')
    expect(
      report.comparisons[0]?.samples.find((s) => s.variant === 'github-baseline' && s.repetition === 1)?.complete,
    ).toBe(true)
  })
})
