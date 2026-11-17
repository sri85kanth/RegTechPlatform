/** @type {import('tailwindcss').Config} */
// Design system — Apple-style clarity for a compliance product.
// Neutral greys, one accent (Apple blue), status colours that always mean the
// same thing (met / partial / gap / not covered), soft layered depth and
// spring-eased motion. Text colours keep a darker shade of each hue so every
// label passes WCAG AA on white.
const FONT_STACK = [
  // San Francisco on Apple devices, Inter everywhere else
  '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'SF Pro Display', 'Inter',
  // Noto faces cover Indian scripts when a translated interface is chosen (see src/i18n)
  'Noto Sans Devanagari', 'Noto Sans Bengali', 'Noto Sans Telugu', 'Noto Sans Tamil',
  'Noto Sans Gujarati', 'Noto Sans Kannada', 'Noto Sans Malayalam', 'Nirmala UI',
  'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif',
];

// Apple's neutral greys. 500 and darker pass AA as text on white.
const GREY = {
  50: '#f9f9fb', 100: '#f2f2f7', 200: '#e5e5ea', 300: '#d1d1d6', 400: '#a1a1a6',
  500: '#6e6e73', 600: '#515154', 700: '#3a3a3c', 800: '#2c2c2e', 900: '#1d1d1f', 950: '#111113',
};
// Apple blue (#0071E3) and its tints and shades
const BLUE = {
  50: '#eef6ff', 100: '#dcebfe', 200: '#b9d8fd', 300: '#8cc0fb', 400: '#3a9bf7',
  500: '#0071e3', 600: '#0071e3', 700: '#0062c4', 800: '#0050a0', 900: '#003d7a', 950: '#002a55',
};

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: BLUE,
        blue: BLUE,
        slate: GREY,
        gray: GREY,
        ink: { DEFAULT: '#1d1d1f', 2: '#424245' },        // text / secondary text
        line: { DEFAULT: '#e5e5ea', 2: '#d1d1d6' },       // hairline / stronger hairline
        muted: { DEFAULT: '#6e6e73', 2: '#6e6e73' },      // secondary / tertiary text — AA on white
        side: { 1: '#ffffff', 2: '#f5f5f7' },             // sidebar
        canvas: '#f5f5f7',                                // app background
        surface: '#ffffff',
        header: '#0071e3',
        // status — system colours for fills; 600/700 are the AA text shades
        success: { 50: '#effaf2', 100: '#d9f5e1', 200: '#b3eac3', 500: '#34c759', 600: '#1f8a3d', 700: '#1a7434' },   // Met / Compliant
        warning: { 50: '#fff8eb', 100: '#ffefcc', 200: '#ffdf99', 500: '#ff9f0a', 600: '#b45f00', 700: '#9a5200' },   // Partial / Medium
        critical: { 50: '#fff1f0', 100: '#ffe0de', 200: '#ffc2bd', 500: '#ff3b30', 600: '#d70015', 700: '#b00012' },  // Gap / Critical
        notcov: { 50: '#fff4ec', 100: '#ffe6d3', 200: '#ffcba6', 500: '#ff6a00', 600: '#c24f00', 700: '#a34200' },    // Not covered / High
      },
      fontFamily: {
        sans: FONT_STACK,
        // ids and clause numbers use the product font with tabular figures — no typewriter text
        mono: FONT_STACK,
      },
      letterSpacing: {
        display: '-0.022em',
        tightish: '-0.011em',
      },
      boxShadow: {
        // one elevation scale: rest → hover → overlay. A 0.5px ring stands in for a border.
        card: '0 0 0 0.5px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
        pop: '0 0 0 0.5px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.05), 0 14px 36px rgba(0,0,0,0.09)',
        drawer: '-18px 0 56px rgba(0,0,0,0.12)',
        float: '0 0 0 0.5px rgba(0,0,0,0.06), 0 10px 28px rgba(0,0,0,0.10), 0 28px 72px rgba(0,0,0,0.12)',
        glow: '0 0 0 4px rgba(0,113,227,0.18)',
      },
      fontSize: {
        '2xs': ['11px', '1.35'],
      },
      borderRadius: {
        card: '18px',
      },
      transitionTimingFunction: {
        // Apple-like easing: a quick start that settles softly
        spring: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        apple: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      },
      keyframes: {
        'cb-rise': { from: { opacity: '0', transform: 'translateY(8px) scale(0.995)' }, to: { opacity: '1', transform: 'none' } },
        'cb-pop': { from: { opacity: '0', transform: 'translateY(-4px) scale(0.97)' }, to: { opacity: '1', transform: 'none' } },
        'cb-fade': { from: { opacity: '0' }, to: { opacity: '1' } },
        'cb-shimmer': { from: { backgroundPosition: '-200% 0' }, to: { backgroundPosition: '200% 0' } },
      },
      animation: {
        rise: 'cb-rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) backwards',
        pop: 'cb-pop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1) backwards',
        fade: 'cb-fade 0.3s ease backwards',
      },
    },
  },
  plugins: [],
};
