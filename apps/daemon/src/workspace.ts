import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffResult, Job, MergeResult, MergeStrategy, WorkspaceMode } from "@quantaflow/core";
import { badRequest, conflict } from "./errors.js";

const exec = promisify(execFile);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const PORTS_PER_JOB = 10;
const PORT_SLOTS = 500;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout;
}

/** Runs git and reports failure instead of throwing. */
function tryGit(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return tryGitWith(cwd, args, undefined);
}

async function tryGitWith(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args, env) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? e.message ?? ""}` };
  }
}

/** Fallback identity, so committing an agent's work never fails on a machine without one. */
async function commitIdentity(cwd: string): Promise<NodeJS.ProcessEnv | undefined> {
  const email = await tryGit(cwd, ["config", "user.email"]);
  if (email.ok && email.out.trim()) return undefined;
  return {
    GIT_AUTHOR_NAME: "QuantaFlow",
    GIT_AUTHOR_EMAIL: "quantaflow@localhost",
    GIT_COMMITTER_NAME: "QuantaFlow",
    GIT_COMMITTER_EMAIL: "quantaflow@localhost",
  };
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
  /** Merges touch the project root's index, so they run one at a time. */
  private mergeLock: Promise<unknown> = Promise.resolve();

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

  /**
   * Merges a worktree job into the branch checked out in the project root. The agent's
   * uncommitted work is committed on the job branch first. A conflicting merge is aborted, so
   * the root is never left half-merged.
   */
  merge(job: Job, strategy: MergeStrategy, message?: string): Promise<MergeResult> {
    const run = this.mergeLock.then(() => this.mergeNow(job, strategy, message));
    this.mergeLock = run.catch(() => undefined);
    return run;
  }

  private async mergeNow(
    job: Job,
    strategy: MergeStrategy,
    message?: string,
  ): Promise<MergeResult> {
    if (job.workspace !== "worktree" || !job.branch || !job.workspacePath) {
      throw badRequest("Only worktree jobs can be merged.");
    }
    if (!existsSync(job.workspacePath)) throw conflict("The job's worktree no longer exists.");

    const head = await tryGit(this.root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const into = head.out.trim();
    if (!head.ok || !into) {
      throw conflict(
        "The project is on a detached HEAD. Check out the branch to merge into first.",
      );
    }
    if (into === job.branch) throw conflict(`The project root has ${into} checked out.`);
    // No trim: porcelain lines start with a status column that may be a space.
    const dirty = (await git(this.root, ["status", "--porcelain", "--untracked-files=no"]))
      .split("\n")
      .filter(Boolean);
    if (dirty.length > 0) {
      throw conflict("The project has uncommitted changes. Commit or stash them, then merge.", {
        reason: "dirty",
        files: dirty.map((line) => line.slice(3)),
      });
    }

    // Commit what the agent left in its worktree. `diff` may have marked new files intent-to-add.
    const title = job.title.replace(/\s+/g, " ").trim().slice(0, 72) || job.id;
    const identity = await commitIdentity(job.workspacePath);
    await git(job.workspacePath, ["add", "--all"]);
    const staged = await tryGit(job.workspacePath, ["diff", "--cached", "--quiet"]);
    if (!staged.ok) {
      await git(
        job.workspacePath,
        ["commit", "--no-verify", "-q", "-m", `${title}\n\nWork from QuantaFlow job ${job.id}.`],
        identity,
      );
    }

    const ahead = Number(
      (await git(this.root, ["rev-list", "--count", `${into}..${job.branch}`])).trim(),
    );
    if (!ahead)
      throw conflict(`There is nothing to merge: ${job.branch} has no changes beyond ${into}.`, {
        reason: "empty",
      });

    const text = message ?? `Merge QuantaFlow job ${job.id}: ${title}`;
    const rootIdentity = await commitIdentity(this.root);
    const merged =
      strategy === "squash"
        ? await tryGit(this.root, ["merge", "--squash", job.branch])
        : await tryGitWith(
            this.root,
            ["merge", "--no-ff", "--no-edit", "-m", text, job.branch],
            rootIdentity,
          );
    if (!merged.ok) {
      const conflicts = (await tryGit(this.root, ["diff", "--name-only", "--diff-filter=U"])).out
        .split("\n")
        .filter(Boolean);
      await tryGit(this.root, strategy === "squash" ? ["reset", "--merge"] : ["merge", "--abort"]);
      throw conflict(
        conflicts.length
          ? `Merging ${job.branch} into ${into} conflicts in ${conflicts.length} file(s). Nothing was changed.`
          : `git could not merge ${job.branch} into ${into}: ${merged.out.trim().split("\n").at(-1) ?? ""}`,
        { reason: "conflict", conflicts },
      );
    }
    if (strategy === "squash") {
      await git(this.root, ["commit", "--no-verify", "-q", "-m", text], rootIdentity);
    }
    const commit = (await git(this.root, ["rev-parse", "HEAD"])).trim();
    return { commit, into, strategy };
  }

  /** Removes a job's worktree and branch, or its folder. Never touches the project root. */
  async discard(job: Job): Promise<void> {
    if (job.workspace === "cwd")
      throw badRequest("cwd jobs work in the project itself; there is nothing to discard.");
    if (job.workspace === "worktree" && job.branch) {
      if (job.workspacePath && existsSync(job.workspacePath)) {
        const removed = await tryGit(this.root, [
          "worktree",
          "remove",
          "--force",
          job.workspacePath,
        ]);
        if (!removed.ok) await rm(job.workspacePath, { recursive: true, force: true });
      }
      await tryGit(this.root, ["worktree", "prune"]);
      await tryGit(this.root, ["branch", "-D", job.branch]);
      return;
    }
    if (job.workspacePath) {
      const inside = path.relative(path.join(this.stateDir, "workspaces"), job.workspacePath);
      if (inside.startsWith("..") || path.isAbsolute(inside) || inside === "") {
        throw badRequest("Refusing to delete a folder outside QuantaFlow's workspaces.");
      }
      await rm(job.workspacePath, { recursive: true, force: true });
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
