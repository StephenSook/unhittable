// The same instrument palette as the web page, so the two read as one system.
export const T = {
  void: '#08090a', surface: '#0e1013', raised: '#14171b', line: '#1f242a',
  ink: '#eceef1', ink2: '#a8b0b8', dim: '#a0a8b0',
  alarm: '#ff4a1c', alarmInk: '#1a0600', pass: '#5bd6a0', warn: '#ff8a3c',
  mono: process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace',
};

/** A device-independent pixel is 1/160 inch by definition on Android, and
 *  close enough on iOS that it is the standard nominal conversion. It is only
 *  NOMINAL though, which is why the app offers a physical calibration. */
export const MM_PER_DP_NOMINAL = 25.4 / 160;

/** WCAG 2.2 SC 2.5.8 is written in CSS pixels, which are 1/96 inch. */
export const WCAG_MIN_CSS_PX = 24;
export const WCAG_ENHANCED_CSS_PX = 44;
export const MM_PER_CSS_PX = 25.4 / 96;
export const WCAG_MIN_MM = WCAG_MIN_CSS_PX * MM_PER_CSS_PX;        // 6.35 mm
export const WCAG_ENHANCED_MM = WCAG_ENHANCED_CSS_PX * MM_PER_CSS_PX;
