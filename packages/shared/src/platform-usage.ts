/** Wire contract only. Billing policy and storage stay in the control plane. */
export const MAX_INGEST_MACHINES = 1000
export interface IngestMachine {
  name: string
  provider: string
  scope: string
  purpose: string
  autoProvisioned: boolean
  status: string
  createdAt: string
}
