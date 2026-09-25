export type ThemePref = 'system' | 'light' | 'dark';

export interface ChartTheme {
  dark: boolean;
  text: string;
  muted: string;
  faint: string;
  grid: string;
  panel: string;
  accent: string;
  auto: string;
  teleop: string;
  test: string;
  nocomms: string;
  stall: string;
  brownout: string;
  bad: string;
  warn: string;
  c: Record<'volt' | 'current' | 'trip' | 'loss' | 'cpu' | 'can' | 'wifiDb' | 'wifiMb', string>;
  logColors: string[];
  font: string;
}

export function resolvedDark(pref: ThemePref): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    dark: document.documentElement.dataset.theme === 'dark',
    text: v('--text'),
    muted: v('--muted'),
    faint: v('--faint'),
    grid: v('--grid'),
    panel: v('--panel'),
    accent: v('--accent'),
    auto: v('--auto'),
    teleop: v('--teleop'),
    test: v('--test'),
    nocomms: v('--nocomms'),
    stall: v('--stall'),
    brownout: v('--brownout'),
    bad: v('--bad'),
    warn: v('--warn'),
    c: {
      volt: v('--c-volt'),
      current: v('--c-current'),
      trip: v('--c-trip'),
      loss: v('--c-loss'),
      cpu: v('--c-cpu'),
      can: v('--c-can'),
      wifiDb: v('--c-wifi-db'),
      wifiMb: v('--c-wifi-mb'),
    },
    logColors: [1, 2, 3, 4, 5, 6].map((i) => v(`--c-log${i}`)),
    font: v('--font-sans') || 'system-ui, sans-serif',
  };
}

/** Distinct, theme-aware colors for power distribution channels. */
export function channelColor(ch: number, dark: boolean): string {
  const hue = (ch * 137.508 + 200) % 360;
  return dark ? `hsl(${hue.toFixed(0)} 72% 64%)` : `hsl(${hue.toFixed(0)} 68% 40%)`;
}

/** Adds alpha to a #rrggbb or hsl()/rgb() color. */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  if (color.startsWith('hsl(')) return color.replace(')', ` / ${a})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
  return color;
}
