import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type Scalar } from 'yaml'
import { computeSha256 } from './config.ts'
import { resolveGitHubRunner } from './github-runners.ts'
import { VARIANTS } from './manifest.ts'
import {
  findMatrixCollision,
  keepOriginalValueInName,
  matrixRunsOnKey,
  planMatrixRunsOn,
  rewriteMatrixValues,
} from './matrix-runners.ts'
import { inspectRepository } from './inventory.ts'
import { resolveJobRunnerMapping } from './inventory-helpers.ts'
import { computeDirectoryHash, materializeVariantSourceTrees } from './patcher.ts'
import type {
  BenchmarkConfig,
  LockedPatchRecord,
  RepositoryAdaptationRule,
  RepositoryInventory,
  VariantId,
  VariantTreeLock,
} from './types.ts'

export interface GeneratedVariantArtifact {
  variant: VariantId
  treeDir: string
  inventory: RepositoryInventory
  lock: VariantTreeLock
  appliedAdaptations: {
    ruleId: string
    workflowFile: string
    jobId?: string
    description: string
  }[]
}

export interface PreparedReplayBundle {
  baselineInventory: RepositoryInventory
  patchedInventory: RepositoryInventory
  variants: Record<VariantId, GeneratedVariantArtifact>
  divergenceLedgerMarkdown: string
}

/**
 * Every string scalar under `node` (map values and sequence items, not keys). Adaptation match counts in
 * `bench init` and their application here use this one traversal, so the counts it locks always agree.
 */
export function visitStringScalars(node: unknown, visit: (scalar: Scalar<string>) => void): void {
  if (isScalar(node) && typeof node.value === 'string') visit(node as Scalar<string>)
  else if (isMap(node)) for (const pair of node.items) visitStringScalars(pair.value, visit)
  else if (isSeq(node)) for (const item of node.items) visitStringScalars(item, visit)
}

function transformWorkflowContentForVariant(params: {
  workflowRelPath: string
  rawContent: string
  provider: 'github' | 'starsling'
  isPatched: boolean
  config: BenchmarkConfig
}): {
  content: string
  movedJobs: string[]
  retainedJobs: string[]
  appliedAdaptations: GeneratedVariantArtifact['appliedAdaptations']
} {
  const { workflowRelPath, rawContent, provider, isPatched, config } = params
  const doc = parseDocument(rawContent)
  const movedJobs: string[] = []
  const retainedJobs: string[] = []
  const appliedAdaptations: GeneratedVariantArtifact['appliedAdaptations'] = []

  const root = doc.contents
  if (isMap(root)) {
    const jobsNode = root.get('jobs', true)
    if (isMap(jobsNode)) {
      for (const pair of jobsNode.items) {
        if (!isScalar(pair.key)) continue
        const jobId = String(pair.key.value)
        const jobMap = pair.value
        if (!isMap(jobMap)) continue

        if (config.instrumentation) {
          const steps = jobMap.get('steps', true)
          if (isSeq(steps))
            steps.items.unshift(
              doc.createNode({
                name: 'Benchmark event context (harness)',
                shell: 'bash',
                env: { BENCH_PARENT: `\${{ github.event.workflow_run.id }}`, BENCH_JOB: `\${{ github.job }}` },
                run: 'printf "BENCH_PARENT_RUN_ID=%s\\nBENCH_JOB_ID=%s\\n" "$BENCH_PARENT" "$BENCH_JOB"',
              }),
            )
        }
        const runsOnNode = jobMap.get('runs-on', true)
        if (runsOnNode !== undefined) {
          const origRunsOn = isScalar(runsOnNode)
            ? String(runsOnNode.value)
            : ((doc.toJS() as { jobs?: Record<string, { 'runs-on'?: string | string[] }> }).jobs?.[jobId]?.[
                'runs-on'
              ] ?? 'ubuntu-latest')

          const mapping = resolveJobRunnerMapping(workflowRelPath, jobId, origRunsOn, config.runnerMapping)
          const targetRunner = provider === 'starsling' ? mapping.starsling : mapping.github
          const qualifiedJob = `${workflowRelPath}#${jobId}`

          // `runs-on: ${{ matrix.<key> }}` with literal matrix values: the values are rewritten, runs-on is not.
          const matrixKey = mapping.kind === 'override' ? undefined : matrixRunsOnKey(origRunsOn)
          const matrixPlan =
            matrixKey === undefined
              ? undefined
              : planMatrixRunsOn(
                  (doc.toJS() as { jobs?: Record<string, Record<string, unknown>> }).jobs?.[jobId] ?? {},
                  matrixKey,
                )
          if (matrixKey !== undefined && matrixPlan !== undefined && !('problem' in matrixPlan)) {
            let targets: Record<string, string> = {}
            let anyMoved = false
            if (provider === 'starsling') {
              for (const value of matrixPlan.values) {
                const m = resolveJobRunnerMapping(workflowRelPath, jobId, value, config.runnerMapping)
                targets[value] = m.retainedOnGitHub ? value : m.starsling
                anyMoved ||= !m.retainedOnGitHub
              }
              const clash = findMatrixCollision(targets)
              if (clash) throw new Error(`StarSling runner mapping: ${qualifiedJob} (runs-on ${origRunsOn}): ${clash}`)
            } else {
              const github = resolveGitHubRunner(workflowRelPath, jobId, origRunsOn, config.runnerMapping, matrixPlan)
              if (github.problem) throw new Error(`GitHub runner mapping: ${github.problem}`)
              targets = github.matrixTargets ?? {}
            }
            if (anyMoved) movedJobs.push(qualifiedJob)
            else retainedJobs.push(qualifiedJob)
            const renamed: Record<string, string> = {}
            for (const [from, to] of Object.entries(targets)) if (from !== to) renamed[to] = from
            rewriteMatrixValues(jobMap, matrixKey, (v) => targets[v] ?? v)
            // A job name that shows the matrix value keeps showing the original value, so check names stay the same.
            const nameNode = jobMap.get('name', true)
            if (isScalar(nameNode) && typeof nameNode.value === 'string')
              nameNode.value = keepOriginalValueInName(nameNode.value, matrixKey, renamed)
            continue
          }

          if (provider === 'starsling') {
            if (mapping.retainedOnGitHub) {
              retainedJobs.push(qualifiedJob)
            } else {
              movedJobs.push(qualifiedJob)
            }
          } else {
            retainedJobs.push(qualifiedJob)
          }

          if (provider === 'starsling' && !mapping.retainedOnGitHub) jobMap.set('runs-on', targetRunner)
          if (provider === 'github') {
            // Every GitHub-side job runs on an explicit pinned label, so results do not move with upstream's
            // aliases or with the benchmark repository's visibility.
            const github = resolveGitHubRunner(workflowRelPath, jobId, origRunsOn, config.runnerMapping, matrixPlan)
            if (github.problem) throw new Error(`GitHub runner mapping: ${github.problem}`)
            if (github.target !== undefined && github.target !== origRunsOn) jobMap.set('runs-on', github.target)
          }
        }
      }
    }
  }

  // Scope edits to YAML scalar values inside the specified job, never the entire file.
  for (const rule of config.adaptations) {
    if (rule.workflowFile && rule.workflowFile !== workflowRelPath) continue
    if (rule.kind === 'workflow-setting') {
      // Structural edit (for example, workflow permissions); the parent node must already exist.
      const path = [...(rule.jobId ? ['jobs', rule.jobId] : []), ...(rule.setPath ?? [])]
      if (!rule.setPath?.length || (path.length > 1 && !doc.hasIn(path.slice(0, -1))))
        throw new Error(`Adaptation ${rule.id} has no settable path ${path.join('.')} in ${workflowRelPath}`)
      doc.setIn(path, doc.createNode(rule.setValue))
      appliedAdaptations.push({
        ruleId: rule.id,
        workflowFile: workflowRelPath,
        ...(rule.jobId ? { jobId: rule.jobId } : {}),
        description: rule.reason,
      })
      continue
    }
    const jobs = isMap(root) ? root.get('jobs', true) : undefined
    const target = rule.jobId && isMap(jobs) ? jobs.get(rule.jobId, true) : root
    let matches = 0
    visitStringScalars(target, (scalar) => {
      const parts = scalar.value.split(rule.fromPattern)
      if (parts.length < 2) return
      matches += parts.length - 1
      scalar.value = parts.join(rule.toReplacement)
    })
    const expected = isPatched
      ? (rule.expectedMatchesPatched ?? rule.expectedMatches ?? 1)
      : (rule.expectedMatches ?? 1)
    if (matches !== expected)
      throw new Error(
        `Adaptation ${rule.id} expected ${expected} match(es) in ${isPatched ? 'patched' : 'baseline'} ${workflowRelPath}, found ${matches}${matches === 0 && /^[\w-]+:\s/.test(rule.fromPattern) ? ` (patterns match YAML values, not \`key: value\` lines; drop "${rule.fromPattern.split(':')[0]}:")` : ''}`,
      )
    appliedAdaptations.push({
      ruleId: rule.id,
      workflowFile: workflowRelPath,
      ...(rule.jobId ? { jobId: rule.jobId } : {}),
      description: rule.reason,
    })
  }
  const outputText = doc.toString({ lineWidth: 0 })

  return {
    content: outputText,
    movedJobs: movedJobs.sort(),
    retainedJobs: retainedJobs.sort(),
    appliedAdaptations,
  }
}

export function renderDivergenceLedger(params: {
  config: BenchmarkConfig
  patches: LockedPatchRecord[]
  variants: Record<VariantId, GeneratedVariantArtifact>
}): string {
  const { config, patches, variants } = params
  const lines: string[] = [
    '# Benchmark Replay Divergence & Parity Ledger (`BENCH-OVERRIDES.md`)',
    '',
    `- **Upstream Repository:** \`${config.upstream.repository}\``,
    `- **Pinned Commit SHA:** \`${config.upstream.commitSha}\``,
    `- **Benchmark Repository:** \`${config.benchmarkRepository.repository}\``,
    '',
    '## 1. Patch Stack (Materialized Before Workflow Discovery)',
    '',
  ]

  if (patches.length === 0) {
    lines.push('No patches configured (baseline-only configuration).', '')
  } else {
    // Only a stacked baseline gets the extra column, so a stack without flags renders as it always did.
    const stacked = patches.some((p) => p.inBaseline)
    if (stacked)
      lines.push(
        'Patches marked "In baseline" are applied to the baseline trees too: the baseline is upstream + those patches, not bare upstream.',
        '',
      )
    lines.push(
      `| Order | Patch ID | Source | Resolved Revision | SHA-256 |${stacked ? ' In baseline |' : ''}`,
      `|---|---|---|---|---|${stacked ? '---|' : ''}`,
    )
    patches.forEach((p, idx) => {
      lines.push(
        `| ${idx + 1} | \`${p.id}\` | \`${p.source}\` | \`${p.resolvedRevision.slice(0, 12)}\` | \`${p.sha256.slice(0, 16)}...\` |${stacked ? ` ${p.inBaseline ? 'Yes' : 'No'} |` : ''}`,
      )
    })
    lines.push('')
  }

  lines.push('## 2. Explicit Repository Adaptations', '')
  if (config.adaptations.length === 0) {
    lines.push('No repository adaptations configured.', '')
  } else {
    lines.push(
      '| Rule ID | Kind | Scope | Pattern -> Replacement | Blocks Full Parity | Reason |',
      '|---|---|---|---|---|---|',
    )
    for (const rule of config.adaptations) {
      const scope = `${rule.workflowFile ?? '*'}${rule.jobId ? `#${rule.jobId}` : ''}`
      lines.push(
        `| \`${rule.id}\` | \`${rule.kind}\` | \`${scope}\` | \`${rule.fromPattern}\` -> \`${rule.toReplacement}\` | ${rule.blocksFullParity ? 'Yes' : 'No'} | ${rule.reason} |`,
      )
    }
    lines.push('')
  }

  lines.push('## 3. Runner Mappings & Mixed-Runner Classification', '')
  lines.push(
    '| Variant | Mixed-Runner Pipeline | Moved Jobs (StarSling) | Retained Jobs (GitHub) |Combined Hash |',
    '|---|---|---|---|---|',
  )
  for (const variantId of VARIANTS) {
    const v = variants[variantId]
    lines.push(
      `| \`${variantId}\` | ${v.lock.mixedRunner ? '**Yes (mixed-runner)**' : 'No'} | ${v.lock.movedJobs.length} (${v.lock.movedJobs.join(', ') || 'none'}) | ${v.lock.retainedJobs.length} (${v.lock.retainedJobs.join(', ') || 'none'}) | \`${v.lock.combinedHash.slice(0, 16)}\` |`,
    )
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}

export function prepareReplayVariants(params: {
  upstreamSourceDir: string
  workRootDir: string
  config: BenchmarkConfig
  patches: LockedPatchRecord[]
}): PreparedReplayBundle {
  const { upstreamSourceDir, workRootDir, config, patches } = params
  const materialized = materializeVariantSourceTrees({
    upstreamSourceDir,
    workRootDir,
    patches,
  })

  // Discover baseline and patched workflows independently AFTER applying patches
  const baselineInventory = inspectRepository(materialized.baseline.dir, config)
  const patchedInventory = inspectRepository(materialized.patched.dir, config)

  const variants = {} as Record<VariantId, GeneratedVariantArtifact>

  for (const variantId of VARIANTS) {
    const isPatched = variantId.endsWith('-patched')
    const provider: 'github' | 'starsling' = variantId.startsWith('starsling-') ? 'starsling' : 'github'
    const sourceTree = isPatched ? materialized.patched : materialized.baseline
    const variantDir = join(workRootDir, 'variants', variantId)

    rmSync(variantDir, { recursive: true, force: true })
    mkdirSync(variantDir, { recursive: true })
    cpSync(sourceTree.dir, variantDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })

    const workflowsDir = join(variantDir, '.github', 'workflows')
    const allMovedJobs: string[] = []
    const allRetainedJobs: string[] = []
    const allAppliedAdaptations: GeneratedVariantArtifact['appliedAdaptations'] = []

    if (existsSync(workflowsDir)) {
      const files = readdirSync(workflowsDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .sort()
      for (const file of files) {
        const relPath = posix.join('.github/workflows', file)
        const absPath = join(workflowsDir, file)
        const rawContent = readFileSync(absPath, 'utf8')
        const transformed = transformWorkflowContentForVariant({
          workflowRelPath: relPath,
          rawContent,
          provider,
          isPatched,
          config,
        })
        writeFileSync(absPath, transformed.content, 'utf8')
        allMovedJobs.push(...transformed.movedJobs)
        allRetainedJobs.push(...transformed.retainedJobs)
        allAppliedAdaptations.push(...transformed.appliedAdaptations)
      }
    }

    const sourceTreeHash = computeDirectoryHash(variantDir)
    const workflowTreeHash = computeDirectoryHash(variantDir, '.github/workflows/')
    const combinedHash = computeSha256(`${sourceTreeHash}:${workflowTreeHash}`)
    const mixedRunner = provider === 'starsling' && allMovedJobs.length > 0 && allRetainedJobs.length > 0

    // Generated trees already carry the mapped labels, so the upstream-label check does not apply to them.
    const variantInventory = inspectRepository(variantDir, config, config.benchmarkRepository.repository, {
      checkGitHubRunners: false,
    })

    variants[variantId] = {
      variant: variantId,
      treeDir: variantDir,
      inventory: variantInventory,
      lock: {
        variant: variantId,
        sourceTreeHash,
        workflowTreeHash,
        combinedHash,
        mixedRunner,
        movedJobs: [...new Set(allMovedJobs)].sort(),
        retainedJobs: [...new Set(allRetainedJobs)].sort(),
      },
      appliedAdaptations: allAppliedAdaptations,
    }
  }

  const divergenceLedgerMarkdown = renderDivergenceLedger({
    config,
    patches,
    variants,
  })

  // Ledger contains payload hashes, so it lives outside the hashed trees.
  writeFileSync(join(workRootDir, 'BENCH-OVERRIDES.md'), divergenceLedgerMarkdown, 'utf8')

  return {
    baselineInventory,
    patchedInventory,
    variants,
    divergenceLedgerMarkdown,
  }
}

export function verifyDeterministicRegeneration(params: {
  upstreamSourceDir: string
  workRootDir: string
  config: BenchmarkConfig
  patches: LockedPatchRecord[]
  expectedVariantLocks: Record<VariantId, VariantTreeLock>
}): { verified: boolean; mismatches: string[] } {
  const { upstreamSourceDir, workRootDir, config, patches, expectedVariantLocks } = params
  const checkRoot = join(workRootDir, 'regeneration-check')
  const prepared = prepareReplayVariants({
    upstreamSourceDir,
    workRootDir: checkRoot,
    config,
    patches,
  })

  const mismatches: string[] = []
  for (const variantId of VARIANTS) {
    const actual = prepared.variants[variantId].lock
    const expected = expectedVariantLocks[variantId]
    if (!expected) {
      mismatches.push(`Missing expected lock for variant "${variantId}"`)
      continue
    }
    if (actual.combinedHash !== expected.combinedHash) {
      mismatches.push(
        `Variant "${variantId}" tree hash drifted: expected ${expected.combinedHash}, regenerated ${actual.combinedHash}`,
      )
    }
  }

  return {
    verified: mismatches.length === 0,
    mismatches,
  }
}

export function filterAdaptationsForScope(
  adaptations: RepositoryAdaptationRule[],
  workflowFile: string,
): RepositoryAdaptationRule[] {
  return adaptations.filter((a) => !a.workflowFile || a.workflowFile === workflowFile)
}
