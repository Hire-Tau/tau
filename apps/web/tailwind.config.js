/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Status, decorative badge and identity colors preserve intrinsic opacity.
        'status-progress-fg': 'rgb(var(--status-progress-fg) / <alpha-value>)',
        'status-progress-solid': 'rgb(var(--status-progress-solid) / <alpha-value>)',
        'status-progress-surface':
          'rgb(var(--status-progress-surface) / calc(var(--opacity-status-progress-surface) * <alpha-value>))',
        'status-progress-border': 'rgb(var(--status-progress-border) / <alpha-value>)',
        'status-progress-badge-fg': 'rgb(var(--status-progress-badge-fg) / <alpha-value>)',
        'status-progress-badge-surface':
          'rgb(var(--status-progress-badge-surface) / calc(var(--opacity-status-progress-badge-surface) * <alpha-value>))',
        'status-progress-badge-hover':
          'rgb(var(--status-progress-badge-hover) / calc(var(--opacity-status-progress-badge-hover) * <alpha-value>))',
        'status-queue-fg': 'rgb(var(--status-queue-fg) / <alpha-value>)',
        'status-queue-solid': 'rgb(var(--status-queue-solid) / <alpha-value>)',
        'status-queue-surface':
          'rgb(var(--status-queue-surface) / calc(var(--opacity-status-queue-surface) * <alpha-value>))',
        'status-queue-border': 'rgb(var(--status-queue-border) / <alpha-value>)',
        'status-queue-badge-fg': 'rgb(var(--status-queue-badge-fg) / <alpha-value>)',
        'status-queue-badge-surface':
          'rgb(var(--status-queue-badge-surface) / calc(var(--opacity-status-queue-badge-surface) * <alpha-value>))',
        'status-queue-badge-hover':
          'rgb(var(--status-queue-badge-hover) / calc(var(--opacity-status-queue-badge-hover) * <alpha-value>))',
        'status-review-fg': 'rgb(var(--status-review-fg) / <alpha-value>)',
        'status-review-solid': 'rgb(var(--status-review-solid) / <alpha-value>)',
        'status-review-surface':
          'rgb(var(--status-review-surface) / calc(var(--opacity-status-review-surface) * <alpha-value>))',
        'status-review-border': 'rgb(var(--status-review-border) / <alpha-value>)',
        'status-review-badge-fg': 'rgb(var(--status-review-badge-fg) / <alpha-value>)',
        'status-review-badge-surface':
          'rgb(var(--status-review-badge-surface) / calc(var(--opacity-status-review-badge-surface) * <alpha-value>))',
        'status-review-badge-hover':
          'rgb(var(--status-review-badge-hover) / calc(var(--opacity-status-review-badge-hover) * <alpha-value>))',
        'status-human-wait-fg': 'rgb(var(--status-human-wait-fg) / <alpha-value>)',
        'status-human-wait-solid': 'rgb(var(--status-human-wait-solid) / <alpha-value>)',
        'status-human-wait-surface':
          'rgb(var(--status-human-wait-surface) / calc(var(--opacity-status-human-wait-surface) * <alpha-value>))',
        'status-human-wait-border': 'rgb(var(--status-human-wait-border) / <alpha-value>)',
        'status-human-wait-badge-fg': 'rgb(var(--status-human-wait-badge-fg) / <alpha-value>)',
        'status-human-wait-badge-surface':
          'rgb(var(--status-human-wait-badge-surface) / calc(var(--opacity-status-human-wait-badge-surface) * <alpha-value>))',
        'status-human-wait-badge-hover':
          'rgb(var(--status-human-wait-badge-hover) / calc(var(--opacity-status-human-wait-badge-hover) * <alpha-value>))',
        'status-external-wait-fg': 'rgb(var(--status-external-wait-fg) / <alpha-value>)',
        'status-external-wait-solid': 'rgb(var(--status-external-wait-solid) / <alpha-value>)',
        'status-external-wait-surface':
          'rgb(var(--status-external-wait-surface) / calc(var(--opacity-status-external-wait-surface) * <alpha-value>))',
        'status-external-wait-border': 'rgb(var(--status-external-wait-border) / <alpha-value>)',
        'status-external-wait-badge-fg': 'rgb(var(--status-external-wait-badge-fg) / <alpha-value>)',
        'status-external-wait-badge-surface':
          'rgb(var(--status-external-wait-badge-surface) / calc(var(--opacity-status-external-wait-badge-surface) * <alpha-value>))',
        'status-external-wait-badge-hover':
          'rgb(var(--status-external-wait-badge-hover) / calc(var(--opacity-status-external-wait-badge-hover) * <alpha-value>))',
        'status-attention-fg': 'rgb(var(--status-attention-fg) / <alpha-value>)',
        'status-attention-solid': 'rgb(var(--status-attention-solid) / <alpha-value>)',
        'status-attention-surface':
          'rgb(var(--status-attention-surface) / calc(var(--opacity-status-attention-surface) * <alpha-value>))',
        'status-attention-border': 'rgb(var(--status-attention-border) / <alpha-value>)',
        'status-attention-badge-fg': 'rgb(var(--status-attention-badge-fg) / <alpha-value>)',
        'status-attention-badge-surface':
          'rgb(var(--status-attention-badge-surface) / calc(var(--opacity-status-attention-badge-surface) * <alpha-value>))',
        'status-attention-badge-hover':
          'rgb(var(--status-attention-badge-hover) / calc(var(--opacity-status-attention-badge-hover) * <alpha-value>))',
        'status-danger-fg': 'rgb(var(--status-danger-fg) / <alpha-value>)',
        'status-danger-solid': 'rgb(var(--status-danger-solid) / <alpha-value>)',
        'status-danger-surface':
          'rgb(var(--status-danger-surface) / calc(var(--opacity-status-danger-surface) * <alpha-value>))',
        'status-danger-border': 'rgb(var(--status-danger-border) / <alpha-value>)',
        'status-danger-badge-fg': 'rgb(var(--status-danger-badge-fg) / <alpha-value>)',
        'status-danger-badge-surface':
          'rgb(var(--status-danger-badge-surface) / calc(var(--opacity-status-danger-badge-surface) * <alpha-value>))',
        'status-danger-badge-hover':
          'rgb(var(--status-danger-badge-hover) / calc(var(--opacity-status-danger-badge-hover) * <alpha-value>))',
        'status-success-fg': 'rgb(var(--status-success-fg) / <alpha-value>)',
        'status-success-solid': 'rgb(var(--status-success-solid) / <alpha-value>)',
        'status-success-surface':
          'rgb(var(--status-success-surface) / calc(var(--opacity-status-success-surface) * <alpha-value>))',
        'status-success-border': 'rgb(var(--status-success-border) / <alpha-value>)',
        'status-success-badge-fg': 'rgb(var(--status-success-badge-fg) / <alpha-value>)',
        'status-success-badge-surface':
          'rgb(var(--status-success-badge-surface) / calc(var(--opacity-status-success-badge-surface) * <alpha-value>))',
        'status-success-badge-hover':
          'rgb(var(--status-success-badge-hover) / calc(var(--opacity-status-success-badge-hover) * <alpha-value>))',
        'status-neutral-fg': 'rgb(var(--status-neutral-fg) / <alpha-value>)',
        'status-neutral-solid': 'rgb(var(--status-neutral-solid) / <alpha-value>)',
        'status-neutral-surface':
          'rgb(var(--status-neutral-surface) / calc(var(--opacity-status-neutral-surface) * <alpha-value>))',
        'status-neutral-border': 'rgb(var(--status-neutral-border) / <alpha-value>)',
        'status-neutral-badge-fg': 'rgb(var(--status-neutral-badge-fg) / <alpha-value>)',
        'status-neutral-badge-surface':
          'rgb(var(--status-neutral-badge-surface) / calc(var(--opacity-status-neutral-badge-surface) * <alpha-value>))',
        'status-neutral-badge-hover':
          'rgb(var(--status-neutral-badge-hover) / calc(var(--opacity-status-neutral-badge-hover) * <alpha-value>))',
        'badge-accent-1-fg': 'rgb(var(--badge-accent-1-fg) / <alpha-value>)',
        'badge-accent-1-surface':
          'rgb(var(--badge-accent-1-surface) / calc(var(--opacity-badge-accent-1-surface) * <alpha-value>))',
        'badge-accent-1-hover':
          'rgb(var(--badge-accent-1-hover) / calc(var(--opacity-badge-accent-1-hover) * <alpha-value>))',
        'badge-accent-2-fg': 'rgb(var(--badge-accent-2-fg) / <alpha-value>)',
        'badge-accent-2-surface':
          'rgb(var(--badge-accent-2-surface) / calc(var(--opacity-badge-accent-2-surface) * <alpha-value>))',
        'badge-accent-2-hover':
          'rgb(var(--badge-accent-2-hover) / calc(var(--opacity-badge-accent-2-hover) * <alpha-value>))',
        'badge-accent-3-fg': 'rgb(var(--badge-accent-3-fg) / <alpha-value>)',
        'badge-accent-3-surface':
          'rgb(var(--badge-accent-3-surface) / calc(var(--opacity-badge-accent-3-surface) * <alpha-value>))',
        'badge-accent-3-hover':
          'rgb(var(--badge-accent-3-hover) / calc(var(--opacity-badge-accent-3-hover) * <alpha-value>))',
        'badge-accent-4-fg': 'rgb(var(--badge-accent-4-fg) / <alpha-value>)',
        'badge-accent-4-surface':
          'rgb(var(--badge-accent-4-surface) / calc(var(--opacity-badge-accent-4-surface) * <alpha-value>))',
        'badge-accent-4-hover':
          'rgb(var(--badge-accent-4-hover) / calc(var(--opacity-badge-accent-4-hover) * <alpha-value>))',
        'badge-accent-5-fg': 'rgb(var(--badge-accent-5-fg) / <alpha-value>)',
        'badge-accent-5-surface':
          'rgb(var(--badge-accent-5-surface) / calc(var(--opacity-badge-accent-5-surface) * <alpha-value>))',
        'badge-accent-5-hover':
          'rgb(var(--badge-accent-5-hover) / calc(var(--opacity-badge-accent-5-hover) * <alpha-value>))',
        'badge-accent-6-fg': 'rgb(var(--badge-accent-6-fg) / <alpha-value>)',
        'badge-accent-6-surface':
          'rgb(var(--badge-accent-6-surface) / calc(var(--opacity-badge-accent-6-surface) * <alpha-value>))',
        'badge-accent-6-hover':
          'rgb(var(--badge-accent-6-hover) / calc(var(--opacity-badge-accent-6-hover) * <alpha-value>))',
        'badge-accent-7-fg': 'rgb(var(--badge-accent-7-fg) / <alpha-value>)',
        'badge-accent-7-surface':
          'rgb(var(--badge-accent-7-surface) / calc(var(--opacity-badge-accent-7-surface) * <alpha-value>))',
        'badge-accent-7-hover':
          'rgb(var(--badge-accent-7-hover) / calc(var(--opacity-badge-accent-7-hover) * <alpha-value>))',
        'agent-type-1': 'rgb(var(--agent-type-1-fg) / <alpha-value>)',
        'agent-type-2': 'rgb(var(--agent-type-2-fg) / <alpha-value>)',
        'agent-type-3': 'rgb(var(--agent-type-3-fg) / <alpha-value>)',
        'agent-type-4': 'rgb(var(--agent-type-4-fg) / <alpha-value>)',
        'agent-type-5': 'rgb(var(--agent-type-5-fg) / <alpha-value>)',
        'agent-type-6': 'rgb(var(--agent-type-6-fg) / <alpha-value>)',
        'on-accent': 'rgb(var(--on-accent-fg) / <alpha-value>)',
        // Semantic theme colors. Token values in src/index.css are RGB channel
        // triplets and every entry uses the <alpha-value> channel form, so
        // opacity modifiers (bg-surface/50) compile to real rules instead of
        // silently producing none. Guarded by src/theme-color-opacity.test.ts.
        page: 'rgb(var(--color-bg-page) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-bg-surface) / <alpha-value>)',
          secondary: 'rgb(var(--color-bg-surface-secondary) / <alpha-value>)',
          hover: 'rgb(var(--color-bg-surface-hover) / <alpha-value>)',
        },
        inset: 'rgb(var(--color-bg-inset) / <alpha-value>)',
        pill: 'rgb(var(--color-bg-pill) / <alpha-value>)',
        primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
        muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        placeholder: 'rgb(var(--color-text-placeholder) / <alpha-value>)',
        'th-border': 'rgb(var(--color-border) / <alpha-value>)',
        'th-border-hover': 'rgb(var(--color-border-hover) / <alpha-value>)',
        selection: {
          DEFAULT: 'rgb(var(--color-selection-bg) / <alpha-value>)',
          border: 'rgb(var(--color-selection-border) / <alpha-value>)',
        },
        overlay: 'rgb(var(--color-overlay) / <alpha-value>)',
        focus: 'rgb(var(--color-focus) / <alpha-value>)',
        // Multiply intrinsic alpha (shared with direct CSS consumers) by the
        // requested opacity: /25 means 25% of the original translucent color.
        'panel-border': 'rgb(var(--color-panel-border) / calc(var(--opacity-panel-border) * <alpha-value>))',
        'input-bg': 'rgb(var(--color-input-bg) / <alpha-value>)',
        'input-border': 'rgb(var(--color-input-border) / calc(var(--opacity-input-border) * <alpha-value>))',
        'code-bg': 'rgb(var(--color-code-bg) / <alpha-value>)',
        'code-text': 'rgb(var(--color-code-text) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          hover: 'rgb(var(--color-primary-hover) / <alpha-value>)',
          active: 'rgb(var(--color-primary-active) / <alpha-value>)',
          light: 'rgb(var(--color-primary-light) / <alpha-value>)',
        },
      },
      borderRadius: { DEFAULT: '0.5rem', md: '0.5rem', lg: '0.75rem', xl: '1rem' },
      transitionDuration: { DEFAULT: '140ms' },
      boxShadow: {
        theme: 'none',
        'theme-lg': '0 16px 48px -12px rgb(var(--color-shadow-lg)), 0 2px 8px rgb(var(--color-shadow))',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
