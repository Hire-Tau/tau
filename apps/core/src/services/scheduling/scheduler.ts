import { Schedule } from '../../entities/Schedule'
import { createPeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { emitScheduleHealthTransitions, reconcileExpiredScheduleAttempts } from './health-store'
import { scheduleHealthNotifier } from './failure-notifications'

const log = createLogger('scheduler')

export async function checkSchedules() {
  try {
    const staleAttempts = await reconcileExpiredScheduleAttempts(new Date())
    for (const transitions of staleAttempts) emitScheduleHealthTransitions(transitions)

    const dueSchedules = await Schedule.listDue()
    for (const schedule of dueSchedules) {
      try {
        await schedule.triggerIfDue()
      } catch (error) {
        log.error(`Error triggering schedule ${schedule.id}:`, error)
      }
    }
  } finally {
    // Notification delivery is independent of whether any schedule is due or
    // whether one action fails. The outbox is the durable crash backstop.
    await scheduleHealthNotifier.drain({ now: new Date() })
  }
}

const runner = createPeriodicRunner({
  name: 'scheduler',
  intervalMs: 30_000,
  runImmediately: true,
  task: checkSchedules,
})

export const scheduler = {
  start() {
    runner.start()
  },
  stop() {
    return runner.stop()
  },
}
