import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { exec } from "child_process";
import {
  ISSUE_STATES,
  RUN_STATES,
  applyIssueTransition,
  applyRunTransition,
  deriveIssueStateHistory,
  deriveRunStateHistory,
  inferIssueStateFromLegacyTopLevel,
  isIssueState,
  isRunState,
  isTerminalIssueState,
  issuePhaseFromState,
  legacyRunStatusFromState,
  normalizePersistedTransitions,
  resolveRunStateFromIssues,
  type CodingFactoryIssueStateName,
  type CodingFactoryRunStateName,
  type StateTransition,
} from "@/lib/coding-factory-state-machine";

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
  state: CodingFactoryIssueStateName;
  stateUpdatedAt: string;
  stateHistory: StateTransition<CodingFactoryIssueStateName>[];
  prUrl?: string;
  merged: boolean;
  startedAt: string;
  updatedAt: string;
  duration?: number | null;
  history: IssueHistory[];
};

export type NightModeState = {
  status: string;
  state?: CodingFactoryRunStateName;
  stateUpdatedAt?: string;
  stateHistory?: StateTransition<CodingFactoryRunStateName>[];
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
  version: number;
  updatedAt: string;
  runId: string;
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: IssueRef[];
  status: CodingFactoryRunStatus;
  state: CodingFactoryRunStateName;
  stateUpdatedAt: string;
  stateHistory: StateTransition<CodingFactoryRunStateName>[];
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
  state: CodingFactoryRunStateName;
  integrationBranch: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  issues: IssueState[];
  stats: CodingFactoryStats;
  run: CodingFactoryRunState;
  activeRun: CodingFactoryRunState;
  runSource: CodingFactoryRunSource;
  stateMachine: {
    runStates: readonly CodingFactoryRunStateName[];
    issueStates: readonly CodingFactoryIssueStateName[];
  };
};

export type AvailableIssue = IssueRef & {
  baseBranch: string;
  phase: string;
  state: CodingFactoryIssueStateName;
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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function coerceTimestamp(...values: Array<unknown>): string {
  for (const value of values) {
    if (isIsoDate(value)) return value;
  }
  return new Date().toISOString();
}

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

export function createDraftRunState(
  intake: CodingFactoryIntakeState,
  status: CodingFactoryRunStatus = "draft",
): CodingFactoryRunState {
  let current = {
    state: "created" as CodingFactoryRunStateName,
    stateHistory: [] as StateTransition<CodingFactoryRunStateName>[],
    stateUpdatedAt: new Date().toISOString(),
  };

  if (intake.selectedIssues.length > 0) {
    current = applyRunTransition(current, {
      to: "intake_validated",
      source: "derived",
      reason: "draft-intake-selected",
    });
  }

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    runId: `draft-${intake.targetRepo.replace(/\//g, "-")}`,
    mode: intake.mode,
    targetRepo: intake.targetRepo,
    baseBranch: intake.baseBranch,
    selectedIssues: intake.selectedIssues,
    status,
    state: current.state,
    stateUpdatedAt: current.stateUpdatedAt,
    stateHistory: current.stateHistory,
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

function issueSortWeight(issue: IssueState): number {
  if (isTerminalIssueState(issue.state)) return 1;
  return 0;
}

export function sortIssues(issues: IssueState[]): IssueState[] {
  return [...issues].sort((a, b) => {
    const terminalDelta = issueSortWeight(a) - issueSortWeight(b);
    if (terminalDelta !== 0) return terminalDelta;

    const updatedDelta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (updatedDelta !== 0) return updatedDelta;

    const repoDelta = a.repo.localeCompare(b.repo);
    if (repoDelta !== 0) return repoDelta;
    return a.issue - b.issue;
  });
}

function normalizeIssueHistory(input: unknown): IssueHistory[] {
  if (!Array.isArray(input)) return [];

  const history: IssueHistory[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    history.push({
      phase: typeof item.phase === "string" ? item.phase : "started",
      status: typeof item.status === "string" ? item.status : "unknown",
      at: coerceTimestamp(item.at),
      round: typeof item.round === "number" ? item.round : undefined,
      extra: typeof item.extra === "string" ? item.extra : undefined,
    });
  }

  return history.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function normalizeIssueStateRecord(input: unknown): IssueState | null {
  if (!input || typeof input !== "object") return null;

  const payload = input as Record<string, unknown>;
  const repo = typeof payload.repo === "string" ? payload.repo.trim() : "";
  const issue = typeof payload.issue === "number" ? payload.issue : Number(payload.issue);
  if (!REPO_PATTERN.test(repo) || !Number.isInteger(issue) || issue <= 0) return null;

  const issueKey = buildIssueKey(repo, issue);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : `Issue #${issue}`;
  const history = normalizeIssueHistory(payload.history);

  const persistedStateHistory = normalizePersistedTransitions<CodingFactoryIssueStateName>(payload.stateHistory, isIssueState);
  const derivedState = deriveIssueStateHistory({
    history,
    phase: typeof payload.phase === "string" ? payload.phase : undefined,
    status: typeof payload.status === "string" ? payload.status : undefined,
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : undefined,
    merged: payload.merged === true,
    updatedAt: isIsoDate(payload.updatedAt) ? payload.updatedAt : undefined,
    startedAt: isIsoDate(payload.startedAt) ? payload.startedAt : undefined,
  });

  const issueState = isIssueState(payload.state) ? payload.state : derivedState.state;
  const stateHistory = persistedStateHistory.length > 0 ? persistedStateHistory : derivedState.stateHistory;
  const stateUpdatedAt = coerceTimestamp(
    payload.stateUpdatedAt,
    stateHistory[stateHistory.length - 1]?.at,
    payload.updatedAt,
    payload.startedAt,
  );

  return {
    version: typeof payload.version === "number" ? Math.max(payload.version, 2) : 2,
    issue,
    repo,
    issueKey,
    title,
    branch: typeof payload.branch === "string" ? payload.branch : "",
    baseBranch: typeof payload.baseBranch === "string" ? payload.baseBranch : "dev",
    size: typeof payload.size === "string" ? payload.size : "",
    phase: typeof payload.phase === "string"
      ? payload.phase
      : issuePhaseFromState(issueState),
    state: issueState,
    stateUpdatedAt,
    stateHistory,
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : undefined,
    merged: payload.merged === true,
    startedAt: coerceTimestamp(payload.startedAt, history[0]?.at, payload.updatedAt),
    updatedAt: coerceTimestamp(payload.updatedAt, stateUpdatedAt, payload.startedAt),
    duration: typeof payload.duration === "number" || payload.duration === null ? payload.duration : null,
    history,
  };
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
      issue: normalizeIssueStateRecord(await readJson<Record<string, unknown>>(join(WORK_STATE_DIR, fileName))),
    })),
  );

  const byIssueKey = new Map<string, { fileName: string; issue: IssueState }>();

  for (const entry of issues) {
    const issue = entry.issue;
    if (!issue) continue;

    const existing = byIssueKey.get(issue.issueKey);
    const isRepoScopedFile = !/^issue-\d+\.json$/.test(entry.fileName);
    const existingIsRepoScopedFile = existing ? !/^issue-\d+\.json$/.test(existing.fileName) : false;

    if (!existing || (isRepoScopedFile && !existingIsRepoScopedFile)) {
      byIssueKey.set(issue.issueKey, {
        fileName: entry.fileName,
        issue,
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
    completed: issues.filter((issue) => issue.state === "completed" || issue.state === "pr_created").length,
    failed: issues.filter((issue) => issue.state === "failed" || issue.state === "cancelled").length,
    blocked: issues.filter((issue) => issue.state === "blocked" || issue.state === "stuck").length,
    inProgress: issues.filter((issue) => !isTerminalIssueState(issue.state)).length,
    prsCreated: issues.filter((issue) => issue.state === "pr_created" || !!issue.prUrl).length,
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

  const selectedIssuesRaw = Array.isArray(payload.selectedIssues) ? payload.selectedIssues : [];
  const selectedIssues = uniqueIssues(
    selectedIssuesRaw
      .map((item) => normalizeIssueLike(item, targetRepo))
      .filter((item): item is CodingFactoryIntakeIssue => !!item)
      .filter((item) => item.repo === targetRepo),
  );

  const persistedStateHistory = normalizePersistedTransitions<CodingFactoryRunStateName>(payload.stateHistory, isRunState);
  const derivedRunState = deriveRunStateHistory({
    status: typeof payload.status === "string" ? payload.status.trim() : undefined,
    state: isRunState(payload.state) ? payload.state : undefined,
    stateHistory: persistedStateHistory,
    updatedAt: isIsoDate(payload.updatedAt) ? payload.updatedAt : undefined,
    hasSelectedIssues: selectedIssues.length > 0,
  });

  const state = isRunState(payload.state) ? payload.state : derivedRunState.state;
  const stateHistory = persistedStateHistory.length > 0 ? persistedStateHistory : derivedRunState.stateHistory;
  const stateUpdatedAt = coerceTimestamp(payload.stateUpdatedAt, stateHistory[stateHistory.length - 1]?.at, payload.updatedAt);

  const rawStatus = typeof payload.status === "string" ? payload.status.trim() : undefined;
  const status: CodingFactoryRunStatus = ["draft", "running", "completed", "idle", "unknown"].includes(rawStatus || "")
    ? rawStatus as CodingFactoryRunStatus
    : legacyRunStatusFromState(state, { hasSelectedIssues: selectedIssues.length > 0 });

  return {
    version: typeof payload.version === "number" ? Math.max(payload.version, 2) : 2,
    updatedAt: new Date().toISOString(),
    runId,
    mode,
    targetRepo,
    baseBranch,
    selectedIssues: mode === "single" ? selectedIssues.slice(0, 1) : selectedIssues,
    status,
    state,
    stateUpdatedAt,
    stateHistory,
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
  await writeJson(CODING_FACTORY_RUN_PATH, {
    ...nextState,
    status: legacyRunStatusFromState(nextState.state, { hasSelectedIssues: nextState.selectedIssues.length > 0 }),
  });
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
  const fallbackRepo = intake.targetRepo || existingRun.targetRepo || existingRun.selectedIssues[0]?.repo || DEFAULT_TARGET_REPO;
  const selectedIssues = buildLegacyIssueRefs(nightMode, allIssues, existingRun, fallbackRepo);
  const selectedIssueStates = selectIssuesByKey(allIssues, selectedIssues);
  const targetRepo = selectedIssues[0]?.repo || fallbackRepo;

  const inferredMode: CodingFactoryMode = selectedIssues.length > 1 ? "batch" : "single";
  const canonicalState = resolveRunStateFromIssues({
    currentState: nightMode?.state ?? existingRun.state,
    selectedIssueStates: selectedIssueStates.map((issue) => issue.state),
    isNightModeRunning: nightMode?.status === "running",
    finishedAt: nightMode?.finishedAt ?? null,
  });

  const transitionBase = normalizePersistedTransitions<CodingFactoryRunStateName>(nightMode?.stateHistory, isRunState);
  let current = deriveRunStateHistory({
    status: nightMode?.status,
    state: nightMode?.state,
    stateHistory: transitionBase,
    updatedAt: nightMode?.finishedAt ?? nightMode?.startedAt,
    hasSelectedIssues: selectedIssues.length > 0,
  });

  if (current.state !== canonicalState) {
    try {
      current = applyRunTransition(current, {
        to: canonicalState,
        at: nightMode?.finishedAt ?? nightMode?.startedAt ?? new Date().toISOString(),
        source: "derived",
        reason: "legacy-bridge-selected-issues",
      });
    } catch {
      current = {
        state: canonicalState,
        stateHistory: current.stateHistory,
        stateUpdatedAt: coerceTimestamp(nightMode?.finishedAt, nightMode?.startedAt),
      };
    }
  }

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    runId: existingRun.runId.startsWith("cf-") ? existingRun.runId : `cf-${nightMode?.startedAt ?? new Date().toISOString()}`,
    mode: inferredMode,
    targetRepo,
    baseBranch: selectedIssueStates[0]?.baseBranch || existingRun.baseBranch || intake.baseBranch,
    selectedIssues,
    status: legacyRunStatusFromState(current.state, { hasSelectedIssues: selectedIssues.length > 0 }),
    state: current.state,
    stateUpdatedAt: current.stateUpdatedAt,
    stateHistory: current.stateHistory,
  };
}

function finalizeRunState(
  run: CodingFactoryRunState,
  allIssues: IssueState[],
  nightMode: NightModeState | null,
): CodingFactoryRunState {
  const selectedIssueStates = selectIssuesByKey(allIssues, run.selectedIssues);
  const canonicalState = resolveRunStateFromIssues({
    currentState: run.state,
    selectedIssueStates: selectedIssueStates.map((issue) => issue.state),
    isNightModeRunning: nightMode?.status === "running",
    finishedAt: nightMode?.finishedAt ?? null,
  });

  let current = {
    state: run.state,
    stateHistory: [...run.stateHistory],
    stateUpdatedAt: run.stateUpdatedAt,
  };

  if (current.state !== canonicalState) {
    try {
      current = applyRunTransition(current, {
        to: canonicalState,
        at: nightMode?.finishedAt ?? selectedIssueStates[0]?.updatedAt ?? run.updatedAt,
        source: "derived",
        reason: "resolved-from-selected-issues",
      });
    } catch {
      current = {
        state: canonicalState,
        stateHistory: current.stateHistory,
        stateUpdatedAt: coerceTimestamp(nightMode?.finishedAt, selectedIssueStates[0]?.updatedAt, run.updatedAt),
      };
    }
  }

  return {
    ...run,
    updatedAt: new Date().toISOString(),
    status: legacyRunStatusFromState(current.state, { hasSelectedIssues: run.selectedIssues.length > 0 }),
    state: current.state,
    stateUpdatedAt: current.stateUpdatedAt,
    stateHistory: current.stateHistory,
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
      const aTerminal = isTerminalIssueState(a.state) ? 1 : 0;
      const bTerminal = isTerminalIssueState(b.state) ? 1 : 0;
      if (aTerminal !== bTerminal) return aTerminal - bTerminal;

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
      state: issue.state,
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
    state: activeRun.state,
    integrationBranch: nightMode?.integrationBranch ?? null,
    startedAt: nightMode?.startedAt ?? null,
    finishedAt: nightMode?.finishedAt ?? null,
    issues,
    stats: computeStats(issues),
    run,
    activeRun,
    runSource,
    stateMachine: {
      runStates: RUN_STATES,
      issueStates: ISSUE_STATES,
    },
  };
}

export {
  applyIssueTransition,
  applyRunTransition,
  inferIssueStateFromLegacyTopLevel,
};
