/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
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
        'panel-border': 'rgb(var(--color-panel-border) / <alpha-value>)',
        'input-bg': 'rgb(var(--color-input-bg) / <alpha-value>)',
        'input-border': 'rgb(var(--color-input-border) / <alpha-value>)',
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
