import type { Config } from 'tailwindcss'
import animatePlugin from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'ac-bg': '#0D0F14',
        'ac-surface': '#13161E',
        'ac-surface2': '#1A1D27',
        'ac-border': '#2A2D3A',
        'ac-border-strong': '#3A3D4E',
        'ac-text': '#E8E6FF',
        'ac-muted': '#8B8DA8',
        'ac-hint': '#5A5C75',
        'ac-teal': '#1DE9B6',
        'ac-teal-light': '#0D2E26',
        'ac-purple': '#9B6DFF',
        'ac-purple-light': '#1A1030',
        'ac-amber': '#FFB347',
        'ac-amber-light': '#2A1F0A',
        'ac-red': '#FF5370',
        'ac-red-light': '#2A0F14',
        'ac-blue': '#82AAFF',
        'ac-blue-light': '#0F1A2E',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"DM Mono"', 'monospace'],
      },
      borderRadius: {
        card: '12px',
        btn: '8px',
        badge: '20px',
      },
      spacing: {
        sidebar: '216px',
      },
    },
  },
  plugins: [animatePlugin],
} satisfies Config
