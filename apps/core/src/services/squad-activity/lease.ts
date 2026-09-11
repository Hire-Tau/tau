export interface ActivityMaintenanceLeaseFence {
  task: string
  token: string
}

export class ActivityMaintenanceLeaseLostError extends Error {}
