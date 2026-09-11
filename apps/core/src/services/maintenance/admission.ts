import { authoritativePauseEvidence, MaintenanceAdmissionPaused } from './admission-evidence'
import { maintenanceStore } from './store'

export { MaintenanceAdmissionPaused } from './admission-evidence'

/** Authoritative defense-in-depth gate immediately before physical sandbox admission. */
export async function assertMaintenanceAdmissionOpen(): Promise<void> {
  await maintenanceStore.initialize()
  const state = await maintenanceStore.refresh()
  if (state.effective) throw new MaintenanceAdmissionPaused(authoritativePauseEvidence(state))
}
