/**
 * BuildKit plain-progress output (`docker build --progress=plain`, which `docker/build-push-action` prints in
 * job logs) read as cache evidence.
 *
 * Patterns come from moby/buildkit, and are data so a BuildKit wording change is a one-line edit:
 * - `#N DONE|CACHED|ERROR`: a step ended (the same lines the writefreely collector reads).
 * - `#N importing cache manifest from gha:<id>`: solver/llbsolver/bridge.go names the import vertex
 *   "importing cache manifest from " + the cache manager id, which is `gha:<id>` for `cache-from: type=gha`.
 * - `#N exporting to GitHub Actions Cache`: cache/remotecache/gha/gha.go, `exporter.Name()`, the vertex of
 *   `cache-to: type=gha`.
 */
export const BUILDKIT_PATTERNS = {
  stepEnd: /^#(\d+) (DONE|CACHED|ERROR)\b/,
  /** First vertex of every build (`#1 [internal] load build definition from Dockerfile`), the new-build marker. */
  buildStart: /^#\d+ \[internal\] load build definition\b/,
  anyVertexLine: /^#(\d+) /,
  ghaImport: /^#(\d+) importing cache manifest from (gha:\S*)/,
  ghaExport: /^#(\d+) exporting (?:cache )?to GitHub Actions Cache\b/,
} as const

export interface BuildkitBuild {
  /** Steps ended per outcome. Includes BuildKit's own internal steps and the cache import/export vertices. */
  done: number
  cached: number
  error: number
  cacheImports: { id: string; failed: boolean }[]
  cacheExports: number
}

/**
 * One entry per build in the log. Every build opens with a `[internal] load build definition` vertex, so that
 * line starts a new build. A repeated `#N DONE` for an already-ended vertex does NOT: BuildKit prints some of
 * those twice inside one build. A log with no BuildKit output gives an empty list.
 */
export function parseBuildkitLog(log: string): BuildkitBuild[] {
  const builds: BuildkitBuild[] = []
  let current: BuildkitBuild | undefined
  let imports = new Map<string, { id: string; failed: boolean }>()
  for (const line of log.split('\n')) {
    const vertex = BUILDKIT_PATTERNS.anyVertexLine.exec(line)
    if (!vertex?.[1]) continue
    const id = vertex[1]
    if (!current || BUILDKIT_PATTERNS.buildStart.test(line)) {
      current = { done: 0, cached: 0, error: 0, cacheImports: [], cacheExports: 0 }
      builds.push(current)
      imports = new Map()
    }
    const importing = BUILDKIT_PATTERNS.ghaImport.exec(line)
    if (importing?.[2]) {
      const entry = { id: importing[2], failed: false }
      imports.set(id, entry)
      current.cacheImports.push(entry)
      continue
    }
    if (BUILDKIT_PATTERNS.ghaExport.test(line)) {
      current.cacheExports++
      continue
    }
    const end = BUILDKIT_PATTERNS.stepEnd.exec(line)
    if (!end) continue
    if (end[2] === 'DONE') current.done++
    else if (end[2] === 'CACHED') current.cached++
    else {
      current.error++
      const failedImport = imports.get(id)
      if (failedImport) failedImport.failed = true
    }
  }
  return builds
}
