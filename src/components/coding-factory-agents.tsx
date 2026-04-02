"use client";

import { useCallback, useState } from "react";
import { Activity, Bot, Clock, Cpu, Hash, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSmartPoll } from "@/hooks/use-smart-poll";

type AgentInfo = {
  agentId: string;
  status: "active" | "idle";
  sessionCount: number;
  totalTokens: number;
  lastActive: number;
  model: string | null;
  thinkingLevel: string | null;
};

type SupervisorInfo = {
  status: string;
  isHealthy: boolean;
  pid: number | null;
  pidAlive: boolean;
  runId: string | null;
  issueKeys: string[];
  logPath: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

type AgentsData = {
  agents: AgentInfo[];
  supervisor: SupervisorInfo;
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

function formatAge(epochMs: number): string {
  if (epochMs <= 0) return "—";
  const diffMs = Date.now() - epochMs;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
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

export function CodingFactoryAgents() {
  const [data, setData] = useState<AgentsData | null>(null);
  const [error, setError] = useState(false);

  const fetchAgents = useCallback(async () => {
    try {
      const response = await fetch("/api/coding-factory/agents", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) { setError(true); return; }
      const envelope = await response.json();
      setData(envelope.ok ? envelope.data : envelope);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useSmartPoll(fetchAgents, { intervalMs: 12_000 });

  if (!data && !error) return null;
  if (error && !data) return null;
  if (!data) return null;

  const { agents, supervisor } = data;
  const activeAgents = agents.filter((a) => a.status === "active");
  const idleAgents = agents.filter((a) => a.status === "idle");

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-stone-400 dark:text-[#7a8591]" />
          <h2 className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">Agents</h2>
          {activeAgents.length > 0 && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              {activeAgents.length} active
            </span>
          )}
        </div>

        {/* Supervisor status */}
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-[#7a8591]">
          <Cpu className="h-3 w-3" />
          <span className={cn(
            supervisor.isHealthy
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-stone-400 dark:text-[#7a8591]"
          )}>
            Supervisor {supervisor.status}
          </span>
          {supervisor.pidAlive && supervisor.pid && (
            <span className="tabular-nums">PID {supervisor.pid}</span>
          )}
          {supervisor.issueKeys.length > 0 && (
            <span className="flex items-center gap-0.5">
              <Hash className="h-3 w-3" /> {supervisor.issueKeys.length} issues
            </span>
          )}
        </div>
      </div>

      {/* Agent grid */}
      {agents.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-stone-200 py-6 text-center text-sm text-stone-400 dark:border-[#2c343d] dark:text-[#7a8591]">
          No agent sessions found.
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <div
              key={agent.agentId}
              className={cn(
                "rounded-lg border px-3 py-2.5",
                agent.status === "active"
                  ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5"
                  : "border-stone-200 dark:border-[#2c343d]",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    {agent.status === "active" ? (
                      <>
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      </>
                    ) : (
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-stone-300 dark:bg-stone-600" />
                    )}
                  </span>
                  <span className="text-sm font-medium text-stone-900 dark:text-[#f5f7fa]">
                    {agent.agentId}
                  </span>
                </div>
                {agent.model && (
                  <span className="text-[10px] text-stone-400 dark:text-[#7a8591]">
                    {shortModel(agent.model)}
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-stone-500 dark:text-[#8d98a5]">
                <span className="flex items-center gap-0.5">
                  <Activity className="h-3 w-3" /> {agent.sessionCount}
                </span>
                <span className="flex items-center gap-0.5">
                  <Zap className="h-3 w-3" /> {formatTokens(agent.totalTokens)}
                </span>
                <span className="flex items-center gap-0.5">
                  <Clock className="h-3 w-3" /> {formatAge(agent.lastActive)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
