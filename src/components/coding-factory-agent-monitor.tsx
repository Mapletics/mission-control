"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Hash,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { useSmartPoll } from "@/hooks/use-smart-poll";

/* ── Types ── */

type SessionInfo = {
  key: string;
  sessionId: string;
  kind: string;
  model: string;
  fullModel: string;
  thinkingLevel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens: number;
  updatedAt: number;
  ageMs: number;
  originLabel: string | null;
  abortedLastRun: boolean;
  systemSent: boolean;
};

type AgentDetail = {
  agentId: string;
  status: "active" | "idle";
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastActive: number;
  model: string | null;
  thinkingLevel: string | null;
  sessions: SessionInfo[];
};

type SupervisorInfo = {
  status: string;
  isHealthy: boolean;
  pid: number | null;
  pidAlive: boolean;
  runId: string | null;
  issueKeys: string[];
};

type DetailData = {
  agents: AgentDetail[];
  supervisor: SupervisorInfo;
};

/* ── Formatters ── */

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatAge(epochMs: number): string {
  if (epochMs <= 0) return "—";
  const diffMs = Date.now() - epochMs;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortModel(model: string): string {
  const parts = model.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function sessionKindLabel(kind: string, key: string): { label: string; color: string } {
  if (key.includes(":subagent:")) return { label: "Subagent", color: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" };
  if (key.includes(":cron:")) return { label: "Cron", color: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" };
  if (key.includes(":hook:")) return { label: "Hook", color: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" };
  if (key.includes(":main")) return { label: "Main", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" };
  return { label: kind, color: "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300" };
}

/* ── Agent Card ── */

function AgentCard({ agent }: { agent: AgentDetail }) {
  const [expanded, setExpanded] = useState(agent.status === "active");

  return (
    <div
      className={cn(
        "rounded-xl border",
        agent.status === "active"
          ? "border-emerald-200 dark:border-emerald-500/20"
          : "border-stone-200 dark:border-[#2c343d]",
      )}
    >
      {/* Agent header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            {agent.status === "active" ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </>
            ) : (
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-stone-300 dark:bg-stone-600" />
            )}
          </span>
          <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
            {agent.agentId}
          </span>
          {agent.model && (
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-500 dark:bg-[#20252a] dark:text-[#8d98a5]">
              {shortModel(agent.model)}
            </span>
          )}
          {agent.thinkingLevel && (
            <span className="text-[10px] text-stone-400 dark:text-[#7a8591]">
              thinking: {agent.thinkingLevel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-xs text-stone-500 dark:text-[#8d98a5]">
            <span className="flex items-center gap-1">
              <Activity className="h-3 w-3" /> {agent.sessions.length}
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" /> {formatTokens(agent.totalTokens)}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {formatAge(agent.lastActive)}
            </span>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-stone-400 dark:text-[#7a8591]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-stone-400 dark:text-[#7a8591]" />
          )}
        </div>
      </button>

      {/* Sessions table */}
      {expanded && agent.sessions.length > 0 && (
        <div className="border-t border-stone-100 dark:border-[#23282e]">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_80px_100px_80px_80px_80px_90px] gap-2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-[#7a8591]">
            <span>Session</span>
            <span>Type</span>
            <span>Model</span>
            <span className="text-right">Input</span>
            <span className="text-right">Output</span>
            <span className="text-right">Context</span>
            <span className="text-right">Last Active</span>
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            {agent.sessions.map((session) => {
              const { label, color } = sessionKindLabel(session.kind, session.key);
              const isActive = session.ageMs < 2 * 60 * 1000;

              return (
                <div
                  key={session.key}
                  className={cn(
                    "grid grid-cols-[1fr_80px_100px_80px_80px_80px_90px] gap-2 border-t border-stone-50 px-4 py-2 text-xs dark:border-[#1c2024]",
                    isActive && "bg-emerald-50/30 dark:bg-emerald-500/5",
                    session.abortedLastRun && "bg-red-50/30 dark:bg-red-500/5",
                  )}
                >
                  {/* Session ID */}
                  <div className="flex items-center gap-2 truncate">
                    {isActive && (
                      <span className="flex h-1.5 w-1.5 shrink-0">
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      </span>
                    )}
                    <span className="truncate font-mono text-[11px] text-stone-600 dark:text-[#a8b0ba]">
                      {session.sessionId.length > 16
                        ? `${session.sessionId.slice(0, 8)}…${session.sessionId.slice(-4)}`
                        : session.sessionId}
                    </span>
                    {session.originLabel && (
                      <span className="shrink-0 text-[10px] text-stone-400 dark:text-[#7a8591]">
                        {session.originLabel}
                      </span>
                    )}
                  </div>

                  {/* Type badge */}
                  <div>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", color)}>
                      {label}
                    </span>
                  </div>

                  {/* Model */}
                  <span className="truncate text-stone-500 dark:text-[#8d98a5]">
                    {shortModel(session.model)}
                  </span>

                  {/* Input tokens */}
                  <span className="text-right tabular-nums text-stone-600 dark:text-[#a8b0ba]">
                    {formatTokens(session.inputTokens)}
                  </span>

                  {/* Output tokens */}
                  <span className="text-right tabular-nums text-stone-600 dark:text-[#a8b0ba]">
                    {formatTokens(session.outputTokens)}
                  </span>

                  {/* Context */}
                  <span className="text-right tabular-nums text-stone-500 dark:text-[#8d98a5]">
                    {session.contextTokens > 0 ? formatTokens(session.contextTokens) : "—"}
                  </span>

                  {/* Last active */}
                  <span className="text-right text-stone-500 dark:text-[#8d98a5]">
                    {formatAge(session.updatedAt)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Agent totals */}
          <div className="grid grid-cols-[1fr_80px_100px_80px_80px_80px_90px] gap-2 border-t border-stone-200 px-4 py-2 text-xs font-medium dark:border-[#2c343d]">
            <span className="text-stone-500 dark:text-[#8d98a5]">
              {agent.sessions.length} session{agent.sessions.length !== 1 ? "s" : ""} total
            </span>
            <span />
            <span />
            <span className="text-right tabular-nums text-stone-700 dark:text-[#c5cbd3]">
              {formatTokens(agent.inputTokens)}
            </span>
            <span className="text-right tabular-nums text-stone-700 dark:text-[#c5cbd3]">
              {formatTokens(agent.outputTokens)}
            </span>
            <span />
            <span />
          </div>
        </div>
      )}

      {expanded && agent.sessions.length === 0 && (
        <div className="border-t border-stone-100 px-4 py-4 text-center text-xs text-stone-400 dark:border-[#23282e] dark:text-[#7a8591]">
          No active sessions.
        </div>
      )}
    </div>
  );
}

/* ── Main Component ── */

export function CodingFactoryAgentMonitor() {
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/coding-factory/agents/detail", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { setError(true); return; }
      const envelope = await res.json();
      setData(envelope.ok ? envelope.data : envelope);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useSmartPoll(fetchData, { intervalMs: 8_000 });

  const activeCount = data?.agents.filter((a) => a.status === "active").length ?? 0;
  const totalSessions = data?.agents.reduce((sum, a) => sum + a.sessions.length, 0) ?? 0;
  const totalTokens = data?.agents.reduce((sum, a) => sum + a.totalTokens, 0) ?? 0;

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <div className="flex items-center gap-3">
            <Link
              href="/coding-factory"
              className="flex items-center gap-1 text-sm font-medium text-stone-400 hover:text-stone-600 dark:text-[#7a8591] dark:hover:text-[#a8b0ba]"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <span>Agent Monitor</span>
          </div>
        }
        meta={
          data ? (
            <span className="flex items-center gap-4">
              <span>{data.agents.length} agent{data.agents.length !== 1 ? "s" : ""}</span>
              {activeCount > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">{activeCount} active</span>
              )}
              <span>{totalSessions} sessions</span>
              <span>{formatTokens(totalTokens)} tokens</span>
              {data.supervisor.isHealthy && (
                <span className="flex items-center gap-1">
                  <Cpu className="h-3 w-3" />
                  Supervisor {data.supervisor.status}
                  {data.supervisor.issueKeys.length > 0 && (
                    <span className="ml-1">
                      <Hash className="inline h-3 w-3" /> {data.supervisor.issueKeys.length} issues
                    </span>
                  )}
                </span>
              )}
            </span>
          ) : undefined
        }
      />

      <SectionBody width="wide" padding="regular">
        {!data && !error && (
          <div className="flex items-center justify-center py-20 text-sm text-stone-400 dark:text-[#7a8591]">
            Loading agent data…
          </div>
        )}

        {error && !data && (
          <div className="flex items-center justify-center py-20 text-sm text-stone-400 dark:text-[#7a8591]">
            Could not load agent data. Is the gateway running?
          </div>
        )}

        {data && data.agents.length === 0 && (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-stone-200 py-16 text-sm text-stone-400 dark:border-[#2c343d] dark:text-[#7a8591]">
            <Bot className="mr-2 h-4 w-4" />
            No agent sessions found.
          </div>
        )}

        {data && data.agents.length > 0 && (
          <div className="space-y-3">
            {data.agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} />
            ))}
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
