---
name: branch-driven-development
description: Use when working on multi-step implementation tasks to keep context clean — tag before work, squash after, carry only summaries forward
---

# Branch-Driven Development

Use context branching to stay effective across long implementation tasks. Each
phase of work (research, implementation, debugging) gets tagged, worked, then
squashed to a summary — keeping your context window lean and focused.

**Core principle:** Tag → Work → **Complete** → Squash. Finish deliverables first.

## When to Use

- Multi-step implementation with 2+ distinct phases
- Research-heavy work (reading many files, exploring approaches)
- Debugging sessions that generate lots of noise
- Any task where context will exceed ~30% of your window

**Don't use for:** Quick single-file edits, simple questions, one-step tasks.
Most work stream tasks are single-phase and don't need context management.

## Critical Rule: Complete Work Before Checkout

**Always finish your deliverables BEFORE using `context_checkout`.**

Context checkout resets your conversation history. If you checkout before
completing your work, you will forget to hand off, commit, or report.

**Correct order:**
1. Finish your work (commits, handoffs, reports)
2. THEN squash your context if needed for the next phase

**Wrong order:**
1. ❌ Squash context
2. ❌ Forget to hand off because it's no longer in your history

## Prerequisites

This skill requires the **context management tools** (`context_tag`,
`context_log`, `context_checkout`). These are available automatically.

## The Pattern

Every phase of work follows this cycle:

```
context_tag("phase-name-start")
  ↓
  [Do the work]
  ↓
context_checkout(
  target: "phase-name-start",
  message: "[Detailed summary of what happened]",
  backupTag: "phase-name-raw"
)
```

This squashes the noisy work (file reads, debugging, iteration) into a clean
summary. The backup tag preserves raw history if you need it later.

## Multi-Step Implementation Workflow

### Step 1: Understand the Task

```javascript
context_tag({ name: "task-research-start" });

// Read requirements, explore codebase, understand patterns
// This phase generates lots of noise (file reads, grep, etc.)

context_checkout({
  target: "task-research-start",
  message: "Researched task requirements. Key files: [list]. Patterns to follow: [list]. Approach: [description]. Dependencies: [list]. Next Step: Implement.",
  backupTag: "task-research-raw"
});
```

### Step 2: Implement

```javascript
context_tag({ name: "task-impl-start" });

// Write code, tests, iterate
// Commit frequently

context_checkout({
  target: "task-impl-start",
  message: "Implemented [feature]. Files changed: [list]. Tests: [count] passing. Commits: [SHAs]. Self-review findings: [any issues fixed]. Next Step: Verify and clean up.",
  backupTag: "task-impl-raw"
});
```

### Step 3: Verify & Polish

```javascript
context_tag({ name: "task-verify-start" });

// Run full test suite, check edge cases, clean up

context_checkout({
  target: "task-verify-start",
  message: "Verified implementation. All tests passing. Edge cases covered: [list]. Final commit: [SHA]. Ready for review.",
  backupTag: "task-verify-raw"
});
```

## Checkout Message Templates

Each checkout message must include enough detail to continue working without
the raw history. Structure: **What + Files + Status + Next Step**.

**After research:**
```
Researched [topic]. Key findings:
- [Finding 1 with specifics]
- [Finding 2 with specifics]
Files to modify: [list with reasons]
Approach: [chosen approach and why]
Next Step: Implement [specific first action].
```

**After implementation:**
```
Implemented [feature/fix].
Files changed: [list with brief descriptions]
Tests: [count] passing, [count] failing
Git commits: [SHAs with descriptions]
Self-review: [issues found and fixed]
Remaining concerns: [anything uncertain]
Next Step: [what to do next].
```

**After debugging:**
```
Debugged [issue]. Root cause: [specific cause with file:line].
Fix: [what was changed and why]
Verified: [how it was tested]
Next Step: [continue implementation / report back].
```

## Multiple Sub-Tasks

When a task has multiple independent sub-tasks, branch per sub-task:

```
context_tag("subtask-1-start")
  → implement subtask 1
  → squash with summary
context_tag("subtask-2-start")
  → implement subtask 2
  → squash with summary
context_tag("subtask-3-start")
  → implement subtask 3
  → squash with summary
```

Each sub-task starts with clean context containing only summaries from previous
sub-tasks — no accumulated noise.

## When to Squash

| Situation | Action |
| :--- | :--- |
| Finished a phase (research, impl, debug) | Squash immediately |
| Read many files but only needed a few facts | Squash — the reads are noise |
| Debugging session found the root cause | Squash — the search is noise |
| Failed approach, switching strategy | Squash with failure summary |
| Context usage > 40% | Check `context_log`, squash old phases |

## Self-Review Before Handoff

Before handing off your work (to reviewer, manager, or next agent), review:

**Completeness:**
- Did I implement everything specified?
- Are there edge cases I missed?

**Quality:**
- Are names clear and accurate?
- Did I follow existing codebase patterns?
- Is error handling appropriate?

**Testing:**
- Do tests verify actual behavior?
- Are edge cases covered?

**Discipline:**
- Did I avoid overbuilding (YAGNI)?
- Did I only build what was requested?

Fix issues found during self-review before reporting done.

## Red Flags

**Never:**
- Skip the squash after a noisy phase (context will degrade)
- Write vague checkout messages ("Done", "Implemented it")
- Forget `backupTag` on checkouts (always preserve raw history)
- Let context usage exceed 60% without squashing

**If you're stuck:**
1. Tag current position
2. Try the approach (limit to 3 attempts)
3. If still stuck, squash with a failure summary
4. Try a different approach from the clean state
5. If still stuck after 2 approaches, report the blocker

## Integration with Squad Workflow

When working in a squad:
- **Before starting:** Optionally tag `task-start` if you expect a long task
- **During implementation:** Squash after each major phase if context is noisy
- **Complete your deliverable:** Commit, hand off, report — this is the priority
- **After handoff (optional):** Squash your context if you have more work

**Important:** The handoff IS the deliverable. Do not squash before handing off
— you may forget to do it. Context management is secondary to completing work.
