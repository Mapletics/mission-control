"use client";

import type { ComponentType } from "react";
import { AlertCircle, Ban, CheckCircle2, CircleDot, Clock, ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type CodingFactoryStats = {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  prsCreated: number;
};

type RunState = {
  runId: string;
  mode: "single" | "batch";
  targetRepo: string;
  baseBranch: string;
  selectedIssues: Array<{ issueKey: string }>;
  status: string;
};

type CodingFactoryRunSummaryProps = {
  isRunning: boolean;
  status: string;
  integrationBranch: string | null;
  startedAt: string | null;
  stats: CodingFactoryStats;
  run: RunState;
  activeRun: RunState;
  runSource: "draft" | "persisted" | "legacy-bridge";
};

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function CodingFactoryRunSummary({
  isRunning,
  status,
  integrationBranch,
  startedAt,
  stats,
  run,
  activeRun,
  runSource,
}: CodingFactoryRunSummaryProps) {
  const summaryRun = activeRun;
  const statusLabel = isRunning ? status : summaryRun.status;

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      {/* Status row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            {isRunning ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </>
            ) : (
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-stone-300 dark:bg-stone-600" />
            )}
          </span>
          <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
            {isRunning ? "Running" : "Draft"}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              statusLabel === "running"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : statusLabel === "draft"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300"
                  : "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300",
            )}
          >
            {statusLabel}
          </span>
        </div>

        {/* Compact metadata */}
        <div className="flex items-center gap-3 text-xs text-stone-400 dark:text-[#7a8591]">
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" /> {summaryRun.baseBranch}
          </span>
          <span>{summaryRun.selectedIssues.length} issues</span>
          {startedAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {formatElapsed(startedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-stone-100 pt-3 dark:border-[#23282e]">
        <StatBadge icon={CircleDot} label="Total" value={stats.total} />
        <StatBadge icon={CheckCircle2} label="Done" value={stats.completed} color="text-emerald-600 dark:text-emerald-400" />
        <StatBadge icon={RefreshCw} label="Active" value={stats.inProgress} color="text-blue-600 dark:text-blue-400" />
        <StatBadge icon={AlertCircle} label="Failed" value={stats.failed} color="text-red-600 dark:text-red-400" />
        <StatBadge icon={Ban} label="Blocked" value={stats.blocked} color="text-red-600 dark:text-red-400" />
        <StatBadge icon={ExternalLink} label="PRs" value={stats.prsCreated} color="text-purple-600 dark:text-purple-400" />
      </div>
    </section>
  );
}

function StatBadge({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1 text-xs", color || "text-stone-500 dark:text-[#8d98a5]")}>
      <Icon className="h-3 w-3" />
      <span className="font-semibold">{value}</span>
      <span>{label}</span>
    </span>
  );
}
