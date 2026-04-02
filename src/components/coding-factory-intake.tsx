"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FolderGit2, GitBranch, Plus, Save, Trash2 } from "lucide-react";

export type CodingFactoryMode = "single" | "batch";

export type IntakeIssue = {
  issue: number;
  repo: string;
  issueKey: string;
  title: string;
};

export type IntakeState = {
  version?: number;
  updatedAt?: string;
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: IntakeIssue[];
};

export type AvailableIssue = IntakeIssue & {
  baseBranch: string;
  phase: string;
  updatedAt: string;
};

type CodingFactoryIntakeProps = {
  intake: IntakeState;
  availableIssues: AvailableIssue[];
  saving: boolean;
  saveError: string | null;
  onSave: (nextState: IntakeState) => void;
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;

type RepoOption = {
  value: string;
  label: string;
  defaultBranch: string;
  kind: "flutter" | "web";
};

const REPO_OPTIONS: RepoOption[] = [
  {
    value: "Mapletics/App_frontend",
    label: "App_frontend (Flutter)",
    defaultBranch: "dev",
    kind: "flutter",
  },
  {
    value: "Mapletics/mapletics-dashboard",
    label: "mapletics-dashboard (Web)",
    defaultBranch: "main",
    kind: "web",
  },
  {
    value: "Mapletics/mapletics-website",
    label: "mapletics-website (Web)",
    defaultBranch: "main",
    kind: "web",
  },
];

function validateRepo(value: string): string | null {
  if (!value.trim()) return "Repo is required (e.g. owner/repo)";
  if (!REPO_PATTERN.test(value.trim())) return "Invalid format — use owner/repo";
  return null;
}

function validateBranch(value: string): string | null {
  if (!value.trim()) return "Base branch is required";
  if (!BRANCH_PATTERN.test(value.trim())) return "Invalid branch name";
  return null;
}

function validateIssueNumber(value: string): string | null {
  if (!value.trim()) return "Issue number is required";
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return "Must be a positive integer";
  return null;
}

function buildIssueKey(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

function formatUpdatedAt(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{message}</p>;
}

export function CodingFactoryIntake({
  intake,
  availableIssues,
  saving,
  saveError,
  onSave,
}: CodingFactoryIntakeProps) {
  const [manualIssue, setManualIssue] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualTouched, setManualTouched] = useState({ issue: false });
  const [repoChangeNotice, setRepoChangeNotice] = useState<string | null>(null);

  const selectedKeys = useMemo(
    () => new Set(intake.selectedIssues.map((item) => item.issueKey)),
    [intake.selectedIssues],
  );

  const remainingIssues = useMemo(
    () => availableIssues.filter((item) => !selectedKeys.has(item.issueKey)),
    [availableIssues, selectedKeys],
  );

  const targetRepoError = validateRepo(intake.targetRepo);
  const baseBranchError = validateBranch(intake.baseBranch);
  const manualIssueError = manualTouched.issue ? validateIssueNumber(manualIssue) : null;
  const manualAddDisabled = !!validateIssueNumber(manualIssue) || !!targetRepoError;

  const commit = (nextState: IntakeState) => {
    onSave({
      ...nextState,
      targetRepo: nextState.targetRepo || intake.targetRepo,
      baseBranch: nextState.baseBranch || "dev",
    });
  };

  const handleModeChange = (mode: CodingFactoryMode) => {
    const selectedIssues =
      mode === "single" && intake.selectedIssues.length > 1
        ? intake.selectedIssues.slice(0, 1)
        : intake.selectedIssues;

    commit({
      ...intake,
      mode,
      selectedIssues,
    });
  };

  const handleTargetRepoChange = (targetRepo: string) => {
    const trimmedTargetRepo = targetRepo.trim();
    const previousRepo = intake.targetRepo.trim();
    const repoChanged = trimmedTargetRepo !== previousRepo;

    const shouldClearIssues = repoChanged && intake.selectedIssues.length > 0;

    if (shouldClearIssues) {
      setRepoChangeNotice("Selected issues cleared — repo changed.");
    } else {
      setRepoChangeNotice(null);
    }

    const repoOption = REPO_OPTIONS.find((option) => option.value === trimmedTargetRepo);
    const nextBaseBranch = repoChanged && repoOption
      ? repoOption.defaultBranch
      : intake.baseBranch;

    commit({
      ...intake,
      targetRepo,
      baseBranch: nextBaseBranch,
      selectedIssues: shouldClearIssues ? [] : intake.selectedIssues,
    });
  };

  const handleAddIssue = (issue: IntakeIssue) => {
    const normalizedIssue = {
      ...issue,
      repo: intake.targetRepo,
      issueKey: buildIssueKey(intake.targetRepo, issue.issue),
    } satisfies IntakeIssue;

    const selectedIssues =
      intake.mode === "single"
        ? [normalizedIssue]
        : [
            ...intake.selectedIssues.filter((item) => item.issueKey !== normalizedIssue.issueKey),
            normalizedIssue,
          ];

    commit({
      ...intake,
      selectedIssues,
    });
  };

  const handleRemoveIssue = (issue: IntakeIssue) => {
    commit({
      ...intake,
      selectedIssues: intake.selectedIssues.filter((item) => item.issueKey !== issue.issueKey),
    });
  };

  const handleManualAdd = () => {
    setManualTouched({ issue: true });

    const issueNum = Number(manualIssue);
    if (!Number.isInteger(issueNum) || issueNum <= 0) return;
    if (!REPO_PATTERN.test(intake.targetRepo.trim())) return;

    handleAddIssue({
      issue: issueNum,
      repo: intake.targetRepo,
      issueKey: buildIssueKey(intake.targetRepo, issueNum),
      title: manualTitle.trim() || `Issue #${issueNum}`,
    });

    setManualIssue("");
    setManualTitle("");
    setManualTouched({ issue: false });
  };

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">Intake</h2>
        <span className="flex items-center gap-1.5 text-xs text-stone-400 dark:text-[#7a8591]">
          <Save className={cn("h-3 w-3", saving && "animate-pulse")} />
          {saving ? "Saving…" : "Auto-saved"}
        </span>
      </div>

      {/* Config row: mode + repo + branch inline */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        {/* Mode toggle */}
        <div className="flex items-center gap-1 rounded-lg bg-stone-100 p-0.5 dark:bg-[#20252a]">
          {(["single", "batch"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleModeChange(mode)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                intake.mode === mode
                  ? "bg-white text-stone-900 shadow-sm dark:bg-[#171a1d] dark:text-[#f5f7fa]"
                  : "text-stone-500 hover:text-stone-900 dark:text-[#8d98a5] dark:hover:text-[#f5f7fa]",
              )}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Target repo */}
        <div className="min-w-0 flex-1">
          <div className="relative">
            <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#7a8591]" />
            <select
              value={intake.targetRepo}
              onChange={(event) => handleTargetRepoChange(event.target.value)}
              className={cn(
                "flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
                targetRepoError && "border-red-300 dark:border-red-500/40",
              )}
            >
              {REPO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <InlineError message={targetRepoError} />
          {repoChangeNotice && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">{repoChangeNotice}</p>
          )}
        </div>

        {/* Base branch */}
        <div className="w-40">
          <div className="relative">
            <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#7a8591]" />
            <Input
              value={intake.baseBranch}
              onChange={(event) => commit({ ...intake, baseBranch: event.target.value })}
              placeholder="dev"
              className={cn("pl-9", baseBranchError && "border-red-300 dark:border-red-500/40")}
            />
          </div>
          <InlineError message={baseBranchError} />
        </div>
      </div>

      {/* Two-column: Selected issues | Add + Known */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        {/* Left: selected issues */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-stone-500 dark:text-[#8d98a5]">
              Selected issues
            </p>
            <Badge variant="outline" className="text-[10px]">
              {intake.selectedIssues.length} {intake.mode}
            </Badge>
          </div>

          <div className="mt-2 space-y-1.5">
            {intake.selectedIssues.length === 0 ? (
              <div className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-400 dark:border-[#2c343d] dark:text-[#7a8591]">
                No issues selected yet.
              </div>
            ) : (
              intake.selectedIssues.map((issue) => (
                <div
                  key={issue.issueKey}
                  className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2.5 dark:border-[#2c343d]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
                        #{issue.issue}
                      </span>
                      <span className="truncate text-sm text-stone-600 dark:text-[#c7d0d9]">
                        {issue.title}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveIssue(issue)}
                    className="shrink-0 rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-[#7a8591] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: add manually + known issues */}
        <div className="space-y-3">
          {/* Add manually */}
          <div>
            <p className="text-xs font-medium text-stone-500 dark:text-[#8d98a5]">Add manually</p>
            <div className="mt-2 flex items-start gap-2">
              <div className="w-20 shrink-0">
                <Input
                  type="number"
                  min={1}
                  value={manualIssue}
                  onChange={(event) => setManualIssue(event.target.value)}
                  onBlur={() => setManualTouched((prev) => ({ ...prev, issue: true }))}
                  placeholder="#"
                  className={cn("text-center", manualIssueError && "border-red-300 dark:border-red-500/40")}
                />
                <InlineError message={manualIssueError} />
              </div>
              <div className="min-w-0 flex-1">
                <Input
                  value={manualTitle}
                  onChange={(event) => setManualTitle(event.target.value)}
                  placeholder="Title (optional)"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !manualAddDisabled) handleManualAdd();
                  }}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleManualAdd}
                disabled={manualAddDisabled}
                className="shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Known issues */}
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-stone-500 dark:text-[#8d98a5]">Known issues</p>
              <Badge variant="outline" className="text-[10px]">{remainingIssues.length}</Badge>
            </div>
            <div className="mt-2 max-h-[320px] space-y-1 overflow-y-auto">
              {remainingIssues.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stone-200 px-3 py-4 text-center text-sm text-stone-400 dark:border-[#2c343d] dark:text-[#7a8591]">
                  No additional issues found.
                </div>
              ) : (
                remainingIssues.map((issue) => (
                  <button
                    key={issue.issueKey}
                    type="button"
                    onClick={() => handleAddIssue(issue)}
                    className="group flex w-full items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-left transition-colors hover:bg-stone-50 dark:border-[#2c343d] dark:hover:bg-[#20252a]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
                          #{issue.issue}
                        </span>
                        <span className="truncate text-sm text-stone-600 dark:text-[#c7d0d9]">
                          {issue.title}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-stone-400 dark:text-[#7a8591]">
                        {issue.phase} · {formatUpdatedAt(issue.updatedAt)}
                      </p>
                    </div>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-stone-300 transition-colors group-hover:text-stone-600 dark:text-[#4a5360] dark:group-hover:text-[#c7d0d9]" />
                  </button>
                ))
              )}
            </div>
          </div>

          {saveError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {saveError}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
