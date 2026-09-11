import { readFileSync } from 'node:fs'
import { verifyAgentSessionDataflow } from './pi-agent-session-dataflow'

const files = process.argv.slice(2)
if (files.length !== 2) throw new Error('usage: pi-agent-session-dataflow-cli.ts <source.ts> <compiled.js>')
for (const file of files) verifyAgentSessionDataflow(readFileSync(file, 'utf8'), file)
