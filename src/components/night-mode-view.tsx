"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Cog,
  ExternalLink,
  FileText,
  GitBranch,
  Info,
  RefreshCw,
  X,
} from "lucide-react";
import { CodingFactoryIntake, type AvailableIssue, type IntakeState } from "@/components/coding-factory-intake";
import { CodingFactoryRunSummary } from "@/components/coding-factory-run-summary";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import { useSmartPoll } from "@/hooks/use-smart-poll";

/* ── Types ── */

type IssueHistory = {
  phase: string;
  status: string;
  at: string;
  round?: number;
  extra?: string;
};

type Issue = {
  issue: number;
  issueKey: string;
  title: string;
  repo: string;
  branch: string;
  baseBranch: string;
  size: string;
  phase: string;
  prUrl?: string;
  merged: boolean;
  startedAt: string;
  updatedAt: string;
  duration?: number | null;
  history: IssueHistory[];
};

type RunState = {
  runId: string;
  mode: "single" | "batch";
  targetRepo: string;
  baseBranch: string;
  selectedIssues: Array<{
    issue: number;
    issueKey: string;
    repo: string;
    title: string;
  }>;
  status: string;
};

type CodingFactoryData = {
  isRunning: boolean;
  status: string;
  integrationBranch: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  issues: Issue[];
  stats: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    inProgress: number;
    prsCreated: number;
  };
  intake: IntakeState;
  availableIssues: AvailableIssue[];
  run: RunState;
  activeRun: RunState;
  runSource: "draft" | "persisted" | "legacy-bridge";
};

/* ── Constants ── */

const PHASES_ORDERED = ["classify", "research", "plan", "implement", "review", "gate", "ship", "done"];
const SAVE_DEBOUNCE_MS = 800;

const PHASE_COLORS: Record<string, string> = {
  classify: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  research: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  plan: "bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300",
  implement: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  review: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  gate: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  ship: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "pr-created": "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  aborted: "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  started: "bg-stone-100 text-stone-700 dark:bg-stone-700/60 dark:text-stone-200",
};

const SIZE_COLORS: Record<string, string> = {
  S: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  M: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  L: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  "": "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300",
};

/* ── Helpers ── */

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function phaseIndex(phase: string): number {
  const idx = PHASES_ORDERED.indexOf(phase);
  return idx >= 0 ? idx : phase === "pr-created" ? PHASES_ORDERED.length - 1 : -1;
}

function computeProgress(issue: Issue): number {
  if (issue.phase === "done" || issue.phase === "pr-created") return 100;

  let maxIdx = phaseIndex(issue.phase);
  for (const event of issue.history) {
    const idx = phaseIndex(event.phase);
    if (idx > maxIdx) maxIdx = idx;
  }

  if (maxIdx < 0) return 0;
  return Math.round((maxIdx / (PHASES_ORDERED.length - 1)) * 100);
}

/* ── Log Panel ── */

function LogPanel({ issue, onClose }: { issue: Pick<Issue, "issue" | "issueKey">; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        issue: String(issue.issue),
        issueKey: issue.issueKey,
      });
      const response = await fetch(`/api/night-mode/logs?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return;
      const payload = await response.json();
      setLines(payload.lines || []);
      setExists(payload.exists ?? false);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    } catch {
      // ignore log polling errors in the overlay
    }
    setLoading(false);
  }, [issue.issue, issue.issueKey]);

  useSmartPoll(fetchLogs, { intervalMs: 10_000 });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative mx-4 flex h-[80vh] w-full max-w-4xl flex-col rounded-xl border border-stone-200 bg-white shadow-xl dark:border-[#2c343d] dark:bg-[#171a1d]">
        <div className="flex shrink-0 items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-[#2c343d]">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-stone-500 dark:text-[#8d98a5]" />
            <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
              Log — {issue.issueKey}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchLogs();
              }}
              className="rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a]"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-[#7a8591] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto bg-stone-950 p-4 font-mono text-xs leading-5 text-stone-300"
        >
          {loading && lines.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-stone-500">Loading...</div>
          ) : !exists ? (
            <div className="flex items-center justify-center py-12 text-stone-500">
              No log file found for {issue.issueKey}
            </div>
          ) : lines.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-stone-500">Log is empty</div>
          ) : (
            lines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Issue Card ── */

function IssueCard({ issue, onViewLog }: { issue: Issue; onViewLog: (issue: Pick<Issue, "issue" | "issueKey">) => void }) {
  const [expanded, setExpanded] = useState(false);
  const progress = computeProgress(issue);
  const phaseColor = PHASE_COLORS[issue.phase] || PHASE_COLORS.aborted;
  const sizeColor = SIZE_COLORS[issue.size] || SIZE_COLORS[""];

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-stone-900 dark:text-[#f5f7fa]">#{issue.issue}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", phaseColor)}>
              {issue.phase}
            </span>
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", sizeColor)}>
              {issue.size || "—"}
            </span>
            {issue.merged && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700 dark:bg-purple-500/15 dark:text-purple-300">
                merged
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-stone-700 dark:text-[#c7d0d9]">{issue.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-400 dark:text-[#7a8591]">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" /> {issue.branch}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> {formatUpdatedAt(issue.updatedAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {issue.prUrl && (
            <a
              href={issue.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
            >
              <ExternalLink className="h-3 w-3" /> PR
            </a>
          )}
          <button
            type="button"
            onClick={() => onViewLog({ issue: issue.issue, issueKey: issue.issueKey })}
            className="flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
          >
            <FileText className="h-3 w-3" /> Log
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100 dark:bg-[#23282e]">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              issue.phase === "failed" || issue.phase === "aborted" || issue.phase === "blocked"
                ? "bg-red-400 dark:bg-red-500"
                : "bg-emerald-400 dark:bg-emerald-500",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-stone-500 dark:text-[#8d98a5]">
          {issue.duration != null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {formatDuration(issue.duration)}
            </span>
          )}
        </div>
      </div>

      {issue.history.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 text-xs font-medium text-stone-500 transition-colors hover:text-stone-700 dark:text-[#8d98a5] dark:hover:text-[#c7d0d9]"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            History ({issue.history.length} events)
          </button>
          {expanded && (
            <div className="mt-2 space-y-1 border-l-2 border-stone-200 pl-3 dark:border-[#2c343d]">
              {issue.history.map((entry, index) => {
                const historyColor = PHASE_COLORS[entry.phase] || PHASE_COLORS.aborted;
                return (
                  <div key={index} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 text-stone-400 dark:text-[#7a8591]">{formatTime(entry.at)}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-xs font-medium", historyColor)}>
                      {entry.phase}
                    </span>
                    <span className="text-stone-600 dark:text-[#a8b0ba]">{entry.status}</span>
                    {entry.round != null && (
                      <span className="text-stone-400 dark:text-[#7a8591]">round {entry.round}</span>
                    )}
                    {entry.extra && (
                      <span className="truncate text-stone-400 dark:text-[#7a8591]">{entry.extra}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main View ── */

export function NightModeView({ legacy }: { legacy?: boolean }) {
  const [data, setData] = useState<CodingFactoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingIntake, setSavingIntake] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [logIssue, setLogIssue] = useState<Pick<Issue, "issue" | "issueKey"> | null>(null);
  const hasLoadedOnce = useRef(false);

  const pendingIntakeRef = useRef<IntakeState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch("/api/coding-factory", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        const message = `Failed to load coding factory data (${response.status})`;
        if (!hasLoadedOnce.current) setError(message);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const envelope = await response.json();
      const payload = envelope.ok ? envelope.data : envelope;
      setData(payload);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      if (!hasLoadedOnce.current) setError(message);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  const flushIntakeSave = useCallback(async (intake: IntakeState) => {
    savingRef.current = true;
    setSavingIntake(true);
    setIntakeError(null);

    try {
      const response = await fetch("/api/coding-factory/intake", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intake),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Failed to save intake (${response.status})`);
      }

      const envelope = await response.json();
      const saved = envelope.ok ? envelope.data : envelope;

      if (!pendingIntakeRef.current) {
        setData((current) => (current ? { ...current, intake: saved } : current));
      }
    } catch (err) {
      setIntakeError(err instanceof Error ? err.message : "Failed to save intake");
      fetchData();
    }

    setSavingIntake(false);
    savingRef.current = false;

    const queued = pendingIntakeRef.current;
    if (queued) {
      pendingIntakeRef.current = null;
      flushIntakeSave(queued);
    }
  }, [fetchData]);

  const saveIntake = useCallback((nextIntake: IntakeState) => {
    setData((current) => (current ? { ...current, intake: nextIntake } : current));

    if (savingRef.current) {
      pendingIntakeRef.current = nextIntake;
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      flushIntakeSave(nextIntake);
    }, SAVE_DEBOUNCE_MS);
  }, [flushIntakeSave]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useSmartPoll(fetchData, { intervalMs: 10_000 });

  if (loading) {
    return (
      <SectionLayout>
        <LoadingState label="Loading coding factory..." />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2.5">
            <Cog className="h-5 w-5" />
            Coding Factory
          </span>
        }
        actions={
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              fetchData();
            }}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900 disabled:opacity-50 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} /> Refresh
          </button>
        }
      />

      <SectionBody width="content" padding="compact" innerClassName="space-y-4">
        {legacy && (
          <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-500/20 dark:bg-blue-500/10">
            <Info className="h-4 w-4 shrink-0 text-blue-500" />
            <p className="text-sm text-blue-700 dark:text-blue-300">
              You are viewing the legacy <strong>/night-mode</strong> route. This page is now <strong>Coding Factory</strong>.
              Update your bookmark to <a href="/coding-factory" className="underline font-medium hover:text-blue-900 dark:hover:text-blue-100">/coding-factory</a>.
            </p>
          </div>
        )}

        {error && !data && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-500/20 dark:bg-red-500/10">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                Failed to load coding factory data
              </p>
              <p className="mt-0.5 text-xs text-red-600 dark:text-red-300/70">{error}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                fetchData();
              }}
              className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30"
            >
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            <CodingFactoryIntake
              intake={data.intake}
              availableIssues={data.availableIssues}
              saving={savingIntake}
              saveError={intakeError}
              onSave={saveIntake}
            />

            <CodingFactoryRunSummary
              isRunning={data.isRunning}
              status={data.status}
              integrationBranch={data.integrationBranch}
              startedAt={data.startedAt}
              stats={data.stats}
              run={data.run}
              activeRun={data.activeRun}
              runSource={data.runSource}
            />

            {data.issues.length === 0 ? (
              <div className="flex items-center justify-center rounded-xl border border-dashed border-stone-200 py-10 text-sm text-stone-400 dark:border-[#2c343d] dark:text-[#7a8591]">
                No active issues in the current run.
              </div>
            ) : (
              data.issues.map((issue) => (
                <IssueCard key={issue.issueKey} issue={issue} onViewLog={setLogIssue} />
              ))
            )}
          </>
        )}
      </SectionBody>

      {logIssue !== null && <LogPanel issue={logIssue} onClose={() => setLogIssue(null)} />}
    </SectionLayout>
  );
}
