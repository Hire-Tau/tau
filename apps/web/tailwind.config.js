/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        page: 'var(--color-bg-page)',
        surface: {
          DEFAULT: 'var(--color-bg-surface)',
          secondary: 'var(--color-bg-surface-secondary)',
          hover: 'var(--color-bg-surface-hover)',
        },
        inset: 'var(--color-bg-inset)',
        pill: 'var(--color-bg-pill)',
        primary: 'var(--color-text-primary)',
        secondary: 'var(--color-text-secondary)',
        muted: 'var(--color-text-muted)',
        placeholder: 'var(--color-text-placeholder)',
        'th-border': 'var(--color-border)',
        'th-border-hover': 'var(--color-border-hover)',
        selection: { DEFAULT: 'var(--color-selection-bg)', border: 'var(--color-selection-border)' },
        overlay: 'var(--color-overlay)',
        focus: 'var(--color-focus)',
        'panel-border': 'var(--color-panel-border)',
        'input-bg': 'var(--color-input-bg)',
        'input-border': 'var(--color-input-border)',
        'code-bg': 'var(--color-code-bg)',
        'code-text': 'var(--color-code-text)',
        accent: {
          DEFAULT: 'var(--color-primary)',
          hover: 'var(--color-primary-hover)',
          active: 'var(--color-primary-active)',
          light: 'var(--color-primary-light)',
        },
      },
      borderRadius: { DEFAULT: '0.5rem', md: '0.5rem', lg: '0.75rem', xl: '1rem' },
      transitionDuration: { DEFAULT: '140ms' },
      boxShadow: {
        theme: 'none',
        'theme-lg': '0 16px 48px -12px var(--color-shadow-lg), 0 2px 8px var(--color-shadow)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
