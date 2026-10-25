import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('CI workflow', () => {
  const workflow = read('.github/workflows/ci.yml')

  it('runs on every pull request', () => {
    expect(workflow).toMatch(/^on:\n\s+pull_request:/m)
  })

  it('runs the type check and the test suite', () => {
    expect(workflow).toMatch(/run: npm run typecheck$/m)
    expect(workflow).toMatch(/run: npm test$/m)
  })

  it('has a typecheck script that runs tsc', () => {
    expect(JSON.parse(read('package.json')).scripts.typecheck).toBe('tsc')
  })
})
