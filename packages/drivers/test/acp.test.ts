import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAcpSession } from "../src/acp.js";
import { HarnessRegistry } from "../src/registry.js";
import type { DriverEvent, DriverSession, PermissionAsk } from "../src/types.js";

const fake = new HarnessRegistry({ fake: { env: { QF_FAKE_DELAY_MS: "0" } } }).get("fake");
if (!fake) throw new Error("fake harness missing");

let cwd: string;
let session: DriverSession | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "qf-drivers-"));
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(cwd, { recursive: true, force: true });
});

describe("ACP driver against the demo agent", () => {
  it("streams normalized events and routes permission requests", async () => {
    const events: DriverEvent[] = [];
    const asks: PermissionAsk[] = [];
    session = await startAcpSession({
      spec: fake,
      cwd,
      onEvent: (e) => events.push(e),
      onPermission: async (ask) => {
        asks.push(ask);
        const allow = ask.options.find((o) => o.kind === "allow_once");
        return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
      },
    });
    expect(session.agentName).toBe("QuantaFlow demo agent");

    const { stopReason } = await session.prompt("Write a summary and run the tests");
    expect(stopReason).toBe("end_turn");

    expect(asks.map((a) => a.kind)).toEqual(["read", "edit", "execute"]);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["message", "plan", "tool.call", "tool.update", "usage"])
      expect(types).toContain(t);

    const edit = events.find((e) => e.type === "tool.call" && e.kind === "edit");
    expect(edit).toMatchObject({ title: "Write QUANTAFLOW_DEMO.md", diffs: [{ oldText: null }] });
    const written = await readFile(path.join(cwd, "QUANTAFLOW_DEMO.md"), "utf8");
    expect(written).toContain("Written by the scripted demo agent");
  });

  it("skips the edit when permission is denied", async () => {
    session = await startAcpSession({
      spec: fake,
      cwd,
      onEvent: () => undefined,
      onPermission: async (ask) => {
        const option = ask.options.find((o) =>
          ask.kind === "read" ? o.kind === "allow_once" : o.kind === "reject_once",
        );
        return option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" };
      },
    });
    await session.prompt("Write a summary");
    await expect(readFile(path.join(cwd, "QUANTAFLOW_DEMO.md"), "utf8")).rejects.toThrow();
  });

  it("ends the turn as cancelled when cancelled during a permission prompt", async () => {
    let cancelled = false;
    session = await startAcpSession({
      spec: fake,
      cwd,
      onEvent: () => undefined,
      onPermission: (ask, signal) => {
        if (ask.kind === "read") {
          const allow = ask.options.find((o) => o.kind === "allow_once");
          return Promise.resolve({ outcome: "selected", optionId: allow?.optionId ?? "" });
        }
        void session?.cancel();
        return new Promise((resolve) => {
          const done = () => {
            cancelled = true;
            resolve({ outcome: "cancelled" });
          };
          if (signal.aborted) done();
          else signal.addEventListener("abort", done);
        });
      },
    });
    const { stopReason } = await session.prompt("Write a summary");
    expect(stopReason).toBe("cancelled");
    expect(cancelled).toBe(true);
  });

  it("reports a turn error from the agent", async () => {
    session = await startAcpSession({
      spec: fake,
      cwd,
      onEvent: () => undefined,
      onPermission: async (ask) => ({
        outcome: "selected",
        optionId: ask.options[0]?.optionId ?? "",
      }),
    });
    await expect(session.prompt("please fail")).rejects.toThrow(/Simulated failure/);
  });

  it("explains a missing harness binary", async () => {
    await expect(
      startAcpSession({
        spec: { ...fake, label: "Nope", command: "qf-definitely-not-installed", args: [] },
        cwd,
        onEvent: () => undefined,
        onPermission: async () => ({ outcome: "cancelled" }),
      }),
    ).rejects.toMatchObject({ kind: "not_installed" });
  });
});
