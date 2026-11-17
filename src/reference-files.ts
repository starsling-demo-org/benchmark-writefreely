import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitHubReader } from './github.ts'
import { fetchScenarioReference, type ScenarioReference } from './reference.ts'
import type { ScenarioConfig } from './types.ts'

/** Reference snapshots live at `<dir>/<scenario>.json`, committed next to the benchmark configuration. */
export function loadReferences(directory: string): Record<string, ScenarioReference> {
  if (!existsSync(directory)) return {}
  const references: Record<string, ScenarioReference> = {}
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const value = JSON.parse(readFileSync(join(directory, file), 'utf8')) as ScenarioReference
    if (value.schemaVersion !== 1 || !value.scenarioName || !Array.isArray(value.runs))
      throw new Error(`Invalid upstream reference snapshot: ${file}`)
    references[value.scenarioName] = value
  }
  return references
}

export function writeReference(directory: string, reference: ScenarioReference): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${reference.scenarioName}.json`)
  writeFileSync(path, `${JSON.stringify(reference, null, 2)}\n`)
  return path
}

/** Fetch each scenario's locked upstream runs and write its snapshot; returns the written paths. */
export async function writeScenarioReferences(params: {
  client: GitHubReader
  upstreamRepository: string
  scenarios: ScenarioConfig[]
  directory: string
}): Promise<string[]> {
  const written: string[] = []
  for (const scenario of params.scenarios)
    written.push(
      writeReference(
        params.directory,
        await fetchScenarioReference({
          client: params.client,
          upstreamRepository: params.upstreamRepository,
          scenario,
        }),
      ),
    )
  return written
}
