/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    // Dense operational scale: 13px is the workhorse body size, and the steps
    // below it stay legible because line-heights are set per step.
    fontSize: {
      '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      xs: ['0.75rem', { lineHeight: '1.125rem' }],
      sm: ['0.8125rem', { lineHeight: '1.25rem' }],
      base: ['0.875rem', { lineHeight: '1.375rem' }],
      lg: ['1rem', { lineHeight: '1.5rem' }],
      xl: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em' }],
      '2xl': ['1.375rem', { lineHeight: '1.875rem', letterSpacing: '-0.015em' }],
      '3xl': ['1.75rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
    },
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          raised: 'hsl(var(--surface-raised))',
          sunken: 'hsl(var(--surface-sunken))',
        },
        overlay: 'hsl(var(--overlay))',
        border: {
          DEFAULT: 'hsl(var(--border))',
          strong: 'hsl(var(--border-strong))',
        },
        ring: 'hsl(var(--ring))',
        text: {
          DEFAULT: 'hsl(var(--text))',
          muted: 'hsl(var(--text-muted))',
          subtle: 'hsl(var(--text-subtle))',
          inverse: 'hsl(var(--text-inverse))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          hover: 'hsl(var(--primary-hover))',
          subtle: 'hsl(var(--primary-subtle))',
          fg: 'hsl(var(--primary-text))',
        },
        success: { DEFAULT: 'hsl(var(--success))', subtle: 'hsl(var(--success-subtle))' },
        warning: { DEFAULT: 'hsl(var(--warning))', subtle: 'hsl(var(--warning-subtle))' },
        danger: { DEFAULT: 'hsl(var(--danger))', subtle: 'hsl(var(--danger-subtle))' },
        info: { DEFAULT: 'hsl(var(--info))', subtle: 'hsl(var(--info-subtle))' },
        'neutral-status': {
          DEFAULT: 'hsl(var(--neutral-status))',
          subtle: 'hsl(var(--neutral-subtle))',
        },
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 3px)',
        DEFAULT: 'calc(var(--radius) - 2px)',
        md: 'calc(var(--radius) - 1px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      spacing: {
        // Row heights for the three density steps used across tables/lists.
        row: '2.25rem',
        'row-lg': '2.75rem',
        sidebar: '15rem',
        topbar: '3rem',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'zoom-in': { from: { opacity: '0', transform: 'scale(0.97)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'zoom-in': 'zoom-in 120ms ease-out',
        'slide-in-right': 'slide-in-right 180ms cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
