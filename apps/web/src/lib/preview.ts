/**
 * Turns a tool's raw input into something a person can judge at a glance.
 * Harnesses shape their inputs differently, so this looks for the common keys.
 */
export type InputPreview =
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "file"; path: string; detail?: string }
  | { kind: "url"; url: string }
  | { kind: "json"; text: string }
  | { kind: "none" };

const COMMAND_KEYS = ["command", "cmd", "script"];
const PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "notebook_path", "target"];
const CONTENT_KEYS = ["new_string", "content", "newText", "new_text", "patch", "diff"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function shellJoin(parts: unknown[]): string {
  return parts
    .map(String)
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/** Codex wraps commands as ["bash", "-lc", "the command"]; show just the command. */
function unwrapShell(parts: unknown[]): string {
  if (
    parts.length === 3 &&
    typeof parts[2] === "string" &&
    /^(ba|z)?sh$/.test(String(parts[0]).split("/").pop() ?? "") &&
    /^-l?c$/.test(String(parts[1]))
  ) {
    return parts[2];
  }
  return shellJoin(parts);
}

export function previewInput(input: unknown): InputPreview {
  if (input === undefined || input === null) return { kind: "none" };
  if (typeof input === "string")
    return input.trim() ? { kind: "json", text: input } : { kind: "none" };

  const record = asRecord(input);
  if (!record) return { kind: "json", text: JSON.stringify(input, null, 2) };

  for (const key of COMMAND_KEYS) {
    const value = record[key];
    const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
    if (typeof value === "string" && value.trim()) {
      return { kind: "command", command: value, ...(cwd ? { cwd } : {}) };
    }
    if (Array.isArray(value) && value.length > 0) {
      return { kind: "command", command: unwrapShell(value), ...(cwd ? { cwd } : {}) };
    }
  }

  const path = firstString(record, PATH_KEYS);
  if (path) {
    const detail = firstString(record, CONTENT_KEYS);
    return { kind: "file", path, ...(detail ? { detail } : {}) };
  }

  const url = firstString(record, ["url", "uri"]);
  if (url) return { kind: "url", url };

  const text = JSON.stringify(record, null, 2);
  return text === "{}" ? { kind: "none" } : { kind: "json", text };
}

/** Caps long previews so one huge patch can't push the queue off screen. */
export function clip(
  text: string,
  maxLines = 12,
  maxChars = 1200,
): { text: string; clipped: boolean } {
  let out = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = out.split("\n");
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join("\n");
  return { text: out, clipped: out.length < text.length };
}
