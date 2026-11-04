import type { DatabaseSync } from "node:sqlite";

type DatabaseSyncCtor = typeof DatabaseSync;
let cached: DatabaseSyncCtor | undefined;

/**
 * Loads Node's built-in SQLite without its "experimental" warning, which would
 * otherwise print on every start. Using the built-in module means no native
 * dependency to compile on install.
 */
export async function loadSqlite(): Promise<DatabaseSyncCtor> {
  if (cached) return cached;
  const original = process.emitWarning;
  process.emitWarning = function filtered(
    this: unknown,
    warning: string | Error,
    ...rest: unknown[]
  ) {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite")) return;
    return Reflect.apply(original, process, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    const mod = await import("node:sqlite");
    cached = mod.DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}
