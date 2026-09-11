import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { executionStatusEnum, k8sProvisionAttempts, k8sProvisionControls, sandboxProvisionRecoveries } from './schema'

describe('Kubernetes provisioning coordination schema', () => {
  test('exports the durable control table', () => {
    expect(getTableConfig(k8sProvisionControls).name).toBe('k8s_provision_controls')
  })

  test('keys attempts by scope and sandbox', () => {
    const config = getTableConfig(k8sProvisionAttempts)
    expect(config.primaryKeys).toHaveLength(1)
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual(['scope', 'sandbox_key'])
  })

  test('defines durable execution-keyed sandbox recovery waits', () => {
    expect(executionStatusEnum.enumValues).toContain('waiting-sandbox')
    const config = getTableConfig(sandboxProvisionRecoveries)
    expect(config.primaryKeys).toHaveLength(0)
    expect(config.columns.find((column) => column.name === 'execution_id')?.primary).toBe(true)
    expect(config.foreignKeys).toHaveLength(3)
    expect(config.indexes.map((candidate) => candidate.config.name)).toEqual(
      expect.arrayContaining(['idx_sandbox_provision_recoveries_due', 'idx_sandbox_provision_recoveries_scope_due'])
    )
  })

  test('indexes live attempts by scope, status, and lease expiry', () => {
    const index = getTableConfig(k8sProvisionAttempts).indexes.find(
      (candidate) => candidate.config.name === 'idx_k8s_provision_attempts_live'
    )
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      'scope',
      'status',
      'lease_expires_at',
    ])
  })
})
