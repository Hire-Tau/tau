/**
 * Squad Todo Tools
 *
 * Creates todo tools for squad agents (manager and workers).
 * Todos are stored in `.todos/<agentId>.md` files within the squad's memory vault.
 *
 * Usage:
 *   const todoTools = createSquadTodoTools(squadId, agentId)
 *   // Pass todoTools to requiredCustomTools in createSandboxedAgentSession
 */

import * as path from 'path'
import { createTodoTools, createFileTodoStorage, type TodoToolWithKey } from './todo'
import { ensureSquadMemoryPath } from '../services/memory/paths'

/**
 * Create todo tools for a squad agent.
 *
 * @param squadId - The squad's ID (used to locate the memory vault)
 * @param agentId - The agent's ID (used for the .md filename)
 * @returns Array of todo tool definitions
 */
export function createSquadTodoTools(squadId: string, agentId: string): TodoToolWithKey[] {
  const memoryPath = ensureSquadMemoryPath(squadId)
  const todoFilePath = path.join(memoryPath, '.todos', `${agentId}.md`)
  const storage = createFileTodoStorage(todoFilePath)
  return createTodoTools(storage)
}
