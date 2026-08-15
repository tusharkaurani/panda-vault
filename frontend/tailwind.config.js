/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        panda: {
          bg: "rgb(var(--panda-bg) / <alpha-value>)",
          surface: "rgb(var(--panda-surface) / <alpha-value>)",
          surface2: "rgb(var(--panda-surface2) / <alpha-value>)",
          border: "rgb(var(--panda-border) / <alpha-value>)",
          text: "rgb(var(--panda-text) / <alpha-value>)",
          muted: "rgb(var(--panda-muted) / <alpha-value>)",
          accent: "rgb(var(--panda-accent) / <alpha-value>)",
          accent2: "rgb(var(--panda-accent2) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};
