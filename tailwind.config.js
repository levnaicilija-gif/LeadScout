/**
 * Design tokens from design/leadscout-design-v4.html.
 *
 * Two families of colour, and they do different jobs. The status colours (ok / warn / bad) say
 * what is true about a fact — verified, waiting, failed — and are the only ones allowed to carry
 * that meaning. The tool colours say where you are: Leads is blue, Verify green, Pitch amber,
 * Candidates violet. A tool colour never means "good"; a status colour never means "this screen".
 *
 * Tool colours are only ever applied through the maps in src/lib/tool-colour.ts, because Tailwind
 * cannot build a class name at runtime — `bg-tool-${x}` compiles to nothing.
 */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rail: '#0E1A2B', rail2: '#16263B', railink: '#C9D3E0', raildim: '#7D8BA0',
        bg: '#F6F7F9', panel: '#FFFFFF', ink: '#141B26', ink2: '#4F5966', ink3: '#8590A0',
        line: '#E6E9EE', line2: '#F0F2F5', accent: '#1F5FBF', accentsoft: '#E8F0FC',
        ok: '#178A5A', oksoft: '#E4F5EC', warn: '#D97A1F', warnsoft: '#FCEEDD', bad: '#C93B3B', badsoft: '#FBE7E7',
        // where you are
        tool: { today: '#0E1A2B', leads: '#1F5FBF', verify: '#178A5A', pitch: '#D97A1F', cand: '#6B4FD8', set: '#5B6472', radar: '#0FA3A3' },
        soft: { today: '#E7EAEF', leads: '#E8F0FC', verify: '#E4F5EC', pitch: '#FCEEDD', cand: '#EEE9FB', set: '#EEF1F5', radar: '#E1F5F5' },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      borderRadius: { DEFAULT: '10px', card: '16px', tile: '18px' },
    },
  },
  plugins: [],
};
