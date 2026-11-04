import type { Policy, PolicyAction, PolicyPreset, ToolKind } from "./schemas.js";

export interface PermissionAskInfo {
  kind: ToolKind;
  title: string;
  input?: unknown;
}

export interface PolicyVerdict {
  action: PolicyAction;
  reason: string;
}

/**
 * Commands no preset or rule can allow. They are checked first and always denied,
 * because a single mistake here is not recoverable.
 */
export const HARD_DENY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\/\*)(\s|$|["'`;&|)])/i,
    reason: "recursive delete of the root or home directory",
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i,
    reason: "force push",
  },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "formatting a filesystem" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "writing directly to a device" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  {
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    reason: "piping a download into a shell",
  },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/i, reason: "opening up permissions on /" },
];

const PRESET_DEFAULTS: Record<PolicyPreset, Record<ToolKind, PolicyAction>> = {
  readonly: {
    read: "allow",
    search: "allow",
    think: "allow",
    fetch: "allow",
    switch_mode: "deny",
    edit: "deny",
    delete: "deny",
    move: "deny",
    execute: "deny",
    other: "deny",
  },
  safe: {
    read: "allow",
    search: "allow",
    think: "allow",
    fetch: "ask",
    switch_mode: "ask",
    edit: "ask",
    delete: "ask",
    move: "ask",
    execute: "ask",
    other: "ask",
  },
  trusted: {
    read: "allow",
    search: "allow",
    think: "allow",
    fetch: "allow",
    switch_mode: "allow",
    edit: "allow",
    move: "allow",
    execute: "allow",
    delete: "ask",
    other: "ask",
  },
};

export const PRESET_DESCRIPTIONS: Record<PolicyPreset, string> = {
  readonly: "Reads and searches only. Edits, deletes and commands are denied.",
  safe: "Reads run freely. Edits, commands, deletes and web fetches ask you first.",
  trusted: "Everything runs except deletes, which ask you. Built-in safety rules still apply.",
};

function subjectOf(ask: PermissionAskInfo): string {
  let input = "";
  if (ask.input !== undefined) {
    try {
      input = typeof ask.input === "string" ? ask.input : JSON.stringify(ask.input);
    } catch {
      input = "";
    }
  }
  return `${ask.title}\n${input}`;
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** Decides what happens to a permission request before a person sees it. */
export function evaluatePolicy(policy: Policy, ask: PermissionAskInfo): PolicyVerdict {
  const subject = subjectOf(ask);

  for (const { pattern, reason } of HARD_DENY_PATTERNS) {
    if (pattern.test(subject)) {
      return { action: "deny", reason: `Blocked by a built-in safety rule: ${reason}` };
    }
  }

  for (const [index, rule] of policy.rules.entries()) {
    if (rule.kinds && rule.kinds.length > 0 && !rule.kinds.includes(ask.kind)) continue;
    if (rule.pattern !== undefined) {
      const re = safeRegex(rule.pattern);
      if (!re?.test(subject)) continue;
    }
    const label = rule.note ? `"${rule.note}"` : `#${index + 1}`;
    return { action: rule.action, reason: `Matched policy rule ${label}` };
  }

  const action = PRESET_DEFAULTS[policy.preset][ask.kind];
  return { action, reason: `${policy.preset} preset: ${ask.kind} is ${action}` };
}
