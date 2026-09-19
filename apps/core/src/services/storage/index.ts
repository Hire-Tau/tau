import type { StorageMachine, StorageSnapshot } from '@tau/shared'
import { agents, db, squads } from '../../db'
import { mapWithConcurrency } from '../../lib/infra/mapWithConcurrency'
import { parseDfOutput } from '../machines/machine-health'
import { listAllMachineBoxes, listMachines } from '../machines/queries'
import type { Machine } from '../machines/queries'
import type { SshRunner } from '../machines/ssh'
import { defaultSshRunner } from '../machines/ssh'
import { isVmRuntime } from '../sandbox/runtime'
import { attributeStorage, parseDirectoryUsage, type StorageOwner } from './accounting'
import { createStorageCache } from './cache'

// One traversal per machine: GNU du deduplicates hardlinks within the scan.
// -x avoids mounted filesystems, -P (the default) avoids symlink traversal.
// Remote timeout also terminates the traversal if the SSH connection is lost.
export const STORAGE_SCAN_COMMAND =
  "df -B1 --output=used,size /home; printf '\\0'; sudo -n timeout 45s du -x -B1 --max-depth=4 --null /home 2>/dev/null"

async function scanStorage(): Promise<StorageSnapshot> {
  if (!isVmRuntime())
    return {
      supported: false,
      scanning: false,
      scannedAt: new Date().toISOString(),
      error: null,
      machines: [],
    }
  const [machines, boxes, squadRows, agentRows] = await Promise.all([
    listMachines(),
    listAllMachineBoxes(),
    db.select({ id: squads.id, name: squads.name }).from(squads),
    db.select({ id: agents.id, squadId: agents.squadId }).from(agents),
  ])
  const names = new Map(squadRows.map((squad) => [squad.id, squad.name]))
  const agentSquads = new Map(agentRows.map((agent) => [agent.id, agent.squadId]))
  const results = await mapWithConcurrency(
    machines.filter((machine) => machine.status !== 'terminated'),
    2,
    async (machine): Promise<StorageMachine> => {
      const empty: StorageMachine = {
        id: machine.id,
        name: machine.name,
        status: 'unavailable',
        usedBytes: null,
        totalBytes: null,
        squads: [],
        unattributedBytes: null,
      }
      // Inspection must never provision, wake or start workloads.
      if (machine.status !== 'ready') return empty
      const owners: StorageOwner[] = []
      for (const box of boxes.filter((box) => box.machineId === machine.id)) {
        const squadId = box.sandboxId.startsWith('squad_')
          ? box.sandboxId.slice(6)
          : box.sandboxId.startsWith('agent_')
            ? agentSquads.get(box.sandboxId.slice(6))
            : null
        if (!squadId || !names.has(squadId) || !/^box_[a-f0-9]{12}$/.test(box.unixUser)) continue
        owners.push({
          home: `/home/${box.unixUser}`,
          squadId,
          squadName: names.get(squadId)!,
          label: box.sandboxId.startsWith('squad_') ? 'Squad workspace and tools' : 'Agent files',
        })
      }
      return measureMachineStorage(machine, owners)
    }
  )
  return { supported: true, scanning: false, scannedAt: new Date().toISOString(), error: null, machines: results }
}

export async function measureMachineStorage(
  machine: Machine,
  owners: StorageOwner[],
  runner: SshRunner = defaultSshRunner
): Promise<StorageMachine> {
  const empty: StorageMachine = {
    id: machine.id,
    name: machine.name,
    status: 'unavailable',
    usedBytes: null,
    totalBytes: null,
    squads: [],
    unattributedBytes: null,
  }
  try {
    const result = await runner.run(machine, STORAGE_SCAN_COMMAND, { timeoutMs: 55_000 })
    const separator = result.stdout.indexOf('\0')
    if (separator < 0) return empty
    const disk = parseDfOutput(result.stdout.slice(0, separator))
    const entries = parseDirectoryUsage(result.stdout.slice(separator + 1))
    const attributed = attributeStorage(entries, owners)
    const measuredBytes = attributed.reduce((sum, squad) => sum + squad.bytes, 0)
    const complete = result.exitCode === 0 && entries.has('/home') && disk !== null
    return {
      ...empty,
      status: complete ? 'available' : 'partial',
      usedBytes: disk?.usedBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      squads: attributed,
      unattributedBytes: complete ? Math.max(0, disk.usedBytes - measuredBytes) : null,
    }
  } catch {
    return empty
  }
}

export const storageCache = createStorageCache(scanStorage)
