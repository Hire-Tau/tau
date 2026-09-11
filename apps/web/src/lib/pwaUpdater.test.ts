import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { MIN_CHECK_INTERVAL_MS, installPwaUpdateChecks, isWithinAutoApplyWindow, shouldCheckNow } from './pwaUpdater'

describe('shouldCheckNow (throttle)', () => {
  test('always checks on a genuine resume even within throttle window', () => {
    expect(shouldCheckNow({ lastCheckAt: 1000, now: 1100, isResume: true })).toBe(true)
  })

  test('skips non-resume checks inside the throttle window', () => {
    expect(shouldCheckNow({ lastCheckAt: 1000, now: 1100, isResume: false })).toBe(false)
  })

  test('allows non-resume checks after the throttle window', () => {
    expect(shouldCheckNow({ lastCheckAt: 1000, now: 1000 + 30001, isResume: false })).toBe(true)
  })

  test('checks when there was no previous check', () => {
    expect(shouldCheckNow({ lastCheckAt: null, now: 5000, isResume: false })).toBe(true)
  })
})

describe('isWithinAutoApplyWindow', () => {
  const base = {
    visibilityState: 'visible' as DocumentVisibilityState,
    now: 10_000,
    lastResumeAt: 9_000,
    lastInteractionAt: 0,
  }

  test('inside the window right after a clean resume', () => {
    expect(isWithinAutoApplyWindow(base)).toBe(true)
  })

  test('not when the document is hidden', () => {
    expect(isWithinAutoApplyWindow({ ...base, visibilityState: 'hidden' })).toBe(false)
  })

  test('not outside the resume window (mid foreground use)', () => {
    expect(isWithinAutoApplyWindow({ ...base, lastResumeAt: 10_000 - 5_000 })).toBe(false)
  })

  test('not if the user interacted since resuming', () => {
    expect(isWithinAutoApplyWindow({ ...base, lastInteractionAt: 9_500 })).toBe(false)
  })
})

describe('installPwaUpdateChecks', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let currentTime: number
  let controllers: Array<{ dispose(): void }>

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    controllers = []
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    currentTime = 100_000
  })

  afterEach(async () => {
    for (const controller of controllers) controller.dispose()
    await dom.cleanup()
  })

  function createRegistration() {
    return { update: mock(async () => {}) } as unknown as ServiceWorkerRegistration & {
      update: ReturnType<typeof mock>
    }
  }

  function install(registration: ServiceWorkerRegistration) {
    const requestEvaluation = mock(() => {})
    const controller = installPwaUpdateChecks(registration, {
      requestEvaluation,
      now: () => currentTime,
    })
    controllers.push(controller)
    return { controller, requestEvaluation }
  }

  test('a visible install triggers an immediate check and evaluation', () => {
    const registration = createRegistration()
    const { controller, requestEvaluation } = install(registration)

    expect(registration.update).toHaveBeenCalledTimes(1)
    expect(requestEvaluation).toHaveBeenCalled()
    controller.dispose()
  })

  test('a throttled non-resume check still requests evaluation without a network check', () => {
    const registration = createRegistration()
    const { controller, requestEvaluation } = install(registration)
    registration.update.mockClear()
    requestEvaluation.mockClear()

    currentTime += 1_000
    controller.checkForUpdate()

    expect(registration.update).not.toHaveBeenCalled()
    expect(requestEvaluation).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  test('a resume check bypasses the throttle', () => {
    const registration = createRegistration()
    const { controller } = install(registration)
    registration.update.mockClear()

    currentTime += 1_000
    controller.checkForUpdate({ isResume: true })

    expect(registration.update).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  test('a non-resume check runs once the throttle window has passed', () => {
    const registration = createRegistration()
    const { controller } = install(registration)
    registration.update.mockClear()

    currentTime += MIN_CHECK_INTERVAL_MS + 1
    controller.checkForUpdate()

    expect(registration.update).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  test('auto-apply window is open right after install and closes on interaction', () => {
    const registration = createRegistration()
    const { controller } = install(registration)

    expect(controller.isInAutoApplyWindow()).toBe(true)

    currentTime += 500
    dom.window.dispatchEvent(new dom.window.Event('pointerdown'))
    expect(controller.isInAutoApplyWindow()).toBe(false)
    controller.dispose()
  })

  test('auto-apply window closes once the resume window elapses', () => {
    const registration = createRegistration()
    const { controller } = install(registration)

    currentTime += 10_000
    expect(controller.isInAutoApplyWindow()).toBe(false)
    controller.dispose()
  })

  test('dispose removes listeners so later visibility flips do not check', () => {
    const registration = createRegistration()
    const { controller } = install(registration)
    controller.dispose()
    registration.update.mockClear()

    currentTime += MIN_CHECK_INTERVAL_MS + 1
    document.dispatchEvent(new dom.window.Event('visibilitychange'))
    dom.window.dispatchEvent(new dom.window.Event('pageshow'))

    expect(registration.update).not.toHaveBeenCalled()
    expect(controller.isInAutoApplyWindow()).toBe(false)
  })
})
