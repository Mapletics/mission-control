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

type CodingFactoryRunSummaryProps = {
  isRunning: boolean;
  status: string;
  integrationBranch: string | null;
  startedAt: string | null;
  stats: CodingFactoryStats;
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
}: CodingFactoryRunSummaryProps) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            {isRunning ? (
              <>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
              </>
            ) : (
              <span className="relative inline-flex h-3 w-3 rounded-full bg-stone-300 dark:bg-stone-600" />
            )}
          </span>
          <div>
            <p className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
              {isRunning ? "Active factory run" : "Run engine idle"}
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-[#8d98a5]">
              The intake above is editable. The runtime view below still reflects the current Night Mode engine.
            </p>
          </div>
        </div>

        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium",
            status === "running"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300",
          )}
        >
          {status}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-stone-500 dark:text-[#8d98a5]">
        {integrationBranch && (
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" /> {integrationBranch}
          </span>
        )}
        {startedAt && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> Started {formatTime(startedAt)} ({formatElapsed(startedAt)})
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-3 dark:border-[#23282e]">
        <StatBadge icon={CircleDot} label="Total" value={stats.total} />
        <StatBadge icon={CheckCircle2} label="Completed" value={stats.completed} color="text-emerald-600 dark:text-emerald-400" />
        <StatBadge icon={AlertCircle} label="Failed" value={stats.failed} color="text-red-600 dark:text-red-400" />
        <StatBadge icon={Ban} label="Blocked" value={stats.blocked} color="text-red-600 dark:text-red-400" />
        <StatBadge icon={RefreshCw} label="In Progress" value={stats.inProgress} color="text-blue-600 dark:text-blue-400" />
        <StatBadge icon={ExternalLink} label="PRs Created" value={stats.prsCreated} color="text-purple-600 dark:text-purple-400" />
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
