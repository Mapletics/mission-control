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
  const [manualRepo, setManualRepo] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualTouched, setManualTouched] = useState({ issue: false, repo: false });

  const selectedKeys = useMemo(
    () => new Set(intake.selectedIssues.map((item) => `${item.repo}#${item.issue}`)),
    [intake.selectedIssues],
  );

  const remainingIssues = useMemo(
    () => availableIssues.filter((item) => !selectedKeys.has(`${item.repo}#${item.issue}`)),
    [availableIssues, selectedKeys],
  );

  // Validation for top-level fields
  const targetRepoError = validateRepo(intake.targetRepo);
  const baseBranchError = validateBranch(intake.baseBranch);

  // Validation for manual add form
  const manualIssueError = manualTouched.issue ? validateIssueNumber(manualIssue) : null;
  const manualRepoError = manualTouched.repo ? validateRepo(manualRepo || intake.targetRepo) : null;
  const manualAddDisabled =
    !!validateIssueNumber(manualIssue) ||
    !!validateRepo(manualRepo || intake.targetRepo);

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

  const handleAddIssue = (issue: IntakeIssue) => {
    const selectedIssues =
      intake.mode === "single"
        ? [issue]
        : [...intake.selectedIssues.filter((item) => !(item.issue === issue.issue && item.repo === issue.repo)), issue];

    commit({
      ...intake,
      selectedIssues,
    });
  };

  const handleRemoveIssue = (issue: IntakeIssue) => {
    commit({
      ...intake,
      selectedIssues: intake.selectedIssues.filter(
        (item) => !(item.issue === issue.issue && item.repo === issue.repo),
      ),
    });
  };

  const handleManualAdd = () => {
    setManualTouched({ issue: true, repo: true });

    const issueNum = Number(manualIssue);
    if (!Number.isInteger(issueNum) || issueNum <= 0) return;

    const repo = (manualRepo.trim() || intake.targetRepo).trim();
    if (!REPO_PATTERN.test(repo)) return;

    handleAddIssue({
      issue: issueNum,
      repo,
      title: manualTitle.trim() || `Issue #${issueNum}`,
    });

    setManualIssue("");
    setManualTitle("");
    setManualRepo("");
    setManualTouched({ issue: false, repo: false });
  };

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]">
      <div className="flex flex-col gap-3 border-b border-stone-100 pb-4 dark:border-[#23282e] sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">Intake</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-[#8d98a5]">
            Prepare issues, target repo, base branch, and execution mode before Paket 3 adds the real trigger.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-[#8d98a5]">
          <Save className={cn("h-3.5 w-3.5", saving && "animate-pulse")} />
          <span>{saving ? "Saving intake…" : "Intake persists automatically"}</span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <div className="space-y-4">
          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
                  Mode
                </p>
                <p className="mt-1 text-sm text-stone-600 dark:text-[#c7d0d9]">
                  Single keeps one prepared issue. Batch keeps a list for later orchestration.
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-stone-100 p-1 dark:bg-[#20252a]">
                {(["single", "batch"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleModeChange(mode)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      intake.mode === mode
                        ? "bg-white text-stone-900 shadow-sm dark:bg-[#171a1d] dark:text-[#f5f7fa]"
                        : "text-stone-500 hover:text-stone-900 dark:text-[#8d98a5] dark:hover:text-[#f5f7fa]",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            {intake.mode === "single" && intake.selectedIssues.length > 1 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">
                Single mode keeps only the first selected issue.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
              Target repo
            </p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="relative flex-1">
                <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#7a8591]" />
                <Input
                  value={intake.targetRepo}
                  onChange={(event) => commit({ ...intake, targetRepo: event.target.value })}
                  placeholder="owner/repo"
                  className={cn("pl-9", targetRepoError && "border-red-300 dark:border-red-500/40")}
                />
                <InlineError message={targetRepoError} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
              Base branch
            </p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="relative flex-1">
                <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#7a8591]" />
                <Input
                  value={intake.baseBranch}
                  onChange={(event) => commit({ ...intake, baseBranch: event.target.value })}
                  placeholder="dev"
                  className={cn("pl-9", baseBranchError && "border-red-300 dark:border-red-500/40")}
                />
                <InlineError message={baseBranchError} />
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "dev", value: "dev" },
                  { label: "main", value: "main" },
                ].map((preset) => (
                  <Button
                    key={preset.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => commit({ ...intake, baseBranch: preset.value })}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
                  Selected issues
                </p>
                <p className="mt-1 text-sm text-stone-600 dark:text-[#c7d0d9]">
                  {intake.selectedIssues.length === 0
                    ? "No issues prepared yet."
                    : `${intake.selectedIssues.length} issue${intake.selectedIssues.length === 1 ? "" : "s"} queued in the intake draft.`}
                </p>
              </div>
              <Badge variant="outline">{intake.mode}</Badge>
            </div>

            <div className="mt-3 space-y-2">
              {intake.selectedIssues.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stone-200 px-3 py-4 text-sm text-stone-500 dark:border-[#2c343d] dark:text-[#8d98a5]">
                  Add from the known issue list or use the manual fallback form.
                </div>
              ) : (
                intake.selectedIssues.map((issue) => (
                  <div
                    key={`${issue.repo}#${issue.issue}`}
                    className="flex flex-col gap-3 rounded-lg border border-stone-200 px-3 py-3 dark:border-[#2c343d] sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
                          #{issue.issue}
                        </span>
                        <Badge variant="outline">{issue.repo}</Badge>
                      </div>
                      <p className="mt-1 truncate text-sm text-stone-600 dark:text-[#c7d0d9]">
                        {issue.title}
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => handleRemoveIssue(issue)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
              Add issue manually
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <Input
                  type="number"
                  min={1}
                  value={manualIssue}
                  onChange={(event) => setManualIssue(event.target.value)}
                  onBlur={() => setManualTouched((prev) => ({ ...prev, issue: true }))}
                  placeholder="Issue #"
                  className={cn(manualIssueError && "border-red-300 dark:border-red-500/40")}
                />
                <InlineError message={manualIssueError} />
              </div>
              <div>
                <Input
                  value={manualRepo}
                  onChange={(event) => setManualRepo(event.target.value)}
                  onBlur={() => setManualTouched((prev) => ({ ...prev, repo: true }))}
                  placeholder={`Repo (defaults to ${intake.targetRepo})`}
                  className={cn(manualRepoError && "border-red-300 dark:border-red-500/40")}
                />
                <InlineError message={manualRepoError} />
              </div>
              <Input
                value={manualTitle}
                onChange={(event) => setManualTitle(event.target.value)}
                placeholder="Optional title"
              />
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleManualAdd}
                disabled={manualAddDisabled}
              >
                <Plus className="h-3.5 w-3.5" /> Add issue
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 p-3 dark:border-[#2c343d]">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-[#8d98a5]">
                Known issues
              </p>
              <Badge variant="outline">{remainingIssues.length}</Badge>
            </div>
            <div className="mt-3 space-y-2">
              {remainingIssues.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stone-200 px-3 py-4 text-sm text-stone-500 dark:border-[#2c343d] dark:text-[#8d98a5]">
                  No additional issues available from the current state files.
                </div>
              ) : (
                remainingIssues.slice(0, 8).map((issue) => (
                  <button
                    key={`${issue.repo}#${issue.issue}`}
                    type="button"
                    onClick={() => handleAddIssue(issue)}
                    className="w-full rounded-lg border border-stone-200 px-3 py-3 text-left transition-colors hover:bg-stone-50 dark:border-[#2c343d] dark:hover:bg-[#20252a]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-stone-900 dark:text-[#f5f7fa]">
                            #{issue.issue}
                          </span>
                          <Badge variant="outline">{issue.repo}</Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-stone-600 dark:text-[#c7d0d9]">
                          {issue.title}
                        </p>
                        <p className="mt-2 text-xs text-stone-500 dark:text-[#8d98a5]">
                          phase {issue.phase} • base {issue.baseBranch} • updated {formatUpdatedAt(issue.updatedAt)}
                        </p>
                      </div>
                      <Plus className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 dark:text-[#7a8591]" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {saveError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {saveError}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
