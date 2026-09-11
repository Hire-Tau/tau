import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('./workflows/ci.yml', import.meta.url), 'utf8')

/**
 * The local-setup updater step rewinds the checkout so its in-app apply is a real
 * fast-forward onto the PR head. On a pull_request event HEAD is the MERGE commit
 * and `github.event.pull_request.base.sha` is its first parent, so the old
 * `merge-base HEAD base.sha` resolved to main's tip rather than the branch's fork
 * point. Every PR whose base advanced then failed with `skipped` and an empty
 * changedFiles array — deterministic, but it read as a flake and was cleared with
 * branch updates instead of being fixed (#1414, #1421).
 *
 * Assertions are boolean-with-message rather than toContain(workflow): a failing
 * toContain prints the whole 57KB workflow, which buries the one line that matters.
 */
const has = (needle: string) => workflow.includes(needle)

test('the pull_request rewind targets the fork point, not the base tip', () => {
  expect(
    has('git merge-base HEAD^1 HEAD^2'),
    'pull_request rewind must use the fork point of the merge commit’s two parents'
  ).toBe(true)
  // The old form must not return. Anchored to `HEAD ` + the base.sha expression so
  // the workflow_dispatch rewind (`merge-base HEAD origin/main`, where HEAD is a
  // branch head and so already correct) is unaffected.
  expect(
    has("git merge-base HEAD '${{ github.event.pull_request.base.sha }}'"),
    'the base.sha rewind resolves to main’s tip on a merge commit and must not come back'
  ).toBe(false)
})

test('the rewind asserts it can actually fast-forward to the PR head', () => {
  // Without this the precondition failure only surfaces ~600s later as an
  // unexplained skip, which is what made the original cost hours to attribute.
  expect(
    has("git merge-base --is-ancestor HEAD '${{ github.event.pull_request.head.sha }}'"),
    'the rewind must assert its target is an ancestor of the PR head'
  ).toBe(true)
  expect(has('is not an ancestor of PR head'), 'the guard must explain itself in one line').toBe(true)
})
