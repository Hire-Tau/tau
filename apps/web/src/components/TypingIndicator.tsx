/** Three brand-colored dots pulsing in a staggered wave — shown while the agent is working. */
export function TypingIndicator({ label = 'Agent is working' }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 py-1" role="status" aria-label={label} data-testid="typing-indicator">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-accent"
          style={{ animation: 'typing-dot 1.2s ease-in-out infinite', animationDelay: `${i * 180}ms` }}
        />
      ))}
    </div>
  )
}
