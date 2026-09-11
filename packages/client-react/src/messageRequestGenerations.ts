/** Tracks only currently unresolved per-message fetches while keeping generations globally unique. */
export class MessageRequestGenerations {
  private readonly current = new Map<string, number>()
  private nextGeneration = 0

  begin(messageId: string): number {
    this.nextGeneration += 1
    this.current.set(messageId, this.nextGeneration)
    return this.nextGeneration
  }

  isCurrent(messageId: string, generation: number): boolean {
    return this.current.get(messageId) === generation
  }

  finish(messageId: string, generation: number): void {
    if (this.isCurrent(messageId, generation)) this.current.delete(messageId)
  }

  invalidate(messageId: string): void {
    this.current.delete(messageId)
  }

  clear(): void {
    this.current.clear()
  }

  get size(): number {
    return this.current.size
  }
}
