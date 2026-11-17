import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import config from './fixtures/definitelytyped.config.ts'
import { createExperimentManifest } from '../src/manifest.ts'

it('runs the committed standalone action through a symlink outside the checkout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench standalone '))
  try {
    const entry = join(directory, 'report.mjs')
    const linkedEntry = join(directory, 'linked-report.mjs')
    const input = join(directory, 'input.json')
    const output = join(directory, 'report.json')
    copyFileSync(resolve('dist/index.js'), entry)
    symlinkSync(entry, linkedEntry)
    const manifest = createExperimentManifest({ config, experimentId: 'bundle-smoke' })
    const [requested] = manifest.samples
    if (!requested) throw new Error('fixture manifest is empty')
    const sample = {
      ...requested,
      complete: true,
      incompleteReasons: [],
      missingWorkflows: [],
      missingJobs: [],
      cancelledJobs: [],
      failedJobs: [],
      partialTimestampJobs: [],
      timestampResolution: '1s',
      metrics: {
        repoMinutes: 1,
        rawRunnerSeconds: 60,
        wallClockSeconds: 60,
        prWallClockSeconds: null,
        mainWallClockSeconds: 60,
        triggerLatencySeconds: 0,
        harnessOverheadSeconds: 0,
      },
      workflows: [],
      artifacts: [],
    }
    // bench evidence writes interference beside the record; the action reads it as the CLI does.
    writeFileSync(
      join(directory, 'interference.json'),
      JSON.stringify({ [requested.sampleId]: ['.github/workflows/cron.yml (schedule, run 7)'] }),
    )
    writeFileSync(
      input,
      JSON.stringify({
        experimentId: 'bundle-smoke',
        config,
        samples: [sample],
        manifest,
        outputJsonPath: output,
        outputCsvPath: join(directory, 'samples.csv'),
        failOnIncompleteOrParityError: false,
      }),
    )
    const result = spawnSync(process.execPath, [linkedEntry], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BENCH_REPORT_INPUT_JSON: input },
    })
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    expect(report.experimentId).toBe('bundle-smoke')
    expect(report.comparisons.flatMap((c: { interferedSamples: string[] }) => c.interferedSamples)).toEqual([
      requested.sampleId,
    ])
    expect(report.manifestIssues.length).toBeGreaterThan(0)
    expect(
      report.comparisons.every((c: { publishableHeadlineAllowed: boolean }) => !c.publishableHeadlineAllowed),
    ).toBe(true)
    const failure = spawnSync(process.execPath, [linkedEntry], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BENCH_REPORT_INPUT_JSON: join(directory, 'missing.json') },
    })
    expect(failure.status).toBe(1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
