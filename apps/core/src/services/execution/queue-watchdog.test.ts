import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { runQueueWatchdogOnce, WATCHDOG_INTERVAL_MS } from './queue-watchdog'
import { beginTransitionalOperation, endTransitionalOperation, registerSession, removeSession } from './session-state'
import { concurrencyLimiter } from './concurrency-limiter-instance'
import * as pickupModule from './pickup'

describe('queue watchdog', () => {
  let agentTypeId: string
  let agent: Agent

  beforeEach(async () => {
    // `concurrencyLimiter` is a process-wide singleton and bun runs the whole
    // suite in one process. In CI, unrelated async pickups can acquire provider
    // slots after another test resets the limiter, so reset() is isolation
    // hygiene only; assertions about this test's slot must use execution-ID
    // ownership rather than assuming an absolute provider-wide count.
    concurrencyLimiter.reset()
    agentTypeId = `qw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await AgentType.create({
      id: agentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Watchdog Test Type',
      systemPrompt: 'test',
    })
    agent = await Agent.create({ agentTypeId })
  })

  afterEach(async () => {
    concurrencyLimiter.reset()
    endTransitionalOperation(agent.id)
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  it('nudges (attemptPickup) queued executions older than the warning threshold', async () => {
    const exec = await agent.queueExecution({ message: 'hi' })
    await db
      .update(executions)
      .set({ startedAt: sql`now() - interval '120 seconds'` })
      .where(eq(executions.id, exec.id))

    // Sanctioned redirect: the watchdog's old wake mechanism (re-emitting
    // execution.queued so the worker's listener would bounce into pickup)
    // was deleted — it now calls attemptPickup directly. Spy + mock so this
    // stays a lightweight unit test (no real runner spawn), same as the
    // deleted mechanism never actually ran anything in this test file either.
    const pickupSpy = spyOn(pickupModule, 'attemptPickup').mockResolvedValue('no-capacity')

    await runQueueWatchdogOnce()

    expect(pickupSpy.mock.calls.some(([execution]) => (execution as { id: string }).id === exec.id)).toBe(true)
    pickupSpy.mockRestore()
  })

  it('does not nudge fresh queued executions', async () => {
    const exec = await agent.queueExecution({ message: 'hi' })
    const pickupSpy = spyOn(pickupModule, 'attemptPickup').mockResolvedValue('no-capacity')

    await runQueueWatchdogOnce()

    expect(pickupSpy.mock.calls.some(([execution]) => (execution as { id: string }).id === exec.id)).toBe(false)
    pickupSpy.mockRestore()
  })

  it('resets agents stuck in compacting longer than the threshold and wakes their queued executions', async () => {
    await agent.update({ status: 'compacting' })
    const exec = await agent.queueExecution({ message: 'after stuck compact' })
    await db
      .update(agents)
      .set({ updatedAt: sql`now() - interval '300 seconds'` })
      .where(eq(agents.id, agent.id))

    const events: string[] = []
    const unsub = eventEmitter.on('execution.queued', (data) => events.push(data.executionId))

    await runQueueWatchdogOnce()

    await agent.reload()
    expect(agent.status).toBe('idle')
    expect(events).toContain(exec.id)
    unsub()
  })

  it('does not reset agents that have an in-flight compaction in this process', async () => {
    await agent.update({ status: 'compacting' })
    await agent.queueExecution({ message: 'after in-flight compact' })
    await db
      .update(agents)
      .set({ updatedAt: sql`now() - interval '600 seconds'` })
      .where(eq(agents.id, agent.id))

    beginTransitionalOperation(agent.id, 'compact')

    await runQueueWatchdogOnce()

    await agent.reload()
    expect(agent.status).toBe('compacting')
  })

  it('resets stuck resetting agents', async () => {
    await agent.update({ status: 'resetting' })
    await db
      .update(agents)
      .set({ updatedAt: sql`now() - interval '300 seconds'` })
      .where(eq(agents.id, agent.id))

    await runQueueWatchdogOnce()

    await agent.reload()
    expect(agent.status).toBe('idle')
  })

  describe('orphaned running requeue', () => {
    it('requeues an old running execution with no session and releases the leaked provider slot, after two confirming sweeps', async () => {
      const exec = await agent.queueExecution({ message: 'hi' })
      await db
        .update(executions)
        .set({ status: 'running', startedAt: sql`now() - interval '150 seconds'` })
        .where(eq(executions.id, exec.id))

      expect(concurrencyLimiter.tryAcquire(exec.id, 'zai', 'glm-5.2')).toBe(true)
      expect(concurrencyLimiter.hasSlot(exec.id)).toBe(true)

      const t0 = Date.now()

      try {
        // First sweep: flags an orphan candidate, does not act yet — a
        // starved-then-just-started execution would look identical at this
        // point, so one sweep alone can't distinguish them.
        await runQueueWatchdogOnce({ now: t0 })

        let [row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('running')
        expect(concurrencyLimiter.hasSlot(exec.id)).toBe(true)

        // Second sweep, one full watchdog interval later: still sessionless,
        // so the candidate is confirmed — requeues and releases the slot.
        await runQueueWatchdogOnce({ now: t0 + WATCHDOG_INTERVAL_MS + 1 })
        ;[row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('queued')
        expect(concurrencyLimiter.hasSlot(exec.id)).toBe(false)
      } finally {
        concurrencyLimiter.release(exec.id)
      }
    })

    it('recovers the sessionless running row left by sandbox-wait persistence failure after two sweeps', async () => {
      const exec = await agent.queueExecution({ message: 'preserved prompt' })
      // This is the documented fallback state when the recoverable setup error was
      // classified but the transactional waiting-sandbox write could not commit.
      await db
        .update(executions)
        .set({ status: 'running', startedAt: sql`now() - interval '150 seconds'` })
        .where(eq(executions.id, exec.id))
      const t0 = Date.now()

      await runQueueWatchdogOnce({ now: t0 })
      expect((await db.select().from(executions).where(eq(executions.id, exec.id)))[0]?.status).toBe('running')
      await runQueueWatchdogOnce({ now: t0 + WATCHDOG_INTERVAL_MS + 1 })
      const [recovered] = await db.select().from(executions).where(eq(executions.id, exec.id))
      expect(recovered.status).toBe('queued')
      expect(recovered.id).toBe(exec.id)
      expect(recovered.message).toBe('preserved prompt')
    })

    it('clears the orphan candidate (and does not requeue) if a session appears before the confirming sweep', async () => {
      const exec = await agent.queueExecution({ message: 'hi' })
      await db
        .update(executions)
        .set({ status: 'running', startedAt: sql`now() - interval '150 seconds'` })
        .where(eq(executions.id, exec.id))

      const t0 = Date.now()

      try {
        // First sweep: flags an orphan candidate.
        await runQueueWatchdogOnce({ now: t0 })
        let [row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('running')

        // A session appears before the confirming sweep (the exact race the
        // two-sweep gate exists to tolerate).
        registerSession(agent.id, {
          agentId: agent.id,
          executionId: exec.id,
          collector: {} as any,
          buffer: {} as any,
          session: { pi: {} } as any,
        })

        // Second sweep, one full watchdog interval later: session present,
        // so this leaves the row alone and clears the candidate instead of
        // requeueing a live execution.
        await runQueueWatchdogOnce({ now: t0 + WATCHDOG_INTERVAL_MS + 1 })
        ;[row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('running')

        removeSession(agent.id)

        // Third sweep, immediately after (well under a fresh interval). If
        // the candidate hadn't been cleared in the second sweep, this would
        // already be "confirmed" off the original first-detection timestamp
        // and requeue right away. It doesn't — proving the candidate was
        // pruned and this sweep is starting a fresh (unconfirmed) detection.
        await runQueueWatchdogOnce({ now: t0 + WATCHDOG_INTERVAL_MS + 2 })
        ;[row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('running')
      } finally {
        removeSession(agent.id)
      }
    })

    it('does not touch a running execution whose agent has an active session', async () => {
      const exec = await agent.queueExecution({ message: 'hi' })
      await db
        .update(executions)
        .set({ status: 'running', startedAt: sql`now() - interval '150 seconds'` })
        .where(eq(executions.id, exec.id))

      registerSession(agent.id, {
        agentId: agent.id,
        executionId: exec.id,
        collector: {} as any,
        buffer: {} as any,
        session: { pi: {} } as any,
      })

      try {
        await runQueueWatchdogOnce()

        const [row] = await db.select().from(executions).where(eq(executions.id, exec.id))
        expect(row.status).toBe('running')
      } finally {
        removeSession(agent.id)
      }
    })

    it('does not touch a running execution younger than the orphaned-running threshold', async () => {
      const exec = await agent.queueExecution({ message: 'hi' })
      await db.update(executions).set({ status: 'running' }).where(eq(executions.id, exec.id))

      await runQueueWatchdogOnce()

      const [row] = await db.select().from(executions).where(eq(executions.id, exec.id))
      expect(row.status).toBe('running')
    })
  })
})
