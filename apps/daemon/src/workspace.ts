import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffResult, Job, WorkspaceMode } from "@quantaflow/core";

const exec = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const PORTS_PER_JOB = 10;
const PORT_SLOTS = 500;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface PreparedWorkspace {
  mode: WorkspaceMode;
  path: string;
  branch: string | null;
  baseRef: string | null;
  portBase: number;
  /** Set when the requested mode was not possible and another one was used. */
  fallbackReason?: string;
}

/** Gives each job a place to work: a git worktree, a fresh folder, or the project root. */
export class WorkspaceManager {
  private readonly portsInUse = new Set<number>();
  private nextSlot = 0;

  constructor(
    private readonly root: string,
    private readonly stateDir: string,
    private readonly portRangeStart: number,
  ) {}

  allocatePorts(): number {
    for (let i = 0; i < PORT_SLOTS; i += 1) {
      const slot = (this.nextSlot + i) % PORT_SLOTS;
      const base = this.portRangeStart + slot * PORTS_PER_JOB;
      if (!this.portsInUse.has(base)) {
        this.portsInUse.add(base);
        this.nextSlot = slot + 1;
        return base;
      }
    }
    throw new Error("No free port ranges left for new jobs");
  }

  reservePorts(base: number): void {
    this.portsInUse.add(base);
  }

  releasePorts(base: number | null): void {
    if (base !== null) this.portsInUse.delete(base);
  }

  private async gitHead(): Promise<string | null> {
    try {
      const inside = (await git(this.root, ["rev-parse", "--is-inside-work-tree"])).trim();
      if (inside !== "true") return null;
      return (await git(this.root, ["rev-parse", "HEAD"])).trim();
    } catch {
      return null;
    }
  }

  async prepare(jobId: string, mode: WorkspaceMode): Promise<PreparedWorkspace> {
    const portBase = this.allocatePorts();
    try {
      if (mode === "cwd") {
        return { mode, path: this.root, branch: null, baseRef: await this.gitHead(), portBase };
      }
      if (mode === "worktree") {
        const head = await this.gitHead();
        if (head) {
          const dir = path.join(this.stateDir, "worktrees", jobId);
          const branch = `qf/${jobId}`;
          await mkdir(path.dirname(dir), { recursive: true });
          await git(this.root, ["worktree", "add", "-b", branch, dir, head]);
          return { mode, path: dir, branch, baseRef: head, portBase };
        }
      }
      const dir = path.join(this.stateDir, "workspaces", jobId);
      await mkdir(dir, { recursive: true });
      return {
        mode: "folder",
        path: dir,
        branch: null,
        baseRef: null,
        portBase,
        ...(mode === "worktree"
          ? {
              fallbackReason:
                "This project is not a git repository with at least one commit, so the job runs in a fresh folder instead of a worktree.",
            }
          : {}),
      };
    } catch (error) {
      this.releasePorts(portBase);
      throw error;
    }
  }

  /** The job's changes against the commit it started from, including new files. */
  async diff(job: Job): Promise<DiffResult> {
    if (!job.workspacePath || !existsSync(job.workspacePath)) {
      return { available: false, diff: "", reason: "This job has no workspace yet." };
    }
    if (job.workspace === "folder") {
      return {
        available: false,
        diff: "",
        reason: `Folder jobs are not tracked by git. Their files are in ${job.workspacePath}.`,
      };
    }
    if (!job.baseRef) {
      return { available: false, diff: "", reason: "This workspace is not a git repository." };
    }
    try {
      let note = "";
      if (job.workspace === "worktree") {
        // QuantaFlow owns this worktree, so it can mark new files to include them in the diff.
        await git(job.workspacePath, ["add", "--intent-to-add", "--all"]);
      } else {
        // Never touch the index of the user's own checkout. List new files instead.
        const untracked = (
          await git(job.workspacePath, ["ls-files", "--others", "--exclude-standard"])
        )
          .split("\n")
          .filter(Boolean);
        if (untracked.length > 0) {
          note = `\n# New files not shown above:\n${untracked.map((f) => `#   ${f}`).join("\n")}\n`;
        }
      }
      const diff = (await git(job.workspacePath, ["diff", "--no-color", job.baseRef])) + note;
      if (diff.length > MAX_DIFF_BYTES) {
        return {
          available: true,
          diff: `${diff.slice(0, MAX_DIFF_BYTES)}\n… diff truncated at 2 MB`,
        };
      }
      return { available: true, diff };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, diff: "", reason: `git diff failed: ${message}` };
    }
  }
}
