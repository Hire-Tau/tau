/** Public, secret-free startup state. Liveness is deliberately a separate endpoint. */
export class RuntimeReadiness {
  private ready = false

  constructor(
    private readonly service: 'api' | 'worker',
    private readonly instanceId: string | undefined
  ) {}

  markReady(): void {
    this.ready = true
  }

  markStopping(): void {
    this.ready = false
  }

  response(): Response {
    return Response.json(
      {
        service: this.service,
        ready: this.ready,
        instanceId: this.instanceId && /^[a-f0-9-]{36}$/.test(this.instanceId) ? this.instanceId : null,
      },
      { status: this.ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
