import { expect, it, vi } from 'vitest'
import { GitHubClient } from '../src/github.ts'

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    throw Object.assign(new Error('Command failed: gh api'), {
      stdout: JSON.stringify({ message: 'Not Found', status: '404' }),
    })
  },
}))

it('reports the GitHub response reason instead of hiding it behind a command failure', async () => {
  await expect(new GitHubClient('fixture/repo').request('git/trees', 'POST', {})).rejects.toThrow(
    'GitHub POST repos/fixture/repo/git/trees failed: Not Found (HTTP 404)',
  )
})
