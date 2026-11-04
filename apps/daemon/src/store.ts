import type { DatabaseSync } from "node:sqlite";
import { AgentProfile, Job, type QfEvent, type QfEventData } from "@quantaflow/core";
import { loadSqlite } from "./sqlite.js";

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX jobs_created ON jobs(created_at);
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX events_job ON events(job_id, seq);
  `,
};

type Row = Record<string, unknown>;

/** SQLite persistence: agents, jobs and the append-only event log. */
export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(file: string): Promise<Store> {
    const DatabaseSync = await loadSqlite();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const store = new Store(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row | undefined;
    let version = Number(row?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `This QuantaFlow database was created by a newer version (schema ${version}). Upgrade QuantaFlow.`,
      );
    }
    while (version < SCHEMA_VERSION) {
      version += 1;
      const sql = MIGRATIONS[version];
      if (!sql) throw new Error(`Missing migration ${version}`);
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${version}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  listAgents(): AgentProfile[] {
    const rows = this.db.prepare("SELECT data FROM agents ORDER BY id").all() as Row[];
    return rows.map((r) => AgentProfile.parse(JSON.parse(String(r.data))));
  }

  getAgent(id: string): AgentProfile | null {
    const row = this.db.prepare("SELECT data FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? AgentProfile.parse(JSON.parse(String(row.data))) : null;
  }

  saveAgent(agent: AgentProfile): void {
    this.db
      .prepare(
        "INSERT INTO agents (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .run(agent.id, JSON.stringify(agent), Date.now());
  }

  deleteAgent(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes) > 0;
  }

  saveJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, agent_id, status, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(job.id, job.agentId, job.status, job.createdAt, job.updatedAt, JSON.stringify(job));
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? Job.parse(JSON.parse(String(row.data))) : null;
  }

  listJobs(limit = 500): Job[] {
    const rows = this.db
      .prepare("SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => Job.parse(JSON.parse(String(r.data))));
  }

  appendEvent(jobId: string, data: QfEventData, ts = Date.now()): QfEvent {
    const result = this.db
      .prepare("INSERT INTO events (job_id, ts, type, data) VALUES (?, ?, ?, ?)")
      .run(jobId, ts, data.type, JSON.stringify(data));
    return { ...data, seq: Number(result.lastInsertRowid), ts, jobId } as QfEvent;
  }

  eventsForJob(jobId: string, afterSeq = 0, limit = 20_000): QfEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, job_id, ts, data FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(jobId, afterSeq, limit) as Row[];
    return rows.map(
      (r) =>
        ({
          ...(JSON.parse(String(r.data)) as QfEventData),
          seq: Number(r.seq),
          ts: Number(r.ts),
          jobId: String(r.job_id),
        }) as QfEvent,
    );
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as Row | undefined;
    return Number(row?.seq ?? 0);
  }
}
