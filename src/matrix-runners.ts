import { isMap, isScalar, isSeq } from 'yaml'
import type { MatrixRunsOnPlan } from './types.ts'

const MATRIX_RUNS_ON = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/
const COMPARES_VALUE = /==|!=|contains\(|startsWith\(|endsWith\(|fromJSON\(|format\(|\[/

/** The matrix key when `runs-on` is exactly `${{ matrix.<key> }}`, else undefined. */
export function matrixRunsOnKey(runsOn: unknown): string | undefined {
  return typeof runsOn === 'string' ? MATRIX_RUNS_ON.exec(runsOn.trim())?.[1] : undefined
}

/** The inventory field for a job: `{ matrixRunsOn }` when runs-on is a matrix expression, else nothing. */
export function matrixRunsOnField(runsOn: unknown, job: Record<string, unknown>): { matrixRunsOn?: MatrixRunsOnPlan } {
  const key = matrixRunsOnKey(runsOn)
  return key === undefined ? {} : { matrixRunsOn: planMatrixRunsOn(job, key) }
}

const isLiteral = (v: unknown): v is string => typeof v === 'string' && !v.includes('${{')

function stringsOutside(node: unknown, skip: (path: string[]) => boolean, path: string[] = []): string[] {
  if (skip(path)) return []
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap((n) => stringsOutside(n, skip, path))
  if (node && typeof node === 'object')
    return Object.entries(node).flatMap(([k, v]) => stringsOutside(v, skip, [...path, k]))
  return []
}

/**
 * Which literal runner values a job's `${{ matrix.<key> }}` runs-on can take. Only a literal list under the key
 * (plus literal `include`/`exclude` entries that set it) can be rewritten; expressions, a missing key, or a value
 * the job compares elsewhere (rewriting it would change that behaviour) give a problem.
 */
export function planMatrixRunsOn(job: Record<string, unknown>, key: string): MatrixRunsOnPlan {
  const no = (why: string): MatrixRunsOnPlan => ({
    problem: `runs-on \${{ matrix.${key} }} cannot be rewritten automatically (${why}); add a runnerMapping.jobOverrides entry for this job`,
  })
  const strategy = job.strategy as { matrix?: unknown } | undefined
  const matrix = strategy?.matrix
  if (matrix === undefined) return no('the job has no strategy.matrix')
  if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix))
    return no('the whole matrix is an expression')
  const m = matrix as Record<string, unknown>
  const values: string[] = []
  const add = (v: unknown): boolean => {
    if (!isLiteral(v)) return false
    if (!values.includes(v)) values.push(v)
    return true
  }
  if (m[key] !== undefined) {
    if (!Array.isArray(m[key])) return no(`matrix.${key} is not a literal list`)
    if (!m[key].every(add)) return no(`matrix.${key} has values that are not literal strings`)
  }
  for (const section of ['include', 'exclude'] as const) {
    const entries = m[section]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return no(`matrix.${section} is an expression`)
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || !(key in entry)) continue
      if (
        section === 'include'
          ? !add((entry as Record<string, unknown>)[key])
          : !isLiteral((entry as Record<string, unknown>)[key])
      )
        return no(`matrix.${section} sets ${key} to a value that is not a literal string`)
    }
  }
  if (values.length === 0) return no(`the matrix defines no literal ${key} values`)
  const ref = new RegExp(`matrix\\.${key}(?![\\w-])|matrix\\[['"]${key}['"]\\]`)
  const compared = stringsOutside(job, (p) => p[0] === 'runs-on' || p[0] === 'name' || p[0] === 'strategy').find(
    (s) => ref.test(s) && COMPARES_VALUE.test(s),
  )
  if (compared !== undefined)
    return no(
      `matrix.${key} is compared or matched elsewhere in the job ("${compared.trim()}"), so renaming it would change behaviour`,
    )
  return { key, values }
}

/** A message when two different matrix values would be rewritten to the same label, else undefined. */
export function findMatrixCollision(targets: Record<string, string>): string | undefined {
  const seen = new Map<string, string>()
  for (const [value, target] of Object.entries(targets)) {
    const other = seen.get(target)
    if (other !== undefined)
      return `matrix values "${other}" and "${value}" would both become "${target}", which would duplicate matrix jobs and make check names ambiguous; add a runnerMapping.jobOverrides entry for this job`
    seen.set(target, value)
  }
  return undefined
}

/** Renames literal `key` values in the job's matrix list, include and exclude entries, in place. */
export function rewriteMatrixValues(jobMap: unknown, key: string, rename: (value: string) => string): void {
  const matrix = isMap(jobMap) ? (jobMap.get('strategy', true) as unknown) : undefined
  const matrixMap = isMap(matrix) ? matrix.get('matrix', true) : undefined
  if (!isMap(matrixMap)) return
  const list = matrixMap.get(key, true)
  if (isSeq(list))
    for (const item of list.items) if (isScalar(item) && typeof item.value === 'string') item.value = rename(item.value)
  for (const section of ['include', 'exclude']) {
    const entries = matrixMap.get(section, true)
    if (!isSeq(entries)) continue
    for (const entry of entries.items) {
      const v = isMap(entry) ? entry.get(key, true) : undefined
      if (isScalar(v) && typeof v.value === 'string') v.value = rename(v.value)
    }
  }
}

/**
 * Makes a job `name` that shows the matrix value keep showing the original value after the value is renamed, so
 * check names do not change. `renamed` maps new value -> original value.
 */
export function keepOriginalValueInName(name: string, key: string, renamed: Record<string, string>): string {
  if (Object.keys(renamed).length === 0) return name
  const table = JSON.stringify(renamed).replaceAll("'", "''")
  return name.replace(new RegExp(`matrix\\.${key}(?![\\w-])`, 'g'), () => `fromJSON('${table}')[matrix.${key}]`)
}
