import type { TurnContext, TurnHook, TurnHookResult, RegisteredHook } from './types'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('hooks')

/**
 * Registry for turn completion hooks.
 * Hooks run in priority order (lower = first) when an agent completes a turn.
 */
class TurnHookRegistry {
  private hooks: RegisteredHook[] = []

  /**
   * Register a hook with a name and priority.
   * Lower priority values run first.
   */
  register(name: string, priority: number, hook: TurnHook): void {
    // Remove existing hook with same name (allows re-registration)
    this.hooks = this.hooks.filter((h) => h.name !== name)
    this.hooks.push({ name, priority, hook })
    this.hooks.sort((a, b) => a.priority - b.priority)
  }

  /**
   * Unregister a hook by name.
   */
  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name)
  }

  /**
   * Run all hooks in priority order.
   * Returns the first non-'continue' result, or 'continue' if all hooks pass.
   */
  async run(ctx: TurnContext): Promise<TurnHookResult> {
    for (const { name, hook } of this.hooks) {
      try {
        const result = await hook(ctx)
        if (result.action !== 'continue') {
          log.info(`Hook '${name}' returned '${result.action}' for agent ${ctx.agentId.slice(0, 8)}`)
          return result
        }
      } catch (error) {
        log.error(`Hook '${name}' failed for agent ${ctx.agentId.slice(0, 8)}:`, error)
        // Continue to next hook on error
      }
    }
    return { action: 'continue' }
  }

  /**
   * Get list of registered hook names (for debugging).
   */
  list(): string[] {
    return this.hooks.map((h) => `${h.name} (priority: ${h.priority})`)
  }

  /**
   * Clear all hooks (for testing).
   */
  clear(): void {
    this.hooks = []
  }
}

export const turnHooks = new TurnHookRegistry()
