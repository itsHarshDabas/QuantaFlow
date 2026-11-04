import { EventEmitter } from "node:events";
import { AgentProfile, AgentProfileInput } from "@quantaflow/core";
import { badRequest, conflict, notFound } from "./errors.js";
import type { Store } from "./store.js";

/** Agents from `.quantaflow/agents` files (read-only) plus agents saved through the API. */
export class AgentDirectory extends EventEmitter<{ changed: [AgentProfile[]] }> {
  private readonly fileAgents = new Map<string, AgentProfile>();

  constructor(
    private readonly store: Store,
    fileAgents: AgentProfile[],
  ) {
    super();
    for (const agent of fileAgents) this.fileAgents.set(agent.id, agent);
  }

  list(): AgentProfile[] {
    const merged = new Map<string, AgentProfile>();
    for (const agent of this.store.listAgents()) merged.set(agent.id, agent);
    for (const agent of this.fileAgents.values()) merged.set(agent.id, agent);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): AgentProfile | null {
    return this.fileAgents.get(id) ?? this.store.getAgent(id);
  }

  create(input: unknown, knownHarness: (id: string) => boolean): AgentProfile {
    const agent = this.parse(input, knownHarness);
    if (this.get(agent.id)) throw conflict(`An agent with id "${agent.id}" already exists`);
    this.store.saveAgent(agent);
    this.emit("changed", this.list());
    return agent;
  }

  update(id: string, input: unknown, knownHarness: (id: string) => boolean): AgentProfile {
    if (this.fileAgents.has(id)) {
      throw conflict(
        `Agent "${id}" is defined in a file under .quantaflow/agents. Edit that file instead.`,
      );
    }
    if (!this.store.getAgent(id)) throw notFound(`Agent "${id}"`);
    const agent = this.parse({ ...(input as object), id }, knownHarness);
    this.store.saveAgent(agent);
    this.emit("changed", this.list());
    return agent;
  }

  delete(id: string): void {
    if (this.fileAgents.has(id)) {
      throw conflict(
        `Agent "${id}" is defined in a file under .quantaflow/agents. Delete that file instead.`,
      );
    }
    if (!this.store.deleteAgent(id)) throw notFound(`Agent "${id}"`);
    this.emit("changed", this.list());
  }

  private parse(input: unknown, knownHarness: (id: string) => boolean): AgentProfile {
    const parsed = AgentProfileInput.safeParse(input);
    if (!parsed.success) throw badRequest("Invalid agent", parsed.error.issues);
    if (!knownHarness(parsed.data.harness)) {
      throw badRequest(`Unknown harness "${parsed.data.harness}"`);
    }
    return AgentProfile.parse({ ...parsed.data, source: "db" });
  }
}
