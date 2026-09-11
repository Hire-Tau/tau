import { agentTypeSync, modelTierSync } from './index'
await modelTierSync.sync()
await agentTypeSync.sync()
process.exit(0)
