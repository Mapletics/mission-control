import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { exec } from "child_process";

export const WORK_STATE_DIR = process.env.WORK_STATE_DIR || "/home/ubuntu/repos/.work-state";
export const CODING_FACTORY_INTAKE_PATH = join(WORK_STATE_DIR, "coding-factory-intake.json");
export const CODING_FACTORY_RUN_PATH = join(WORK_STATE_DIR, "coding-factory-run.json");
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

export type IssueRef = {
  issue: number;
  repo: string;
  issueKey: string;
  title: string;
};

export type IssueState = IssueRef & {
  version: number;
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
export type CodingFactoryRunStatus = "draft" | "running" | "completed" | "idle" | "unknown";
export type CodingFactoryRunSource = "draft" | "persisted" | "legacy-bridge";

export type CodingFactoryIntakeIssue = IssueRef;

export type CodingFactoryIntakeState = {
  version: 1;
  updatedAt: string;
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: CodingFactoryIntakeIssue[];
};

export type CodingFactoryRunState = {
  version: 1;
  updatedAt: string;
  runId: string;
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: IssueRef[];
  status: CodingFactoryRunStatus;
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
  run: CodingFactoryRunState;
  activeRun: CodingFactoryRunState;
  runSource: CodingFactoryRunSource;
};

export type AvailableIssue = IssueRef & {
  baseBranch: string;
  phase: string;
  updatedAt: string;
};

export type ListAvailableIssuesOptions = {
  targetRepo?: string;
  excludeIssueKeys?: Iterable<string>;
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

export function buildIssueKey(repo: string, issue: number): string {
  return `${repo}#${issue}`;
}

export function parseIssueKey(issueKey: string): { repo: string; issue: number } | null {
  const trimmed = issueKey.trim();
  const match = trimmed.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (!match) return null;

  const issue = Number(match[2]);
  if (!Number.isInteger(issue) || issue <= 0) return null;

  return {
    repo: match[1],
    issue,
  };
}

export function createIssueRef(issue: number, repo: string, title?: string): IssueRef {
  const normalizedRepo = repo.trim();
  return {
    issue,
    repo: normalizedRepo,
    issueKey: buildIssueKey(normalizedRepo, issue),
    title: (title || `Issue #${issue}`).trim() || `Issue #${issue}`,
  };
}

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

export function createDraftRunState(intake: CodingFactoryIntakeState, status: CodingFactoryRunStatus = "draft"): CodingFactoryRunState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    runId: `draft-${intake.targetRepo.replace(/\//g, "-")}`,
    mode: intake.mode,
    targetRepo: intake.targetRepo,
    baseBranch: intake.baseBranch,
    selectedIssues: intake.selectedIssues,
    status,
  };
}

function normalizeIssueLike(
  input: unknown,
  fallbackRepo: string,
): CodingFactoryIntakeIssue | null {
  if (!input || typeof input !== "object") return null;

  const entry = input as Record<string, unknown>;
  const parsedIssueKey = typeof entry.issueKey === "string"
    ? parseIssueKey(entry.issueKey)
    : null;

  const issue = parsedIssueKey?.issue ?? (typeof entry.issue === "number" ? entry.issue : Number(entry.issue));
  if (!Number.isInteger(issue) || issue <= 0) return null;

  const repoRaw = typeof entry.repo === "string" && entry.repo.trim()
    ? entry.repo.trim()
    : parsedIssueKey?.repo ?? fallbackRepo;
  if (!REPO_PATTERN.test(repoRaw)) return null;

  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  return createIssueRef(issue, repoRaw, title || `Issue #${issue}`);
}

function uniqueIssues(issues: CodingFactoryIntakeIssue[]): CodingFactoryIntakeIssue[] {
  const byKey = new Map<string, CodingFactoryIntakeIssue>();
  for (const issue of issues) {
    if (!byKey.has(issue.issueKey)) {
      byKey.set(issue.issueKey, issue);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const repoDelta = a.repo.localeCompare(b.repo);
    if (repoDelta !== 0) return repoDelta;
    return a.issue - b.issue;
  });
}

export function sortIssues(issues: IssueState[]): IssueState[] {
  return [...issues].sort((a, b) => {
    const aTerminal = TERMINAL_PHASES.has(a.phase) ? 1 : 0;
    const bTerminal = TERMINAL_PHASES.has(b.phase) ? 1 : 0;
    if (aTerminal !== bTerminal) return aTerminal - bTerminal;

    const repoDelta = a.repo.localeCompare(b.repo);
    if (repoDelta !== 0) return repoDelta;
    return a.issue - b.issue;
  });
}

export async function readIssueStates(): Promise<IssueState[]> {
  let issueFiles: string[] = [];
  try {
    const files = await readdir(WORK_STATE_DIR);
    issueFiles = files.filter((fileName) => /^issue-.+\.json$/.test(fileName) && !fileName.endsWith(".bak"));
  } catch {
    return [];
  }

  const issues = await Promise.all(
    issueFiles.map(async (fileName) => ({
      fileName,
      issue: await readJson<IssueState>(join(WORK_STATE_DIR, fileName)),
    })),
  );

  const byIssueKey = new Map<string, { fileName: string; issue: IssueState }>();

  for (const entry of issues) {
    const issue = entry.issue;
    if (!issue || !REPO_PATTERN.test(issue.repo) || !Number.isInteger(issue.issue) || issue.issue <= 0) {
      continue;
    }

    const normalizedIssue = {
      ...issue,
      version: 2,
      issueKey: buildIssueKey(issue.repo, issue.issue),
      title: issue.title?.trim() || `Issue #${issue.issue}`,
    } satisfies IssueState;

    const existing = byIssueKey.get(normalizedIssue.issueKey);
    const isRepoScopedFile = !/^issue-\d+\.json$/.test(entry.fileName);
    const existingIsRepoScopedFile = existing ? !/^issue-\d+\.json$/.test(existing.fileName) : false;

    if (!existing || (isRepoScopedFile && !existingIsRepoScopedFile)) {
      byIssueKey.set(normalizedIssue.issueKey, {
        fileName: entry.fileName,
        issue: normalizedIssue,
      });
    }
  }

  return [...byIssueKey.values()].map((entry) => entry.issue);
}

export function selectIssuesByKey(allIssues: IssueState[], selectedIssues?: IssueRef[]): IssueState[] {
  if (!selectedIssues || selectedIssues.length === 0) {
    return [];
  }

  const selectedKeys = new Set(selectedIssues.map((issue) => issue.issueKey));
  return allIssues.filter((issue) => selectedKeys.has(issue.issueKey));
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

export function normalizeIntakeState(input: unknown): CodingFactoryIntakeState {
  const fallback = defaultIntakeState();
  const payload = (input && typeof input === "object") ? input as Record<string, unknown> : {};

  const targetRepoRaw = typeof payload.targetRepo === "string" ? payload.targetRepo.trim() : "";
  const targetRepo = targetRepoRaw && REPO_PATTERN.test(targetRepoRaw) ? targetRepoRaw : fallback.targetRepo;

  const baseBranchRaw = typeof payload.baseBranch === "string" ? payload.baseBranch.trim() : fallback.baseBranch;
  const baseBranch = baseBranchRaw && BRANCH_PATTERN.test(baseBranchRaw) ? baseBranchRaw : fallback.baseBranch;

  const mode = payload.mode === "batch" ? "batch" : "single";

  const selectedIssuesRaw = Array.isArray(payload.selectedIssues) ? payload.selectedIssues : [];
  const selectedIssues = uniqueIssues(
    selectedIssuesRaw
      .map((item) => normalizeIssueLike(item, targetRepo))
      .filter((item): item is CodingFactoryIntakeIssue => !!item)
      .filter((item) => item.repo === targetRepo),
  );

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode,
    targetRepo,
    baseBranch,
    selectedIssues: mode === "single" ? selectedIssues.slice(0, 1) : selectedIssues,
  };
}

export function normalizeRunState(input: unknown, intakeFallback?: CodingFactoryIntakeState): CodingFactoryRunState {
  const intake = intakeFallback ?? defaultIntakeState();
  const fallback = createDraftRunState(intake, "draft");
  const payload = (input && typeof input === "object") ? input as Record<string, unknown> : {};

  const targetRepoRaw = typeof payload.targetRepo === "string" ? payload.targetRepo.trim() : intake.targetRepo;
  const targetRepo = REPO_PATTERN.test(targetRepoRaw) ? targetRepoRaw : fallback.targetRepo;

  const baseBranchRaw = typeof payload.baseBranch === "string" ? payload.baseBranch.trim() : intake.baseBranch;
  const baseBranch = baseBranchRaw && BRANCH_PATTERN.test(baseBranchRaw) ? baseBranchRaw : fallback.baseBranch;

  const mode = payload.mode === "batch" ? "batch" : "single";
  const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId.trim() : fallback.runId;
  const rawStatus = typeof payload.status === "string" ? payload.status.trim() : fallback.status;
  const status: CodingFactoryRunStatus = ["draft", "running", "completed", "idle", "unknown"].includes(rawStatus)
    ? rawStatus as CodingFactoryRunStatus
    : fallback.status;

  const selectedIssuesRaw = Array.isArray(payload.selectedIssues) ? payload.selectedIssues : [];
  const selectedIssues = uniqueIssues(
    selectedIssuesRaw
      .map((item) => normalizeIssueLike(item, targetRepo))
      .filter((item): item is CodingFactoryIntakeIssue => !!item)
      .filter((item) => item.repo === targetRepo),
  );

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    runId,
    mode,
    targetRepo,
    baseBranch,
    selectedIssues: mode === "single" ? selectedIssues.slice(0, 1) : selectedIssues,
    status,
  };
}

export async function readIntakeState(): Promise<CodingFactoryIntakeState> {
  const intake = await readJson<CodingFactoryIntakeState>(CODING_FACTORY_INTAKE_PATH);
  if (!intake) {
    return defaultIntakeState();
  }
  return normalizeIntakeState(intake);
}

async function readPersistedRunState(intakeFallback?: CodingFactoryIntakeState): Promise<CodingFactoryRunState | null> {
  const intake = intakeFallback ?? await readIntakeState();
  const run = await readJson<CodingFactoryRunState>(CODING_FACTORY_RUN_PATH);
  if (!run) {
    return null;
  }
  return normalizeRunState(run, intake);
}

export async function readRunState(intakeFallback?: CodingFactoryIntakeState): Promise<CodingFactoryRunState> {
  const intake = intakeFallback ?? await readIntakeState();
  const run = await readPersistedRunState(intake);
  return run ?? createDraftRunState(intake, intake.selectedIssues.length > 0 ? "draft" : "idle");
}

export async function saveRunState(input: unknown, intakeFallback?: CodingFactoryIntakeState): Promise<CodingFactoryRunState> {
  const intake = intakeFallback ?? await readIntakeState();
  const nextState = normalizeRunState(input, intake);
  await writeJson(CODING_FACTORY_RUN_PATH, nextState);
  return nextState;
}

export async function saveIntakeState(input: unknown): Promise<CodingFactoryIntakeState> {
  const nextState = normalizeIntakeState(input);
  await writeJson(CODING_FACTORY_INTAKE_PATH, nextState);
  return nextState;
}

function buildLegacyIssueRefs(
  nightMode: NightModeState | null,
  allIssues: IssueState[],
  existingRun: CodingFactoryRunState,
  fallbackRepo: string,
): IssueRef[] {
  const configuredIssueNumbers = (nightMode?.issues ?? []).filter((issue) => Number.isInteger(issue) && issue > 0);
  const issueStatesByNumber = new Map<number, IssueState[]>();
  for (const issue of allIssues) {
    const scoped = issueStatesByNumber.get(issue.issue) ?? [];
    scoped.push(issue);
    issueStatesByNumber.set(issue.issue, scoped);
  }

  const existingRefsByNumber = new Map<number, IssueRef>(
    existingRun.selectedIssues.map((issue) => [issue.issue, issue]),
  );

  return uniqueIssues(configuredIssueNumbers.map((issueNumber) => {
    const existingRef = existingRefsByNumber.get(issueNumber);
    const candidates = issueStatesByNumber.get(issueNumber) ?? [];

    if (existingRef) {
      const exactMatch = candidates.find((candidate) => candidate.issueKey === existingRef.issueKey);
      if (exactMatch) {
        return createIssueRef(exactMatch.issue, exactMatch.repo, exactMatch.title);
      }
    }

    const repoScopedCandidate = candidates.find((candidate) => candidate.repo === fallbackRepo);
    if (repoScopedCandidate) {
      return createIssueRef(repoScopedCandidate.issue, repoScopedCandidate.repo, repoScopedCandidate.title);
    }

    if (candidates.length === 1) {
      const [candidate] = candidates;
      return createIssueRef(candidate.issue, candidate.repo, candidate.title);
    }

    return createIssueRef(issueNumber, fallbackRepo, `Issue #${issueNumber} (legacy bridge unresolved)`);
  }));
}

function buildLegacyBridgeRunState(
  intake: CodingFactoryIntakeState,
  nightMode: NightModeState | null,
  allIssues: IssueState[],
  existingRun: CodingFactoryRunState,
): CodingFactoryRunState {
  const fallbackRepo = intake.targetRepo || existingRun.targetRepo || existingRun.selectedIssues[0]?.repo;
  const selectedIssues = buildLegacyIssueRefs(nightMode, allIssues, existingRun, fallbackRepo);
  const selectedIssueStates = selectIssuesByKey(allIssues, selectedIssues);
  const targetRepo = selectedIssues[0]?.repo || fallbackRepo;

  const inferredMode: CodingFactoryMode = selectedIssues.length > 1 ? "batch" : "single";
  const status: CodingFactoryRunStatus = nightMode?.status === "running"
    ? "running"
    : selectedIssues.length > 0
      ? "unknown"
      : "idle";

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    runId: existingRun.runId.startsWith("cf-") ? existingRun.runId : `cf-${nightMode?.startedAt ?? new Date().toISOString()}`,
    mode: inferredMode,
    targetRepo,
    baseBranch: selectedIssueStates[0]?.baseBranch || existingRun.baseBranch || intake.baseBranch,
    selectedIssues,
    status,
  };
}

function finalizeRunState(
  run: CodingFactoryRunState,
  allIssues: IssueState[],
  nightMode: NightModeState | null,
): CodingFactoryRunState {
  if (run.status !== "running") {
    return run;
  }

  const selectedIssueStates = selectIssuesByKey(allIssues, run.selectedIssues);
  const hasSelectedIssues = run.selectedIssues.length > 0;
  const allSelectedIssuesTerminal = hasSelectedIssues
    && selectedIssueStates.length === run.selectedIssues.length
    && selectedIssueStates.every((issue) => TERMINAL_PHASES.has(issue.phase));

  const status: CodingFactoryRunStatus = allSelectedIssuesTerminal || !!nightMode?.finishedAt
    ? "completed"
    : hasSelectedIssues
      ? "unknown"
      : "idle";

  return {
    ...run,
    updatedAt: new Date().toISOString(),
    status,
  };
}

async function resolveRunState(
  intake: CodingFactoryIntakeState,
  nightMode: NightModeState | null,
  isNightModeRunning: boolean,
  allIssues: IssueState[],
): Promise<{
  run: CodingFactoryRunState;
  activeRun: CodingFactoryRunState;
  runSource: CodingFactoryRunSource;
}> {
  const existingRun = await readPersistedRunState(intake);
  const persistedOrDraft = existingRun ?? createDraftRunState(intake, intake.selectedIssues.length > 0 ? "draft" : "idle");

  if (isNightModeRunning || nightMode?.status === "running") {
    return {
      run: persistedOrDraft,
      activeRun: buildLegacyBridgeRunState(intake, nightMode, allIssues, persistedOrDraft),
      runSource: "legacy-bridge",
    };
  }

  if (existingRun) {
    return {
      run: existingRun,
      activeRun: finalizeRunState(existingRun, allIssues, nightMode),
      runSource: "persisted",
    };
  }

  return {
    run: persistedOrDraft,
    activeRun: persistedOrDraft,
    runSource: "draft",
  };
}

export async function listAvailableIssues(options: ListAvailableIssuesOptions = {}): Promise<AvailableIssue[]> {
  const issues = await readIssueStates();
  const excludeKeys = new Set(options.excludeIssueKeys ?? []);

  return [...issues]
    .filter((issue) => !options.targetRepo || issue.repo === options.targetRepo)
    .filter((issue) => !excludeKeys.has(issue.issueKey))
    .sort((a, b) => {
      const timeDelta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return a.issue - b.issue;
    })
    .map((issue) => ({
      issue: issue.issue,
      repo: issue.repo,
      issueKey: issue.issueKey,
      title: issue.title,
      baseBranch: issue.baseBranch,
      phase: issue.phase,
      updatedAt: issue.updatedAt,
    }));
}

export async function getCodingFactoryStatus(): Promise<CodingFactoryStatus> {
  const [nightMode, isRunning, allIssues, intake] = await Promise.all([
    readJson<NightModeState>(NIGHT_MODE_STATE_PATH),
    checkNightModeProcessRunning(),
    readIssueStates(),
    readIntakeState(),
  ]);

  const { run, activeRun, runSource } = await resolveRunState(intake, nightMode, isRunning, allIssues);
  const issues = sortIssues(selectIssuesByKey(allIssues, activeRun.selectedIssues));

  return {
    isRunning,
    status: nightMode?.status ?? activeRun.status ?? "unknown",
    integrationBranch: nightMode?.integrationBranch ?? null,
    startedAt: nightMode?.startedAt ?? null,
    finishedAt: nightMode?.finishedAt ?? null,
    issues,
    stats: computeStats(issues),
    run,
    activeRun,
    runSource,
  };
}
