/**
 * Verdict for the aggregating `test` check.
 *
 * The suites were split into parallel lanes so one failure stops masking the
 * others (a web-copy change hid a mobile crash and a gate failure for hours on
 * 2026-09-04). `test` stays the required check and runs nothing itself: it
 * fails unless EVERY lane succeeded, so the split did not quietly narrow what
 * blocks a merge and branch protection needs no change.
 *
 * The logic lives here rather than inline in the workflow so it is testable —
 * an aggregator that silently passes is worse than no aggregator, because it
 * looks like coverage.
 */

export type LaneVerdict = { ok: true } | { ok: false; reason: string }

/** Anything that is not an explicit success blocks the merge, including a lane
 *  that never ran. A skipped or cancelled lane is absence of evidence, and the
 *  whole point of the required check is that absence is not a pass. */
export function validateLaneResults(names: string, results: string): LaneVerdict {
  const lanes = names
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const outcomes = results
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  if (lanes.length === 0) return { ok: false, reason: 'no lanes were declared' }
  // A length mismatch means the workflow's needs list and LANE_NAMES drifted
  // apart, so the names below would be misattributed. Fail rather than guess.
  if (lanes.length !== outcomes.length) {
    return {
      ok: false,
      reason: `expected ${lanes.length} lane results (${lanes.join(', ')}), received ${outcomes.length} (${results || 'none'})`,
    }
  }
  const failed = lanes.map((name, i) => [name, outcomes[i]] as const).filter(([, result]) => result !== 'success')
  if (failed.length > 0) return { ok: false, reason: failed.map(([name, result]) => `${name}=${result}`).join(', ') }
  return { ok: true }
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode === 'verify-result') {
    const outcome = validateLaneResults(process.env.LANE_NAMES ?? '', process.env.LANE_RESULTS ?? '')
    if (!outcome.ok) {
      console.error(`::error::test lanes did not all succeed: ${outcome.reason}`)
      process.exit(1)
    }
    console.log('all test lanes succeeded')
  } else {
    console.error('Usage: bun .github/lane-gate.ts verify-result')
    process.exit(2)
  }
}
