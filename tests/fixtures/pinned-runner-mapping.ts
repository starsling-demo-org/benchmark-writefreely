import { createDefaultRunnerMapping } from '../../src/config.ts'
import type { RunnerMappingConfig } from '../../src/types.ts'

export const FIXTURE_LARGER_RUNNER = 'ubuntu-24.04-4core'

/**
 * The default runner mapping with every Linux upstream label pinned to a 4 vCPU / 16 GiB larger-runner label on
 * the GitHub side. A GitHub-side target may never be a `-latest` alias or a standard hosted label, whose size
 * depends on the repository's visibility.
 */
export function pinnedRunnerMapping(): RunnerMappingConfig {
  const mapping = createDefaultRunnerMapping()
  for (const upstream of ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-26.04'])
    mapping.defaultMap[upstream] = {
      github: FIXTURE_LARGER_RUNNER,
      starsling: mapping.defaultMap[upstream]?.starsling ?? 'starsling-ubuntu-24.04',
    }
  mapping.runnerSpecs[FIXTURE_LARGER_RUNNER] = {
    label: FIXTURE_LARGER_RUNNER,
    provider: 'github',
    os: 'linux',
    arch: 'x64',
    vcpu: 4,
    ramGiB: 16,
    billingPerMinuteUsd: 0.016,
  }
  return mapping
}
