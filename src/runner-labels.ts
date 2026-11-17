/** Prefix of the placeholder `bench init` writes as a GitHub target until the owner supplies a larger-runner label. */
export const GITHUB_TARGET_PLACEHOLDER_PREFIX = 'TODO-github-larger-runner-for-'

/** The placeholder GitHub target proposed for one upstream `runs-on` label. */
export const githubTargetPlaceholder = (upstreamLabel: string): string =>
  `${GITHUB_TARGET_PLACEHOLDER_PREFIX}${upstreamLabel}`

export const isGitHubTargetPlaceholder = (label: string): boolean => label.startsWith(GITHUB_TARGET_PLACEHOLDER_PREFIX)

/**
 * GitHub's standard hosted Linux and Windows labels (x64 and Arm): 4 vCPU / 16 GiB in public repositories but
 * 2 vCPU / 8 GiB in private and internal ones. macOS labels and `ubuntu-slim` are the same size in both.
 * Source: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
 */
export const isVisibilityDependentLabel = (label: string): boolean =>
  /^ubuntu-\d+\.\d+(-arm)?$/i.test(label.trim()) || /^windows-(\d{4}(-vs\d+)?|11(-vs\d+)?-arm)$/i.test(label.trim())

export const VISIBILITY_DEPENDENT_MESSAGE = 'size depends on repository visibility; use a larger-runner label'

/** `ubuntu-latest`, `macos-latest`, `windows-latest`: aliases GitHub moves, so never a benchmark target. */
export const isLatestLabel = (label: string): boolean =>
  !isGitHubTargetPlaceholder(label) && /-latest$/i.test(label.trim())
