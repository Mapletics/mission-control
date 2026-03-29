import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { exec } from "child_process";

export const WORK_STATE_DIR = process.env.WORK_STATE_DIR || "/home/ubuntu/repos/.work-state";
export const CODING_FACTORY_INTAKE_PATH = join(WORK_STATE_DIR, "coding-factory-intake.json");
export const NIGHT_MODE_STATE_PATH = join(WORK_STATE_DIR, "night-mode.json");
export const TERMINAL_PHASES = new Set(["done", "pr-created", "blocked", "aborted", "failed"]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;

export type IssueHistory = {
  phase: string;
  status: string;
  at: string;
  round?: number;
  extra?: string;
};

export type IssueState = {
  version: number;
  issue: number;
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

export type NightModeState = {
  status: string;
  integrationBranch: string;
  startedAt: string;
  finishedAt?: string;
  issues?: number[];
  completed?: number[];
  merged?: number[];
  failed?: number[];
};

export type CodingFactoryMode = "single" | "batch";

export type CodingFactoryIntakeIssue = {
  issue: number;
  repo: string;
  title: string;
};

export type CodingFactoryIntakeState = {
  version: 1;
  updatedAt: string;
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: CodingFactoryIntakeIssue[];
};

export type CodingFactoryStats = {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  inProgress: number;
  prsCreated: number;
};

export type CodingFactoryStatus = {
  isRunning: boolean;
  status: string;
  integrationBranch: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  issues: IssueState[];
  stats: CodingFactoryStats;
};

export type AvailableIssue = {
  issue: number;
  repo: string;
  title: string;
  baseBranch: string;
  phase: string;
  updatedAt: string;
};

/* ── Unified API response envelope ── */

export type CodingFactoryApiResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export function apiOk<T>(data: T): CodingFactoryApiResponse<T> {
  return { ok: true, data };
}

export function apiError(message: string): CodingFactoryApiResponse<never> {
  return { ok: false, error: message };
}

/* ── File I/O ── */

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(WORK_STATE_DIR, { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export const DEFAULT_TARGET_REPO = "Mapletics/App_frontend";

export function defaultIntakeState(): CodingFactoryIntakeState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: "single",
    targetRepo: DEFAULT_TARGET_REPO,
    baseBranch: "dev",
    selectedIssues: [],
  };
}

export function sortIssues(issues: IssueState[]): IssueState[] {
  return [...issues].sort((a, b) => {
    const aTerminal = TERMINAL_PHASES.has(a.phase) ? 1 : 0;
    const bTerminal = TERMINAL_PHASES.has(b.phase) ? 1 : 0;
    if (aTerminal !== bTerminal) return aTerminal - bTerminal;
    return a.issue - b.issue;
  });
}

export async function readIssueStates(): Promise<IssueState[]> {
  let issueFiles: string[] = [];
  try {
    const files = await readdir(WORK_STATE_DIR);
    issueFiles = files.filter((fileName) => /^issue-\d+\.json$/.test(fileName));
  } catch {
    return [];
  }

  const issues = await Promise.all(
    issueFiles.map(async (fileName) => readJson<IssueState>(join(WORK_STATE_DIR, fileName))),
  );

  return issues.filter((issue): issue is IssueState => !!issue && issue.version === 2);
}

export function selectActiveIssues(allIssues: IssueState[], configuredIssues?: number[]): IssueState[] {
  if (!configuredIssues || configuredIssues.length === 0) {
    return allIssues;
  }

  const configuredSet = new Set(configuredIssues);
  const filtered = allIssues.filter((issue) => configuredSet.has(issue.issue));
  return filtered.length > 0 ? filtered : allIssues;
}

export async function checkNightModeProcessRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec("ps aux | grep night-mode | grep -v grep", (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

export function computeStats(issues: IssueState[]): CodingFactoryStats {
  return {
    total: issues.length,
    completed: issues.filter((issue) => issue.phase === "done" || issue.phase === "pr-created").length,
    failed: issues.filter((issue) => issue.phase === "failed" || issue.phase === "aborted").length,
    blocked: issues.filter((issue) => issue.phase === "blocked").length,
    inProgress: issues.filter((issue) => !TERMINAL_PHASES.has(issue.phase)).length,
    prsCreated: issues.filter((issue) => !!issue.prUrl).length,
  };
}

export async function getCodingFactoryStatus(): Promise<CodingFactoryStatus> {
  const [nightMode, isRunning, allIssues] = await Promise.all([
    readJson<NightModeState>(NIGHT_MODE_STATE_PATH),
    checkNightModeProcessRunning(),
    readIssueStates(),
  ]);

  const issues = sortIssues(selectActiveIssues(allIssues, nightMode?.issues));

  return {
    isRunning,
    status: nightMode?.status ?? "unknown",
    integrationBranch: nightMode?.integrationBranch ?? null,
    startedAt: nightMode?.startedAt ?? null,
    finishedAt: nightMode?.finishedAt ?? null,
    issues,
    stats: computeStats(issues),
  };
}

export function normalizeIntakeState(input: unknown): CodingFactoryIntakeState {
  const fallback = defaultIntakeState();
  const payload = (input && typeof input === "object") ? input as Record<string, unknown> : {};

  const targetRepoRaw = typeof payload.targetRepo === "string" ? payload.targetRepo.trim() : "";
  const targetRepo = targetRepoRaw && REPO_PATTERN.test(targetRepoRaw) ? targetRepoRaw : fallback.targetRepo;

  const baseBranchRaw = typeof payload.baseBranch === "string" ? payload.baseBranch.trim() : fallback.baseBranch;
  const baseBranch = baseBranchRaw && BRANCH_PATTERN.test(baseBranchRaw) ? baseBranchRaw : fallback.baseBranch;

  const mode = payload.mode === "batch" ? "batch" : "single";

  const selectedIssuesRaw = Array.isArray(payload.selectedIssues) ? payload.selectedIssues : [];
  const selectedIssues = selectedIssuesRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const issue = typeof entry.issue === "number" ? entry.issue : Number(entry.issue);
      const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
      const title = typeof entry.title === "string" ? entry.title.trim() : "";

      if (!Number.isInteger(issue) || issue <= 0) return null;
      if (!REPO_PATTERN.test(repo)) return null;

      return {
        issue,
        repo,
        title: title || `Issue #${issue}`,
      } satisfies CodingFactoryIntakeIssue;
    })
    .filter((item): item is CodingFactoryIntakeIssue => !!item)
    .reduce<CodingFactoryIntakeIssue[]>((acc, item) => {
      if (acc.some((existing) => existing.issue === item.issue && existing.repo === item.repo)) {
        return acc;
      }
      acc.push(item);
      return acc;
    }, [])
    .sort((a, b) => a.issue - b.issue);

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode,
    targetRepo,
    baseBranch,
    selectedIssues,
  };
}

export async function readIntakeState(): Promise<CodingFactoryIntakeState> {
  const intake = await readJson<CodingFactoryIntakeState>(CODING_FACTORY_INTAKE_PATH);
  if (!intake) {
    return defaultIntakeState();
  }
  return normalizeIntakeState(intake);
}

export async function saveIntakeState(input: unknown): Promise<CodingFactoryIntakeState> {
  const nextState = normalizeIntakeState(input);
  await writeJson(CODING_FACTORY_INTAKE_PATH, nextState);
  return nextState;
}

export async function listAvailableIssues(): Promise<AvailableIssue[]> {
  const issues = await readIssueStates();

  return [...issues]
    .sort((a, b) => {
      const timeDelta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return a.issue - b.issue;
    })
    .map((issue) => ({
      issue: issue.issue,
      repo: issue.repo,
      title: issue.title,
      baseBranch: issue.baseBranch,
      phase: issue.phase,
      updatedAt: issue.updatedAt,
    }));
}
