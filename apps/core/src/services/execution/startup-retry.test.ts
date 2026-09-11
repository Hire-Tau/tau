import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, executionAdmissionReservations } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import * as runners from '../../entities/agent-runners'
import { STARTUP_RETRY_DELAYS_MS, startupRetryCode } from './startup-retry'
import { removeSession } from './session-state'
import { AdmissionReservationStore, attachAdmissionLeaseToError } from '../maintenance/admission-reservation'

const connectionFailure = () =>
  Object.assign(new Error('too many connections for role "test_tenant"'), { code: '53300' })

describe('startup retry classification', () => {
  it.each([
    '53300',
    '57P01',
    '57P02',
    '57P03',
    '08001',
    '08003',
    '08006',
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
  ])('recognizes structured database failure %s through wrappers', (code) => {
    const cause = Object.assign(new Error('database failure'), { code })
    expect(startupRetryCode(new Error('Failed query', { cause }))).toBe(code)
  })

  it.each([
    'provider overloaded',
    '429 Too Many Requests',
    'too many connections for role "test_tenant"',
    'invalid credentials',
    'bug',
  ])('does not infer retryability from prose: %s', (message) => expect(startupRetryCode(new Error(message))).toBeNull())

  it('rejects permanent SQL failures and cyclic causes', () => {
    expect(startupRetryCode(Object.assign(new Error('auth'), { code: '28P01' }))).toBeNull()
    expect(startupRetryCode(Object.assign(new Error('constraint'), { code: '23505' }))).toBeNull()
    const error = new Error('cycle')
    error.cause = error
    expect(startupRetryCode(error)).toBeNull()
  })
})

describe('durable startup retry', () => {
  let agent: Agent
  let typeId: string

  beforeEach(async () => {
    typeId = `startup-retry-${crypto.randomUUID()}`
    await AgentType.create({ id: typeId, name: 'Startup retry test', model: 'test', systemPrompt: 'test' })
    agent = await Agent.create({ agentTypeId: typeId })
  })

  afterEach(async () => {
    removeSession(agent.id)
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
  })

  it('retries startup connection exhaustion with durable backoff and stops after three retries', async () => {
    const runner = spyOn(runners, 'createRunner').mockRejectedValue(connectionFailure())
    try {
      let execution = await agent.queueExecution({ message: 'Preserve this request' })
      const id = execution.id
      for (const [index, delay] of STARTUP_RETRY_DELAYS_MS.entries()) {
        expect(await execution.start()).toBe(true)
        const [before] = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`)
        await execution.run()
        // Reload a new entity, as a replacement worker would.
        execution = await Execution.mustFind(id)
        expect(execution.status).toBe('queued')
        expect(execution.startupRetryCount).toBe(index + 1)
        expect(execution.message).toBe('Preserve this request')
        expect(execution.endedAt).toBeNull()
        expect(execution.failureClass).toBeNull()
        const [after] = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`)
        expect(execution.startupRetryAt!.getTime()).toBeGreaterThanOrEqual(new Date(before.now).getTime() + delay)
        expect(execution.startupRetryAt!.getTime()).toBeLessThanOrEqual(new Date(after.now).getTime() + delay)
        expect((await Agent.mustFind(agent.id)).status).toBe('idle')
        const [admission] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, id))
        expect(admission.state).toBe('queued')
        expect(await execution.start()).toBe(false)
        // Advance only this fixture's database deadline, with no host sleeps.
        await db
          .update(executions)
          .set({ startupRetryAt: new Date(0) })
          .where(eq(executions.id, id))
      }
      expect(await execution.start()).toBe(true)
      await execution.run()
      const failed = await Execution.mustFind(id)
      expect(failed.status).toBe('failed')
      expect(failed.startupRetryCount).toBe(3)
      expect(failed.error).toContain('too many connections')
      expect(runner).toHaveBeenCalledTimes(4)
    } finally {
      runner.mockRestore()
    }
  })

  it.each(['provider overloaded', 'provider exhausted', 'unexpected setup bug'])(
    'does not retry other startup failures: %s',
    async (message) => {
      const runner = spyOn(runners, 'createRunner').mockRejectedValue(new Error(message))
      try {
        const execution = await agent.queueExecution({ message: 'test' })
        expect(await execution.start()).toBe(true)
        await execution.run()
        await execution.reload()
        expect(execution.status).toBe('failed')
        expect(execution.startupRetryCount).toBe(0)
        expect(runner).toHaveBeenCalledTimes(1)
      } finally {
        runner.mockRestore()
      }
    }
  )

  it('never revives a stopped execution or requeues a newer runner claim', async () => {
    const execution = await agent.queueExecution({ message: 'test' })
    expect(await execution.start()).toBe(true)
    const stale = await Execution.mustFind(execution.id)
    await execution.requeue()
    expect(await execution.start()).toBe(true)
    expect(await stale.retryStartupFailure(connectionFailure())).toBe(false)
    await execution.stop()
    expect(await execution.retryStartupFailure(connectionFailure())).toBe(false)
    expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
  })

  it('preserves a stop that races the startup error handler', async () => {
    const execution = await agent.queueExecution({ message: 'test' })
    expect(await execution.start()).toBe(true)
    const runner = spyOn(runners, 'createRunner').mockImplementation(async () => {
      await execution.stop()
      throw connectionFailure()
    })
    try {
      await execution.run()
      expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
    } finally {
      runner.mockRestore()
    }
  })

  it('restores queue ownership after the failed runner revokes its exact admission lease', async () => {
    const execution = await agent.queueExecution({ message: 'test' })
    expect(await execution.start()).toBe(true)
    const store = new AdmissionReservationStore('startup-retry-test', crypto.randomUUID())
    const lease = await store.createProvisional(execution.id)
    await db
      .update(executions)
      .set({ runnerClaimToken: lease.token, runnerClaimGeneration: lease.generation })
      .where(eq(executions.id, execution.id))
    await execution.reload()
    const runner = spyOn(runners, 'createRunner').mockImplementation(async () => {
      await store.revokeLease(lease)
      throw attachAdmissionLeaseToError(connectionFailure(), lease)
    })
    try {
      await execution.run()
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      const [reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(reservation.state).toBe('queued')
      expect(reservation.token).toBeNull()
    } finally {
      runner.mockRestore()
    }
  })

  it('does not retry connection failures reported through ordinary turn settlement', async () => {
    const execution = await agent.queueExecution({ message: 'test' })
    expect(await execution.start()).toBe(true)
    await execution.fail(connectionFailure().message)
    expect(execution.status).toBe('failed')
    expect(execution.startupRetryCount).toBe(0)
  })

  it('does not replay a database error thrown by run after the startup boundary', async () => {
    const execution = await agent.queueExecution({ message: 'test' })
    expect(await execution.start()).toBe(true)
    const runner = spyOn(runners, 'createRunner').mockResolvedValue({
      run: async () => {
        throw connectionFailure()
      },
    } as unknown as Awaited<ReturnType<typeof runners.createRunner>>)
    try {
      await execution.run()
      await execution.reload()
      expect(execution.status).toBe('failed')
      expect(execution.startupRetryCount).toBe(0)
    } finally {
      runner.mockRestore()
    }
  })
})
