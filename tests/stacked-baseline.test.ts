import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSha256, resolvePatchStack, validateBenchmarkConfig } from '../src/config.ts'
import { renderDivergenceLedger } from '../src/generator.ts'
import { materializeVariantSourceTrees } from '../src/patcher.ts'
import type { LockedPatchRecord } from '../src/types.ts'
import fixtureConfig from './fixtures/definitelytyped.config.ts'

const patchFor = (file: string, from: string, to: string): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', `-${from}`, `+${to}`, ''].join(
    '\n',
  )

function locked(id: string, content: string, inBaseline?: boolean): LockedPatchRecord {
  const sha = computeSha256(content)
  return {
    id,
    source: 'local',
    originalPathOrUrl: `${id}.patch`,
    immutableOrigin: `file://${id}.patch#sha256=${sha}`,
    resolvedRevision: 'a'.repeat(40),
    sha256: sha,
    byteLength: Buffer.byteLength(content, 'utf8'),
    patchContent: content,
    ...(inBaseline ? { inBaseline } : {}),
  }
}

describe('stacked baseline: inBaseline patches', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function upstream(): { root: string; upstreamDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'bench-stacked-'))
    dirs.push(root)
    const upstreamDir = join(root, 'upstream')
    mkdirSync(upstreamDir, { recursive: true })
    for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(upstreamDir, f), 'zero\n')
    return { root, upstreamDir }
  }
  const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')
  const stack = () => [
    locked('p1', patchFor('a.txt', 'zero', 'one'), true),
    locked('p2', patchFor('b.txt', 'zero', 'two'), true),
    locked('p3', patchFor('c.txt', 'zero', 'three')),
  ]

  it('applies inBaseline patches to the baseline tree and all patches to the patched tree', () => {
    const { root, upstreamDir } = upstream()
    const { baseline, patched } = materializeVariantSourceTrees({
      upstreamSourceDir: upstreamDir,
      workRootDir: root,
      patches: stack(),
    })
    expect([read(baseline.dir, 'a.txt'), read(baseline.dir, 'b.txt'), read(baseline.dir, 'c.txt')]).toEqual([
      'one\n',
      'two\n',
      'zero\n',
    ])
    expect([read(patched.dir, 'a.txt'), read(patched.dir, 'b.txt'), read(patched.dir, 'c.txt')]).toEqual([
      'one\n',
      'two\n',
      'three\n',
    ])
    expect(baseline.appliedPatchIds).toEqual(['p1', 'p2'])
    expect(baseline.modifiedPaths).toEqual(['a.txt', 'b.txt'])
    expect(patched.appliedPatchIds).toEqual(['p1', 'p2', 'p3'])
    expect(baseline.treeHash).not.toBe(patched.treeHash)
  })

  it('refuses an inBaseline patch listed after a patch that is not', () => {
    const { root, upstreamDir } = upstream()
    const patches = [
      locked('p3', patchFor('c.txt', 'zero', 'three')),
      locked('p1', patchFor('a.txt', 'zero', 'one'), true),
    ]
    expect(() => materializeVariantSourceTrees({ upstreamSourceDir: upstreamDir, workRootDir: root, patches })).toThrow(
      /inBaseline.*before/,
    )
  })

  it('refuses the same ordering when locking and when validating the config', async () => {
    const specs = [
      { id: 'p3', source: 'local' as const, pathOrUrl: 'x.patch' },
      { id: 'p1', source: 'local' as const, pathOrUrl: 'y.patch', inBaseline: true },
    ]
    await expect(resolvePatchStack(specs, '/nonexistent')).rejects.toThrow(/inBaseline/)
    const config = structuredClone(fixtureConfig)
    config.patches = specs
    expect(validateBenchmarkConfig(config).map((b) => b.id)).toContain('inbaseline-patch-order-p1')
  })

  it('without flags the baseline is bare upstream and the patched tree has every patch, as before', () => {
    const { root, upstreamDir } = upstream()
    const plain = stack().map(({ inBaseline: _flag, ...rest }) => rest)
    const { baseline, patched } = materializeVariantSourceTrees({
      upstreamSourceDir: upstreamDir,
      workRootDir: root,
      patches: plain,
    })
    expect(read(baseline.dir, 'a.txt')).toBe('zero\n')
    expect(baseline.appliedPatchIds).toEqual([])
    expect(patched.appliedPatchIds).toEqual(['p1', 'p2', 'p3'])
  })

  it('shows which patches are in the baseline in the ledger, and keeps the old ledger when none are', () => {
    const variants = {} as Parameters<typeof renderDivergenceLedger>[0]['variants']
    const lock = { mixedRunner: false, movedJobs: [], retainedJobs: [], combinedHash: 'h'.repeat(64) }
    for (const v of ['github-baseline', 'github-patched', 'starsling-baseline', 'starsling-patched'] as const)
      variants[v] = { lock } as never
    const flagged = renderDivergenceLedger({ config: fixtureConfig, patches: stack(), variants })
    expect(flagged).toContain('In baseline')
    expect(flagged).toMatch(/`p1`.*Yes/)
    expect(flagged).toMatch(/`p3`.*No/)
    const plain = renderDivergenceLedger({
      config: fixtureConfig,
      patches: stack().map(({ inBaseline: _flag, ...rest }) => rest),
      variants,
    })
    expect(plain).not.toContain('In baseline')
  })

  it('records inBaseline in the locked patch only when set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-stacked-lock-'))
    dirs.push(root)
    writeFileSync(join(root, 'a.patch'), patchFor('a.txt', 'zero', 'one'))
    writeFileSync(join(root, 'b.patch'), patchFor('b.txt', 'zero', 'two'))
    const lockedStack = await resolvePatchStack(
      [
        { id: 'a', source: 'local', pathOrUrl: 'a.patch', inBaseline: true },
        { id: 'b', source: 'local', pathOrUrl: 'b.patch' },
      ],
      root,
    )
    expect(lockedStack[0]?.inBaseline).toBe(true)
    expect(lockedStack[1]).not.toHaveProperty('inBaseline')
  })
})
