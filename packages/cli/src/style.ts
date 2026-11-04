/** Minimal ANSI styling. Every function is the identity when color is off. */
export interface Style {
  enabled: boolean;
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  /** Amber: "your turn". Used only for things that wait on the person. */
  amber: (text: string) => string;
  blue: (text: string) => string;
  cyan: (text: string) => string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;
const plain = (text: string) => text;

export function makeStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      enabled,
      bold: plain,
      dim: plain,
      red: plain,
      green: plain,
      amber: plain,
      blue: plain,
      cyan: plain,
    };
  }
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    amber: wrap(33, 39),
    blue: wrap(34, 39),
    cyan: wrap(36, 39),
  };
}

/** Whether to color output, following NO_COLOR and FORCE_COLOR conventions. */
export function wantsColor(isTty: boolean, env: NodeJS.ProcessEnv, flag: boolean): boolean {
  if (flag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTty && env.TERM !== "dumb";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}
