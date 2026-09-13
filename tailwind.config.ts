import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FAFBFA',
        surface: '#FFFFFF',
        sunken: '#F1F4F2',
        ink: { DEFAULT: '#101619', 2: '#3A4649', muted: '#6A7779' },
        line: { DEFAULT: '#DFE5E2', strong: '#C4CEC9' },
        jade: { DEFAULT: '#0E6F60', soft: '#E3F1ED' },
        clay: { DEFAULT: '#AB5322', soft: '#FAEBE0' },
        slate2: { DEFAULT: '#35506B', soft: '#E7EDF3' },
        gold: { DEFAULT: '#8A6508', soft: '#F6EFD8' },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans KR"', '"Apple SD Gothic Neo"', '"Malgun Gothic"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        serif: ['"Noto Serif KR"', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
