/** Design tokens from leadscout.html — one accent, status colours only for verification/timing. */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rail: '#0E1A2B', rail2: '#16263B', railink: '#C9D3E0', raildim: '#7D8BA0',
        bg: '#F3F5F7', panel: '#FFFFFF', ink: '#141B26', ink2: '#4F5966', ink3: '#8590A0',
        line: '#E3E7EC', line2: '#EEF1F4', accent: '#0F4C81', accentsoft: '#E6EFF7',
        ok: '#1E7F4F', oksoft: '#E3F2EA', warn: '#B7791F', warnsoft: '#FBF0DA', bad: '#B23A3A', badsoft: '#F8E4E4',
      },
      fontFamily: { sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'] },
      borderRadius: { DEFAULT: '6px' },
    },
  },
  plugins: [],
};
