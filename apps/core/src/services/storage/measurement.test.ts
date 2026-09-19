import { expect, test } from 'bun:test'
import type { Machine } from '../machines/queries'
import { measureMachineStorage, STORAGE_SCAN_COMMAND } from './index'

const machine = { id: 'machine', name: 'Worker' } as Machine
const owners = [{ home: '/home/box_a', squadId: 'squad', squadName: 'Product', label: 'Workspace' }]
const stdout = 'Used 1B-blocks\n1000 2000\n\0' + '100\t/home/box_a\0' + '120\t/home\0'

test('reports disk capacity and inclusive squad totals from one bounded machine scan', async () => {
  const result = await measureMachineStorage(machine, owners, {
    run: async (target, command, opts) => {
      expect(target).toBe(machine)
      expect(command).toBe(STORAGE_SCAN_COMMAND)
      expect(command).toContain('timeout 45s nice -n 19 ionice -c 3 du -x -B1 --max-depth=4 --null /home')
      expect(opts?.timeoutMs).toBe(55000)
      return { exitCode: 0, stdout, stderr: '' }
    },
  })
  expect(result.status).toBe('available')
  expect(result.usedBytes).toBe(1000)
  expect(result.totalBytes).toBe(2000)
  expect(result.squads[0].bytes).toBe(100)
  expect(result.unattributedBytes).toBe(900)
})

test('failed and truncated scans never present missing measurements as zero usage', async () => {
  for (const result of [
    { exitCode: 124, stdout, stderr: '' },
    { exitCode: 0, stdout: stdout.replace('120\t/home\0', ''), stderr: '' },
    { exitCode: 1, stdout: 'Used 1B-blocks\n1000 2000\n\0', stderr: 'permission denied' },
  ]) {
    const measured = await measureMachineStorage(machine, owners, { run: async () => result })
    expect(measured.status).toBe('partial')
    expect(measured.unattributedBytes).toBeNull()
  }
  const unavailable = await measureMachineStorage(machine, owners, {
    run: async () => {
      throw new Error('ssh private key path')
    },
  })
  expect(unavailable.status).toBe('unavailable')
  expect(unavailable.usedBytes).toBeNull()
  expect(JSON.stringify(unavailable)).not.toContain('private key')
})
