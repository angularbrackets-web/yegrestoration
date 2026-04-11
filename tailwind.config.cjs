/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{astro,html,js,ts,jsx,tsx,svelte}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        yeg: {
          bg: '#0B0F17',
          'bg-light': '#111827',
          amber: '#F2C94C',
          'amber-hover': '#f5d56a',
          text: '#F4F2ED',
          'text-secondary': '#B8C2CE',
          signal: {
            DEFAULT: '#C2410C',
            bright: '#E85D04',
          },
          'signal-on-dark': '#FB923C',
          surface: '#f7f5f2',
          'on-surface': '#0f1419',
          'on-surface-muted': '#5a6270',
        },
      },
      fontFamily: {
        display: ['Sora', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display-xl': ['clamp(44px, 6vw, 84px)', { lineHeight: '0.92', letterSpacing: '-0.03em' }],
        'display-lg': ['clamp(34px, 4.2vw, 56px)', { lineHeight: '0.95', letterSpacing: '-0.02em' }],
        'display-bg': ['clamp(96px, 18vw, 280px)', { lineHeight: '0.85', letterSpacing: '-0.06em' }],
      },
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xs: 'calc(var(--radius) - 6px)',
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        image: '0 18px 50px rgba(0, 0, 0, 0.45)',
      },
      keyframes: {
        'beacon-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(232, 93, 4, 0.35)' },
          '50%': { boxShadow: '0 0 0 12px rgba(232, 93, 4, 0)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(50px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-left': {
          '0%': { opacity: '0', transform: 'translateX(-50px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'beacon-pulse': 'beacon-pulse 2s ease-in-out infinite',
        'fade-up': 'fade-up 0.6s ease-out forwards',
        'fade-in': 'fade-in 0.5s ease-out forwards',
        'slide-in-right': 'slide-in-right 0.8s ease-out forwards',
        'slide-in-left': 'slide-in-left 0.8s ease-out forwards',
      },
    },
  },
  plugins: [],
};
