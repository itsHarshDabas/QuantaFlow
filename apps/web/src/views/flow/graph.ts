import dagre from "@dagrejs/dagre";
import type { AgentProfile, JobView } from "@quantaflow/core";

export const JOB_NODE = { width: 248, height: 74 };
export const AGENT_NODE = { width: 170, height: 52 };

export type FlowNodeSpec =
  | {
      id: string;
      kind: "agent";
      agent: AgentProfile | null;
      agentId: string;
      jobs: number;
      x: number;
      y: number;
    }
  | { id: string; kind: "job"; view: JobView; x: number; y: number };

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  kind: "assigned" | "spawned" | "after";
}

export const agentNodeId = (agentId: string) => `agent:${agentId}`;

/**
 * The job graph: an orchestrator points to the jobs it started, a job points to the jobs that wait
 * for it, and jobs nobody started hang off the agent that runs them. Laid out left to right.
 */
export function buildFlowGraph(
  views: readonly JobView[],
  agents: ReadonlyMap<string, AgentProfile>,
): { nodes: FlowNodeSpec[]; edges: FlowEdgeSpec[] } {
  const present = new Set(views.map((v) => v.job.id));
  const edges: FlowEdgeSpec[] = [];
  const rootsByAgent = new Map<string, number>();

  for (const view of views) {
    const { job } = view;
    const hasParent = job.parentJobId !== null && present.has(job.parentJobId);
    const deps = job.dependsOn.filter((id) => present.has(id));
    if (hasParent && deps.length === 0) {
      edges.push({
        id: `s:${job.parentJobId}>${job.id}`,
        source: job.parentJobId as string,
        target: job.id,
        kind: "spawned",
      });
    }
    for (const dep of deps) {
      edges.push({ id: `d:${dep}>${job.id}`, source: dep, target: job.id, kind: "after" });
    }
    if (!hasParent && deps.length === 0) {
      rootsByAgent.set(job.agentId, (rootsByAgent.get(job.agentId) ?? 0) + 1);
      edges.push({
        id: `a:${job.agentId}>${job.id}`,
        source: agentNodeId(job.agentId),
        target: job.id,
        kind: "assigned",
      });
    }
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 64, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const [agentId] of rootsByAgent) graph.setNode(agentNodeId(agentId), { ...AGENT_NODE });
  for (const view of views) graph.setNode(view.job.id, { ...JOB_NODE });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const nodes: FlowNodeSpec[] = [];
  for (const [agentId, count] of rootsByAgent) {
    const id = agentNodeId(agentId);
    const point = graph.node(id) as { x: number; y: number };
    nodes.push({
      id,
      kind: "agent",
      agent: agents.get(agentId) ?? null,
      agentId,
      jobs: count,
      x: point.x - AGENT_NODE.width / 2,
      y: point.y - AGENT_NODE.height / 2,
    });
  }
  for (const view of views) {
    const point = graph.node(view.job.id) as { x: number; y: number };
    nodes.push({
      id: view.job.id,
      kind: "job",
      view,
      x: point.x - JOB_NODE.width / 2,
      y: point.y - JOB_NODE.height / 2,
    });
  }
  return { nodes, edges };
}
