import { Agent } from '../Agent'
import { Execution } from '../Execution'
import { AgentRunner } from './base'
import { SystemManagerRunner } from './system-manager-runner'
import { SquadManagerRunner } from './squad-manager-runner'
import { SquadWorkerRunner } from './squad-worker-runner'
import { ArtifactBuilderRunner } from './artifact-builder-runner'
import { SubagentRunner } from './subagent-runner'

/**
 * Create a runner for an agent execution.
 * @param agent - The agent to run.
 * @param execution - The execution entity.
 * @returns The agent runner.
 */
export async function createRunner(agent: Agent, execution: Execution): Promise<AgentRunner> {
  const { flowAgentType } = await import('../../services/workflows/execution')
  const agentType = (await flowAgentType(agent.id)) ?? (await agent.mustGetAgentType())
  switch (agent.runnerType) {
    case 'system-manager':
      return new SystemManagerRunner(execution, agent, agentType)
    case 'squad-manager':
      return new SquadManagerRunner(execution, agent, agentType)
    case 'squad-worker':
      return new SquadWorkerRunner(execution, agent, agentType)
    case 'artifact-builder':
      return new ArtifactBuilderRunner(execution, agent, agentType)
    case 'subagent':
      return new SubagentRunner(execution, agent, agentType)
    default:
      throw new Error(`Unexpected agent runner type: ${agent.runnerType}`)
  }
}
