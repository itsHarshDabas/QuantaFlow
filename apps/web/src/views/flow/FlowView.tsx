import "@xyflow/react/dist/base.css";
import type { JobView } from "@quantaflow/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { Button, cx, Empty, Lamp, StateTag } from "../../components/ui";
import { harnessLabel, useAgentMap, useHarnessMap } from "../../lib/hooks";
import { openJob } from "../../lib/router";
import { isLive, jobTone, needsYou, TONE_VAR } from "../../lib/states";
import { useQf } from "../../store/store";
import { useChrome } from "../../store/ui";
import { AGENT_NODE, buildFlowGraph, JOB_NODE } from "./graph";

type JobNodeData = { view: JobView; agentName: string; harness: string; selected: boolean };
type AgentNodeData = { name: string; harness: string; jobs: number };
type JobNodeType = Node<JobNodeData, "job">;
type AgentNodeType = Node<AgentNodeData, "agent">;

const hidden = "!h-2 !w-2 !min-w-0 !border-0 !bg-transparent";

function JobNode({ data }: NodeProps<JobNodeType>) {
  const { view, agentName, harness, selected } = data;
  const tone = jobTone(view);
  return (
    <div
      className={cx(
        "relative flex h-full flex-col justify-between overflow-hidden rounded-sm border bg-surface py-2 pr-3 pl-4 text-left",
        selected ? "border-ink" : needsYou(view) ? "border-amber" : "border-line",
        !isLive(view.job.status) && "opacity-75",
      )}
      style={{ width: JOB_NODE.width, height: JOB_NODE.height }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: TONE_VAR[tone] }}
        aria-hidden
      />
      <Handle type="target" position={Position.Left} className={hidden} isConnectable={false} />
      <p className="line-clamp-2 text-[13px] leading-snug font-semibold text-ink">
        {view.job.title}
      </p>
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted">
        <StateTag view={view} />
        <span className="truncate">
          {view.job.role === "orchestrator" ? "Orchestrator, " : ""}
          {agentName} on {harness}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  );
}

function AgentNode({ data }: NodeProps<AgentNodeType>) {
  return (
    <div
      className="flex flex-col justify-center rounded-md border border-dashed border-line-strong bg-canvas px-3"
      style={{ width: AGENT_NODE.width, height: AGENT_NODE.height }}
    >
      <p className="truncate text-[13px] font-semibold text-ink">{data.name}</p>
      <p className="truncate text-[11px] text-ink-muted">
        {data.harness}, {data.jobs} {data.jobs === 1 ? "job" : "jobs"}
      </p>
      <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { job: JobNode, agent: AgentNode };

function FitOnChange({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void signature;
    const frame = requestAnimationFrame(
      () => void fitView({ padding: 0.08, maxZoom: 1.1, duration: 250 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitView, signature]);
  return null;
}

function Graph({ selectedJob }: { selectedJob: string | null }) {
  const jobsById = useQf((s) => s.jobs);
  const agents = useAgentMap();
  const harnesses = useHarnessMap();
  const [hideFinished, setHideFinished] = useState(false);

  const views = useMemo(() => {
    const all = Object.values(jobsById);
    if (!hideFinished) return all;
    // Keep finished jobs that live jobs still point at, so the graph doesn't break apart.
    const needed = new Set<string>();
    for (const v of all) {
      if (!isLive(v.job.status)) continue;
      for (const dep of v.job.dependsOn) needed.add(dep);
      if (v.job.parentJobId) needed.add(v.job.parentJobId);
    }
    return all.filter((v) => isLive(v.job.status) || needed.has(v.job.id));
  }, [jobsById, hideFinished]);

  const { nodes, edges } = useMemo(() => {
    const graph = buildFlowGraph(views, agents);
    const nodes: (JobNodeType | AgentNodeType)[] = graph.nodes.map((spec) =>
      spec.kind === "job"
        ? {
            id: spec.id,
            type: "job",
            position: { x: spec.x, y: spec.y },
            data: {
              view: spec.view,
              agentName: agents.get(spec.view.job.agentId)?.name ?? spec.view.job.agentId,
              harness: harnessLabel(harnesses, spec.view.job.harness),
              selected: spec.id === selectedJob,
            },
            draggable: false,
          }
        : {
            id: spec.id,
            type: "agent",
            position: { x: spec.x, y: spec.y },
            data: {
              name: spec.agent?.name ?? spec.agentId,
              harness: spec.agent ? harnessLabel(harnesses, spec.agent.harness) : "",
              jobs: spec.jobs,
            },
            draggable: false,
            selectable: false,
          },
    );
    const edges: Edge[] = graph.edges.map((spec) => {
      const target = jobsById[spec.target];
      const urgent = target ? needsYou(target) : false;
      const running = target?.job.status === "working" || target?.job.status === "starting";
      const color = urgent
        ? "var(--amber)"
        : running
          ? "var(--run)"
          : spec.kind === "assigned"
            ? "var(--line-strong)"
            : "var(--ink-faint)";
      return {
        id: spec.id,
        source: spec.source,
        target: spec.target,
        type: "smoothstep",
        style: {
          stroke: color,
          strokeWidth: urgent || running ? 2 : 1.25,
          strokeDasharray: spec.kind === "after" ? "5 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        ...(spec.kind === "after"
          ? {
              label: "then",
              labelStyle: { fill: "var(--ink-muted)", fontSize: 11 },
              labelBgStyle: { fill: "var(--canvas)" },
            }
          : {}),
      };
    });
    return { nodes, edges };
  }, [views, agents, harnesses, selectedJob, jobsById]);

  const signature = `${nodes.length}:${edges.length}:${hideFinished}`;

  return (
    <div className="relative h-full">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-4 rounded-md bg-canvas/90 py-1 pr-2 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--ink-faint)" strokeWidth="1.5" />
          </svg>
          started
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true">
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke="var(--ink-faint)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          </svg>
          runs after
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--run)" strokeWidth="2" />
          </svg>
          working
        </span>
        <span className="flex items-center gap-1.5">
          <Lamp tone="amber" size={7} />
          needs you
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="accent-ink"
            checked={hideFinished}
            onChange={(e) => setHideFinished(e.target.checked)}
          />
          Hide finished
        </label>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === "job") openJob(node.id);
        }}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.2}
        maxZoom={1.6}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
        className="qf-flow"
      >
        <FitOnChange signature={signature} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--line)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}

export default function FlowView({ selectedJob }: { selectedJob: string | null }) {
  const count = useQf((s) => Object.keys(s.jobs).length);
  const openNewJob = useChrome((s) => s.openNewJob);
  if (count === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          title="No jobs to draw"
          action={
            <Button variant="primary" onClick={() => openNewJob()}>
              Start a job
            </Button>
          }
        >
          Flow draws how jobs connect: which agent runs each one, which jobs an orchestrator
          started, and which jobs wait for others.
        </Empty>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Graph selectedJob={selectedJob} />
    </ReactFlowProvider>
  );
}
