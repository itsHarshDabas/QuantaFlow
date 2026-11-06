import { useLayoutEffect, useMemo, useRef } from "react";
import { Button, Empty } from "../../components/ui";
import { harnessLabel, useAgentMap, useHarnessMap } from "../../lib/hooks";
import { routeUrl } from "../../lib/route";
import { openJob } from "../../lib/router";
import { jobTone, TONE_VAR } from "../../lib/states";
import { useQf } from "../../store/store";
import { useChrome } from "../../store/ui";
import { layoutOrbit, type OrbitNode, RINGS } from "./layout";

const RADII = [128, 222, 300, 372] as const;
const SIZE = 940;
const CENTER_R = 62;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function polar(radius: number, angle: number): [number, number] {
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function Node({ node, selected }: { node: OrbitNode; selected: boolean }) {
  const { view, ring, angle } = node;
  const tone = jobTone(view);
  const color = TONE_VAR[tone];
  const orchestrator = view.job.role === "orchestrator";
  const size = ring === 0 ? 20 : ring === 3 ? 12 : orchestrator ? 15 : 16;
  const showLabel = ring <= 1 || selected;
  // Labels sit outside the node, on the side facing away from the center.
  const right = Math.cos(angle) >= -0.01;
  const labelX = (right ? 1 : -1) * (size / 2 + 8);
  const href = routeUrl({ view: "orbit", job: view.job.id }, location.search);

  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openJob(view.job.id);
      }}
      aria-label={`${view.job.title}${orchestrator ? ", orchestrator" : ""}: ${RINGS[ring].label}`}
      className="group outline-none"
      style={{
        transform: `translate(${node.x}px, ${node.y}px)`,
        transition: "transform 700ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <title>{view.job.title}</title>
      {ring === 0 && (
        <rect
          x={-size / 2}
          y={-size / 2}
          width={size}
          height={size}
          rx={4}
          fill={color}
          className="beacon"
        />
      )}
      {selected && (
        <rect
          x={-size / 2 - 5}
          y={-size / 2 - 5}
          width={size + 10}
          height={size + 10}
          rx={6}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.5}
        />
      )}
      <rect
        x={-size / 2 - 7}
        y={-size / 2 - 7}
        width={size + 14}
        height={size + 14}
        rx={7}
        fill="none"
        stroke="var(--run)"
        strokeWidth={2}
        className="opacity-0 group-focus-visible:opacity-100"
      />
      <rect
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        rx={orchestrator ? 2 : ring === 3 ? 3 : 4}
        fill={ring === 3 ? "var(--surface)" : color}
        stroke={color}
        strokeWidth={ring === 3 ? 1.5 : 0}
        transform={orchestrator ? "rotate(45)" : undefined}
        className="transition-[filter] group-hover:brightness-110"
      />
      <text
        x={labelX}
        y={4}
        textAnchor={right ? "start" : "end"}
        className={
          showLabel
            ? "fill-ink text-[14px] font-semibold"
            : "fill-ink-muted text-[13px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        }
        style={{
          paintOrder: "stroke",
          stroke: "var(--canvas)",
          strokeWidth: 4,
          strokeLinejoin: "round",
        }}
      >
        {truncate(view.job.title, ring === 0 ? 34 : 26)}
      </text>
    </a>
  );
}

export function OrbitView({ selectedJob }: { selectedJob: string | null }) {
  const jobs = useQf((s) => s.jobs);
  const agentList = useQf((s) => s.agents);
  const agents = useAgentMap();
  const harnesses = useHarnessMap();
  const openNewJob = useChrome((s) => s.openNewJob);

  const layout = useMemo(
    () =>
      layoutOrbit(
        Object.values(jobs),
        agentList.map((a) => a.id),
        { radii: RADII, maxFinished: 18, gap: 0.08 },
      ),
    [jobs, agentList],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const empty = Object.keys(jobs).length === 0;
  // On narrow screens the orbit keeps a readable size and scrolls; start centered on "You".
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || empty) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [empty]);

  if (empty) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          title="Nothing in orbit yet"
          action={
            <Button variant="primary" onClick={() => openNewJob()}>
              Start a job
            </Button>
          }
        >
          Orbit puts you at the center and every job around you. The closer a job sits, the sooner
          it needs you.
        </Empty>
      </div>
    );
  }

  const { nodes, sectors, ringCounts, hiddenFinished } = layout;
  const half = SIZE / 2;

  return (
    <div className="relative h-full overflow-hidden">
      <div className="pointer-events-none absolute top-3 left-4 z-10 text-xs">
        <p className="font-semibold text-ink">Closer to the center needs you sooner</p>
        <ol
          className="mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-ink-muted"
          aria-label="Rings, from the center outward"
        >
          {RINGS.map((ring, index) => (
            <li key={ring.id} className="contents">
              <span
                className={
                  index === 0 && ringCounts[0] > 0 ? "font-semibold text-amber-text" : undefined
                }
              >
                {ring.label}
              </span>
              <span className="text-right text-ink-faint tabular">{ringCounts[index]}</span>
            </li>
          ))}
        </ol>
        {hiddenFinished > 0 && (
          <p className="mt-1.5 text-ink-faint">{hiddenFinished} older finished jobs not shown</p>
        )}
      </div>

      <div ref={scroller} className="h-full overflow-auto">
        <svg
          viewBox={`${-half} ${-half} ${SIZE} ${SIZE}`}
          className="h-full min-h-[660px] w-full min-w-[660px]"
          aria-label="Jobs arranged by how soon they need you"
        >
          {RADII.map((r, index) => (
            <circle
              key={r}
              r={r}
              fill="none"
              stroke={index === 0 && ringCounts[0] > 0 ? "var(--amber)" : "var(--line)"}
              strokeOpacity={index === 0 && ringCounts[0] > 0 ? 0.55 : 1}
              strokeWidth={1}
              strokeDasharray={index === 3 ? "2 5" : undefined}
            />
          ))}

          {sectors.length > 1 &&
            sectors.map((sector) => {
              const [x1, y1] = polar(CENTER_R + 16, sector.start - 0.04);
              const [x2, y2] = polar(RADII[3] + 26, sector.start - 0.04);
              return (
                <line
                  key={`spoke-${sector.agentId}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="var(--line)"
                  strokeDasharray="1 6"
                />
              );
            })}

          {sectors.map((sector) => {
            const [x, y] = polar(RADII[3] + 48, sector.mid);
            const anchor =
              Math.abs(Math.cos(sector.mid)) < 0.25
                ? "middle"
                : Math.cos(sector.mid) > 0
                  ? "start"
                  : "end";
            const agent = agents.get(sector.agentId);
            return (
              <text
                key={`label-${sector.agentId}`}
                x={x}
                y={y}
                textAnchor={anchor}
                className="fill-ink-muted text-[15px]"
              >
                <tspan className="fill-ink font-semibold">{agent?.name ?? sector.agentId}</tspan>
                <tspan x={x} dy={17} className="text-[12px]">
                  {agent ? harnessLabel(harnesses, agent.harness) : ""}
                </tspan>
              </text>
            );
          })}

          {/* Lines tie the jobs waiting on you to the center. */}
          {nodes
            .filter((node) => node.ring === 0)
            .map((node) => {
              const [x1, y1] = polar(CENTER_R, node.angle);
              return (
                <line
                  key={`tie-${node.view.job.id}`}
                  x1={x1}
                  y1={y1}
                  x2={node.x}
                  y2={node.y}
                  stroke="var(--amber)"
                  strokeWidth={1.5}
                  strokeOpacity={0.7}
                />
              );
            })}

          <circle r={CENTER_R} fill="var(--surface)" stroke="var(--line-strong)" />
          <text y={-2} textAnchor="middle" className="fill-ink text-[18px] font-semibold">
            You
          </text>
          <text y={19} textAnchor="middle" className="fill-ink-muted text-[12px]">
            {ringCounts[0] > 0 ? `${ringCounts[0]} waiting` : "nothing waiting"}
          </text>

          {nodes.map((node) => (
            <Node key={node.view.job.id} node={node} selected={node.view.job.id === selectedJob} />
          ))}
        </svg>
      </div>
    </div>
  );
}
