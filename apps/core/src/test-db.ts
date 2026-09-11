import { join } from 'node:path'

const child = Bun.spawn(
  [process.execPath, join(import.meta.dir, '../../../scripts/test-db.ts'), ...process.argv.slice(2)],
  { stdout: 'inherit', stderr: 'inherit' }
)
process.exit(await child.exited)
