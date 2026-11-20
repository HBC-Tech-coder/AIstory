import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cream: {
          50: "#FFFFFF",
          100: "#F1F5FF",
          200: "#E8EEFC",
          300: "#97AEFF",
        },
        clay: {
          400: "rgb(var(--ui-soft) / <alpha-value>)",
          500: "rgb(var(--ui-muted) / <alpha-value>)",
          600: "rgb(var(--ui-copy) / <alpha-value>)",
          700: "rgb(var(--ui-ink-subtle) / <alpha-value>)",
          900: "rgb(var(--ui-ink) / <alpha-value>)",
        },
        ember: {
          400: "rgb(var(--ui-primary-soft) / <alpha-value>)",
          500: "rgb(var(--ui-primary) / <alpha-value>)",
        },
        stone: {
          50: "rgb(var(--ui-surface-soft) / <alpha-value>)",
          100: "rgb(var(--ui-surface-muted) / <alpha-value>)",
          200: "rgb(var(--ui-border) / <alpha-value>)",
          300: "rgb(var(--ui-border-strong) / <alpha-value>)",
          400: "rgb(var(--ui-soft) / <alpha-value>)",
          500: "rgb(var(--ui-muted) / <alpha-value>)",
          600: "rgb(var(--ui-copy) / <alpha-value>)",
          700: "rgb(var(--ui-ink-subtle) / <alpha-value>)",
          800: "rgb(var(--ui-ink) / <alpha-value>)",
          900: "rgb(var(--ui-ink) / <alpha-value>)",
        },
      },
      fontFamily: {
        serif: ['var(--font-serif)', '"Source Han Serif SC"', "ui-serif", "Georgia", "serif"],
        sans: ['var(--font-sans)', '"PingFang SC"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        widest: "0.32em",
      },
      animation: {
        "fade-in": "fadeIn 0.6s ease-out",
        "slow-pulse": "slowPulse 2.6s ease-in-out infinite",
        "drift": "drift 12s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slowPulse: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        drift: {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(0, -10px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
