/**
 * Webhook Registry - Manages processors and handlers
 *
 * The registry maintains a mapping of providers to processors,
 * and provider:eventType pairs to handler arrays.
 */

import type { WebhookProcessor, WebhookHandler, WebhookRegistry } from './types'

/**
 * Implementation of the WebhookRegistry interface
 */
class WebhookRegistryImpl implements WebhookRegistry {
  private processors = new Map<string, WebhookProcessor>()
  private handlers = new Map<string, WebhookHandler[]>()

  registerProcessor(processor: WebhookProcessor): void {
    this.processors.set(processor.provider, processor)
  }

  registerHandler(provider: string, eventType: string, handler: WebhookHandler): void {
    const key = `${provider}:${eventType}`
    const existing = this.handlers.get(key) || []
    this.handlers.set(key, [...existing, handler])
  }

  getProcessor(provider: string): WebhookProcessor | undefined {
    return this.processors.get(provider)
  }

  getHandlers(provider: string, eventType: string): WebhookHandler[] {
    // Support wildcard handlers with '*'
    const specific = this.handlers.get(`${provider}:${eventType}`) || []
    const wildcard = this.handlers.get(`${provider}:*`) || []
    return [...specific, ...wildcard]
  }

  /**
   * Get all registered providers
   */
  getProviders(): string[] {
    return Array.from(this.processors.keys())
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.processors.clear()
    this.handlers.clear()
  }
}

/**
 * Singleton registry instance
 */
export const webhookRegistry = new WebhookRegistryImpl()
