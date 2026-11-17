import { execFileSync } from 'node:child_process'

export interface CommitIdentity {
  name: string
  email: string
}
export type CommitIdentitySource = 'config' | 'environment' | 'git-config' | 'built-in'

/** Last resort only: an address no GitHub account owns, so commits made under it show no real author. */
export const BUILT_IN_COMMIT_IDENTITY: CommitIdentity = { name: 'StarSling Bench', email: 'bench@starsling.dev' }

let configuredIdentity: CommitIdentity | undefined
let warnedBuiltIn = false

/** Set from `execution.commitIdentity` when the configuration loads (undefined clears it). */
export function setConfiguredCommitIdentity(identity: CommitIdentity | undefined): void {
  configuredIdentity = identity
  warnedBuiltIn = false // a fresh configuration load gets its own one-time warning
}

function gitConfigValue(cwd: string, key: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * The one identity for every commit the harness makes (author and committer alike): `execution.commitIdentity`,
 * else the standard git environment variables, else `user.name`/`user.email` as git reads them in `cwd`, else the
 * built-in identity with a warning.
 */
export function resolveCommitIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CommitIdentity & { source: CommitIdentitySource } {
  if (configuredIdentity) return { ...configuredIdentity, source: 'config' }
  const envName = env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME
  const envEmail = env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL
  if (envName && envEmail) return { name: envName, email: envEmail, source: 'environment' }
  const name = gitConfigValue(cwd, 'user.name', env)
  const email = gitConfigValue(cwd, 'user.email', env)
  if (name && email) return { name, email, source: 'git-config' }
  if (!warnedBuiltIn) {
    warnedBuiltIn = true
    console.warn(
      `Warning: no commit identity found, so harness commits are made as "${BUILT_IN_COMMIT_IDENTITY.name} <${BUILT_IN_COMMIT_IDENTITY.email}>", which no GitHub account owns. Set execution.commitIdentity in benchmark.config.json, GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL, or git config user.name/user.email.`,
    )
  }
  return { ...BUILT_IN_COMMIT_IDENTITY, source: 'built-in' }
}

/** Environment variables that make git author and commit as the resolved identity. */
export function commitIdentityEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { name, email } = resolveCommitIdentity(cwd, env)
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
}

/** `git -C cwd`, committing as the resolved commit identity; `indexFile` stages into a temporary index. */
export function git(
  cwd: string,
  args: string[],
  options: { input?: string | Buffer; indexFile?: string } = {},
): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(options.input !== undefined ? { input: options.input } : {}),
    env: {
      // A stalled transfer (under 1 KB/s for a minute) fails instead of hanging the experiment; callers retry.
      GIT_HTTP_LOW_SPEED_LIMIT: '1000',
      GIT_HTTP_LOW_SPEED_TIME: '60',
      ...process.env,
      ...commitIdentityEnv(cwd),
      ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    },
  }).trim()
}
/** Network failures of a git transfer (dropped connection, stall, DNS) as opposed to a refusal from the remote. */
export function isTransientGitError(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : ''}${String((error as { stderr?: unknown })?.stderr ?? '')}`
  return /RPC failed|Connection reset|unexpected disconnect|remote end hung up|early EOF|Could not resolve host|Operation too slow|timed out/i.test(
    text,
  )
}
/** Unsigned `commit-tree`: harness commits are local bookkeeping, never signed with the operator's key. */
export const COMMIT_TREE = ['-c', 'commit.gpgsign=false', 'commit-tree'] as const

/**
 * Changed files between two commits, with a rename listed as its old and new path and names unquoted. `bench init`
 * records a scenario's paths with this and the replay checks them with it, so both sides always agree.
 */
export function changedPaths(sourceDir: string, before: string, after: string): string[] {
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', before, after], {
    cwd: sourceDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean)
    .sort()
}
