// Custom documents keep complete channel colors for direct CSS/JS consumers.
// Utilities use split channels so modifier × custom alpha × intrinsic alpha
// never produces an invalid double slash. The helpers are compiler-owned only.
const themeColor = (token, intrinsic) => {
  const suffix = token.slice(2)
  const alpha = `var(--custom-alpha-${suffix}, 1) * ${intrinsic ? `var(${intrinsic}) * ` : ''}<alpha-value>`
  return `rgb(var(--custom-rgb-${suffix}, var(${token})) / calc(${alpha}))`
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Status, decorative badge and identity colors preserve intrinsic opacity.
        'status-progress-fg': themeColor('--status-progress-fg'),
        'status-progress-solid': themeColor('--status-progress-solid'),
        'status-progress-surface': themeColor('--status-progress-surface', '--opacity-status-progress-surface'),
        'status-progress-border': themeColor('--status-progress-border'),
        'status-progress-badge-fg': themeColor('--status-progress-badge-fg'),
        'status-progress-badge-surface': themeColor(
          '--status-progress-badge-surface',
          '--opacity-status-progress-badge-surface'
        ),
        'status-progress-badge-hover': themeColor(
          '--status-progress-badge-hover',
          '--opacity-status-progress-badge-hover'
        ),
        'status-queue-fg': themeColor('--status-queue-fg'),
        'status-queue-solid': themeColor('--status-queue-solid'),
        'status-queue-surface': themeColor('--status-queue-surface', '--opacity-status-queue-surface'),
        'status-queue-border': themeColor('--status-queue-border'),
        'status-queue-badge-fg': themeColor('--status-queue-badge-fg'),
        'status-queue-badge-surface': themeColor(
          '--status-queue-badge-surface',
          '--opacity-status-queue-badge-surface'
        ),
        'status-queue-badge-hover': themeColor('--status-queue-badge-hover', '--opacity-status-queue-badge-hover'),
        'status-review-fg': themeColor('--status-review-fg'),
        'status-review-solid': themeColor('--status-review-solid'),
        'status-review-surface': themeColor('--status-review-surface', '--opacity-status-review-surface'),
        'status-review-border': themeColor('--status-review-border'),
        'status-review-badge-fg': themeColor('--status-review-badge-fg'),
        'status-review-badge-surface': themeColor(
          '--status-review-badge-surface',
          '--opacity-status-review-badge-surface'
        ),
        'status-review-badge-hover': themeColor('--status-review-badge-hover', '--opacity-status-review-badge-hover'),
        'status-human-wait-fg': themeColor('--status-human-wait-fg'),
        'status-human-wait-solid': themeColor('--status-human-wait-solid'),
        'status-human-wait-surface': themeColor('--status-human-wait-surface', '--opacity-status-human-wait-surface'),
        'status-human-wait-border': themeColor('--status-human-wait-border'),
        'status-human-wait-badge-fg': themeColor('--status-human-wait-badge-fg'),
        'status-human-wait-badge-surface': themeColor(
          '--status-human-wait-badge-surface',
          '--opacity-status-human-wait-badge-surface'
        ),
        'status-human-wait-badge-hover': themeColor(
          '--status-human-wait-badge-hover',
          '--opacity-status-human-wait-badge-hover'
        ),
        'status-external-wait-fg': themeColor('--status-external-wait-fg'),
        'status-external-wait-solid': themeColor('--status-external-wait-solid'),
        'status-external-wait-surface': themeColor(
          '--status-external-wait-surface',
          '--opacity-status-external-wait-surface'
        ),
        'status-external-wait-border': themeColor('--status-external-wait-border'),
        'status-external-wait-badge-fg': themeColor('--status-external-wait-badge-fg'),
        'status-external-wait-badge-surface': themeColor(
          '--status-external-wait-badge-surface',
          '--opacity-status-external-wait-badge-surface'
        ),
        'status-external-wait-badge-hover': themeColor(
          '--status-external-wait-badge-hover',
          '--opacity-status-external-wait-badge-hover'
        ),
        'status-attention-fg': themeColor('--status-attention-fg'),
        'status-attention-solid': themeColor('--status-attention-solid'),
        'status-attention-surface': themeColor('--status-attention-surface', '--opacity-status-attention-surface'),
        'status-attention-border': themeColor('--status-attention-border'),
        'status-attention-badge-fg': themeColor('--status-attention-badge-fg'),
        'status-attention-badge-surface': themeColor(
          '--status-attention-badge-surface',
          '--opacity-status-attention-badge-surface'
        ),
        'status-attention-badge-hover': themeColor(
          '--status-attention-badge-hover',
          '--opacity-status-attention-badge-hover'
        ),
        'status-danger-fg': themeColor('--status-danger-fg'),
        'status-danger-solid': themeColor('--status-danger-solid'),
        'status-danger-surface': themeColor('--status-danger-surface', '--opacity-status-danger-surface'),
        'status-danger-border': themeColor('--status-danger-border'),
        'status-danger-badge-fg': themeColor('--status-danger-badge-fg'),
        'status-danger-badge-surface': themeColor(
          '--status-danger-badge-surface',
          '--opacity-status-danger-badge-surface'
        ),
        'status-danger-badge-hover': themeColor('--status-danger-badge-hover', '--opacity-status-danger-badge-hover'),
        'status-success-fg': themeColor('--status-success-fg'),
        'status-success-solid': themeColor('--status-success-solid'),
        'status-success-surface': themeColor('--status-success-surface', '--opacity-status-success-surface'),
        'status-success-border': themeColor('--status-success-border'),
        'status-success-badge-fg': themeColor('--status-success-badge-fg'),
        'status-success-badge-surface': themeColor(
          '--status-success-badge-surface',
          '--opacity-status-success-badge-surface'
        ),
        'status-success-badge-hover': themeColor(
          '--status-success-badge-hover',
          '--opacity-status-success-badge-hover'
        ),
        'status-neutral-fg': themeColor('--status-neutral-fg'),
        'status-neutral-solid': themeColor('--status-neutral-solid'),
        'status-neutral-surface': themeColor('--status-neutral-surface', '--opacity-status-neutral-surface'),
        'status-neutral-border': themeColor('--status-neutral-border'),
        'status-neutral-badge-fg': themeColor('--status-neutral-badge-fg'),
        'status-neutral-badge-surface': themeColor(
          '--status-neutral-badge-surface',
          '--opacity-status-neutral-badge-surface'
        ),
        'status-neutral-badge-hover': themeColor(
          '--status-neutral-badge-hover',
          '--opacity-status-neutral-badge-hover'
        ),
        'badge-accent-1-fg': themeColor('--badge-accent-1-fg'),
        'badge-accent-1-surface': themeColor('--badge-accent-1-surface', '--opacity-badge-accent-1-surface'),
        'badge-accent-1-hover': themeColor('--badge-accent-1-hover', '--opacity-badge-accent-1-hover'),
        'badge-accent-2-fg': themeColor('--badge-accent-2-fg'),
        'badge-accent-2-surface': themeColor('--badge-accent-2-surface', '--opacity-badge-accent-2-surface'),
        'badge-accent-2-hover': themeColor('--badge-accent-2-hover', '--opacity-badge-accent-2-hover'),
        'badge-accent-3-fg': themeColor('--badge-accent-3-fg'),
        'badge-accent-3-surface': themeColor('--badge-accent-3-surface', '--opacity-badge-accent-3-surface'),
        'badge-accent-3-hover': themeColor('--badge-accent-3-hover', '--opacity-badge-accent-3-hover'),
        'badge-accent-4-fg': themeColor('--badge-accent-4-fg'),
        'badge-accent-4-surface': themeColor('--badge-accent-4-surface', '--opacity-badge-accent-4-surface'),
        'badge-accent-4-hover': themeColor('--badge-accent-4-hover', '--opacity-badge-accent-4-hover'),
        'badge-accent-5-fg': themeColor('--badge-accent-5-fg'),
        'badge-accent-5-surface': themeColor('--badge-accent-5-surface', '--opacity-badge-accent-5-surface'),
        'badge-accent-5-hover': themeColor('--badge-accent-5-hover', '--opacity-badge-accent-5-hover'),
        'badge-accent-6-fg': themeColor('--badge-accent-6-fg'),
        'badge-accent-6-surface': themeColor('--badge-accent-6-surface', '--opacity-badge-accent-6-surface'),
        'badge-accent-6-hover': themeColor('--badge-accent-6-hover', '--opacity-badge-accent-6-hover'),
        'badge-accent-7-fg': themeColor('--badge-accent-7-fg'),
        'badge-accent-7-surface': themeColor('--badge-accent-7-surface', '--opacity-badge-accent-7-surface'),
        'badge-accent-7-hover': themeColor('--badge-accent-7-hover', '--opacity-badge-accent-7-hover'),
        'agent-type-1': themeColor('--agent-type-1-fg'),
        'agent-type-2': themeColor('--agent-type-2-fg'),
        'agent-type-3': themeColor('--agent-type-3-fg'),
        'agent-type-4': themeColor('--agent-type-4-fg'),
        'agent-type-5': themeColor('--agent-type-5-fg'),
        'agent-type-6': themeColor('--agent-type-6-fg'),
        'on-accent': themeColor('--on-accent-fg'),
        // Semantic theme colors. Token values in src/index.css are RGB channel
        // triplets and every entry uses the <alpha-value> channel form, so
        // opacity modifiers (bg-surface/50) compile to real rules instead of
        // silently producing none. Guarded by src/theme-color-opacity.test.ts.
        page: themeColor('--color-bg-page'),
        surface: {
          DEFAULT: themeColor('--color-bg-surface'),
          secondary: themeColor('--color-bg-surface-secondary'),
          hover: themeColor('--color-bg-surface-hover'),
        },
        inset: themeColor('--color-bg-inset'),
        pill: themeColor('--color-bg-pill'),
        primary: themeColor('--color-text-primary'),
        secondary: themeColor('--color-text-secondary'),
        muted: themeColor('--color-text-muted'),
        placeholder: themeColor('--color-text-placeholder'),
        'th-border': themeColor('--color-border'),
        'th-border-hover': themeColor('--color-border-hover'),
        selection: {
          DEFAULT: themeColor('--color-selection-bg'),
          border: themeColor('--color-selection-border'),
        },
        overlay: themeColor('--color-overlay'),
        focus: themeColor('--color-focus'),
        // Multiply intrinsic alpha (shared with direct CSS consumers) by the
        // requested opacity: /25 means 25% of the original translucent color.
        'panel-border': themeColor('--color-panel-border', '--opacity-panel-border'),
        'input-bg': themeColor('--color-input-bg'),
        'input-border': themeColor('--color-input-border', '--opacity-input-border'),
        'code-bg': themeColor('--color-code-bg'),
        'code-text': themeColor('--color-code-text'),
        accent: {
          DEFAULT: themeColor('--color-primary'),
          hover: themeColor('--color-primary-hover'),
          active: themeColor('--color-primary-active'),
          light: themeColor('--color-primary-light'),
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
