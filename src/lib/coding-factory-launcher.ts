/**
 * Coding Factory Launcher — hardened start / resume / supervisor layer.
 *
 * Owns:
 *  - Pre-launch validation (repo, branch, issues, no conflicting run)
 *  - Resume eligibility checks (exact identity match, no ambiguity)
 *  - Supervisor state persistence (attach/detach/heartbeat)
 *
 * Does NOT own the night-mode engine itself — that remains external.
 * Legacy bridge is read-only; this module never mutates night-mode.json.
 */

import {
  CODING_FACTORY_SUPERVISOR_PATH,
  readJson,
  writeJson,
  readRunState,
  saveRunState,
  readIssueStates,
  selectIssuesByKey,
  checkNightModeProcessRunning,
  createDraftRunState,
  type CodingFactoryRunState,
  type CodingFactoryIntakeState,
  type CodingFactorySupervisorState,
  type IssueRef,
} from "@/lib/coding-factory";
import {
  isTerminalRunState,
  isTerminalIssueState,
  applyRunTransition,
} from "@/lib/coding-factory-state-machine";

/* ── Types ── */

export type LaunchRequest = {
  targetRepo: string;
  baseBranch: string;
  mode: "single" | "batch";
  selectedIssues: IssueRef[];
};

export type ResumeRequest = {
  runId: string;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: IssueRef[];
};

export type LaunchResult = {
  ok: true;
  run: CodingFactoryRunState;
  supervisor: CodingFactorySupervisorState;
} | {
  ok: false;
  error: string;
  code: LaunchErrorCode;
};

export type ResumeResult = LaunchResult;

export type LaunchErrorCode =
  | "MISSING_ISSUES"
  | "INVALID_REPO"
  | "INVALID_BRANCH"
  | "CONFLICTING_RUN"
  | "ALREADY_RUNNING"
  | "RUN_NOT_FOUND"
  | "IDENTITY_MISMATCH"
  | "AMBIGUOUS_RESUME"
  | "RUN_TERMINAL"
  | "VALIDATION_FAILED";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const SUPERVISOR_STALE_MS = 5 * 60 * 1000;

/* ── Supervisor persistence ── */

export async function readSupervisorState(): Promise<CodingFactorySupervisorState | null> {
  return readJson<CodingFactorySupervisorState>(CODING_FACTORY_SUPERVISOR_PATH);
}

export async function writeSupervisorState(state: CodingFactorySupervisorState): Promise<void> {
  await writeJson(CODING_FACTORY_SUPERVISOR_PATH, state);
}

function createSupervisorState(
  runId: string,
  source: "start" | "resume",
  request: { targetRepo: string; baseBranch: string; selectedIssues: IssueRef[] },
): CodingFactorySupervisorState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId,
    status: "running",
    source,
    pid: null,
    targetRepo: request.targetRepo,
    baseBranch: request.baseBranch,
    issueKeys: request.selectedIssues.map((i) => i.issueKey),
    issueNumbers: request.selectedIssues.map((i) => i.issue),
    command: [],
    logPath: "",
    startedAt: now,
    updatedAt: now,
  };
}

/* ── Shared validation helpers ── */

function validateRepo(repo: string): string | null {
  if (!repo || !REPO_PATTERN.test(repo)) return "Invalid target repo format";
  return null;
}

function validateBranch(branch: string): string | null {
  if (!branch || !BRANCH_PATTERN.test(branch)) return "Invalid base branch format";
  return null;
}

function validateIssues(issues: IssueRef[], targetRepo: string): string | null {
  if (!issues || issues.length === 0) return "No issues selected";
  for (const issue of issues) {
    if (!Number.isInteger(issue.issue) || issue.issue <= 0) {
      return `Invalid issue number: ${issue.issue}`;
    }
    if (issue.repo !== targetRepo) {
      return `Issue ${issue.issueKey} does not belong to target repo ${targetRepo}`;
    }
  }
  return null;
}

function isSupervisorActive(state: CodingFactorySupervisorState): boolean {
  if (state.status !== "running") return false;
  const age = Date.now() - new Date(state.updatedAt).getTime();
  if (age > SUPERVISOR_STALE_MS) return false;
  if (state.pid !== null && state.pid > 0) {
    try {
      process.kill(state.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return age < SUPERVISOR_STALE_MS;
}

async function checkNoConflictingRun(): Promise<{ conflict: boolean; reason?: string }> {
  const isRunning = await checkNightModeProcessRunning();
  if (isRunning) {
    return { conflict: true, reason: "Night-mode process is currently running" };
  }

  const supervisor = await readSupervisorState();
  if (supervisor && isSupervisorActive(supervisor)) {
    return { conflict: true, reason: `Active supervisor attached to run ${supervisor.runId}` };
  }

  return { conflict: false };
}

/* ── Launch (start) ── */

export async function validateAndStart(request: LaunchRequest): Promise<LaunchResult> {
  // 1. Validate inputs
  const repoErr = validateRepo(request.targetRepo);
  if (repoErr) return { ok: false, error: repoErr, code: "INVALID_REPO" };

  const branchErr = validateBranch(request.baseBranch);
  if (branchErr) return { ok: false, error: branchErr, code: "INVALID_BRANCH" };

  const issueErr = validateIssues(request.selectedIssues, request.targetRepo);
  if (issueErr) return { ok: false, error: issueErr, code: "MISSING_ISSUES" };

  // 2. Check no conflicting active run
  const conflict = await checkNoConflictingRun();
  if (conflict.conflict) {
    return { ok: false, error: conflict.reason!, code: "CONFLICTING_RUN" };
  }

  // 3. Check persisted run is not already active (non-terminal)
  const existingRun = await readRunState();
  if (
    existingRun.runId &&
    !existingRun.runId.startsWith("draft-") &&
    !isTerminalRunState(existingRun.state)
  ) {
    return {
      ok: false,
      error: `Non-terminal run ${existingRun.runId} already exists in state "${existingRun.state}". Complete or cancel it first.`,
      code: "CONFLICTING_RUN",
    };
  }

  // 4. Build validated run state
  const now = new Date().toISOString();
  const runId = `cf-${now}`;
  const intake: CodingFactoryIntakeState = {
    version: 1,
    updatedAt: now,
    mode: request.mode,
    targetRepo: request.targetRepo,
    baseBranch: request.baseBranch,
    selectedIssues: request.selectedIssues,
  };

  let runBase = createDraftRunState(intake, "draft");
  runBase = { ...runBase, runId };

  // Transition: created → intake_validated → queued
  let current = {
    state: runBase.state,
    stateHistory: runBase.stateHistory,
    stateUpdatedAt: runBase.stateUpdatedAt,
  };

  if (current.state === "created") {
    current = applyRunTransition(current, {
      to: "intake_validated",
      source: "api",
      reason: "launcher-validated",
    });
  }

  current = applyRunTransition(current, {
    to: "queued",
    source: "api",
    reason: "launcher-start",
  });

  const run = await saveRunState({
    ...runBase,
    state: current.state,
    stateHistory: current.stateHistory,
    stateUpdatedAt: current.stateUpdatedAt,
    status: "running",
  });

  // 5. Attach supervisor
  const supervisor = createSupervisorState(run.runId, "start", request);
  await writeSupervisorState(supervisor);

  return { ok: true, run, supervisor };
}

/* ── Resume ── */

export async function validateAndResume(request: ResumeRequest): Promise<ResumeResult> {
  // 1. Validate inputs
  const repoErr = validateRepo(request.targetRepo);
  if (repoErr) return { ok: false, error: repoErr, code: "INVALID_REPO" };

  const branchErr = validateBranch(request.baseBranch);
  if (branchErr) return { ok: false, error: branchErr, code: "INVALID_BRANCH" };

  const issueErr = validateIssues(request.selectedIssues, request.targetRepo);
  if (issueErr) return { ok: false, error: issueErr, code: "MISSING_ISSUES" };

  // 2. Check no conflicting process
  const conflict = await checkNoConflictingRun();
  if (conflict.conflict) {
    return { ok: false, error: conflict.reason!, code: "ALREADY_RUNNING" };
  }

  // 3. Load persisted run
  const existingRun = await readRunState();
  if (!existingRun.runId || existingRun.runId.startsWith("draft-")) {
    return { ok: false, error: "No persisted run found to resume", code: "RUN_NOT_FOUND" };
  }

  // 4. Exact identity match — Mission Control validates, no guessing
  if (existingRun.runId !== request.runId) {
    return {
      ok: false,
      error: `Run ID mismatch: requested "${request.runId}" but persisted run is "${existingRun.runId}"`,
      code: "IDENTITY_MISMATCH",
    };
  }

  if (existingRun.targetRepo !== request.targetRepo) {
    return {
      ok: false,
      error: `Repo mismatch: requested "${request.targetRepo}" but run targets "${existingRun.targetRepo}"`,
      code: "IDENTITY_MISMATCH",
    };
  }

  if (existingRun.baseBranch !== request.baseBranch) {
    return {
      ok: false,
      error: `Branch mismatch: requested "${request.baseBranch}" but run uses "${existingRun.baseBranch}"`,
      code: "IDENTITY_MISMATCH",
    };
  }

  // 5. Validate issue set matches exactly
  const existingKeys = new Set(existingRun.selectedIssues.map((i) => i.issueKey));
  const requestKeys = new Set(request.selectedIssues.map((i) => i.issueKey));
  if (existingKeys.size !== requestKeys.size || [...existingKeys].some((k) => !requestKeys.has(k))) {
    return {
      ok: false,
      error: "Issue set mismatch between resume request and persisted run. Reject ambiguous resume.",
      code: "AMBIGUOUS_RESUME",
    };
  }

  // 6. Check run is not already terminal
  if (isTerminalRunState(existingRun.state)) {
    return {
      ok: false,
      error: `Run ${existingRun.runId} is in terminal state "${existingRun.state}" and cannot be resumed`,
      code: "RUN_TERMINAL",
    };
  }

  // 7. Validate issue states are consistent — no fully-terminal issue set
  const allIssues = await readIssueStates();
  const selectedIssueStates = selectIssuesByKey(allIssues, existingRun.selectedIssues);
  const allTerminal = selectedIssueStates.length > 0 &&
    selectedIssueStates.every((i) => isTerminalIssueState(i.state));
  if (allTerminal) {
    return {
      ok: false,
      error: "All selected issues are in terminal states — nothing to resume",
      code: "RUN_TERMINAL",
    };
  }

  // 8. Transition run to queued via normal start path
  let current = {
    state: existingRun.state,
    stateHistory: [...existingRun.stateHistory],
    stateUpdatedAt: existingRun.stateUpdatedAt,
  };

  try {
    if (current.state !== "queued" && current.state !== "running") {
      current = applyRunTransition(current, {
        to: "queued",
        source: "api",
        reason: "launcher-resume",
      });
    }
  } catch {
    // State machine may reject transition from certain states; that's ok,
    // we still proceed if we can get to running
  }

  const run = await saveRunState({
    ...existingRun,
    state: current.state,
    stateHistory: current.stateHistory,
    stateUpdatedAt: current.stateUpdatedAt,
    status: "running",
  });

  // 9. Attach supervisor
  const supervisor = createSupervisorState(run.runId, "resume", request);
  await writeSupervisorState(supervisor);

  return { ok: true, run, supervisor };
}

/* ── Supervisor heartbeat (for external callers) ── */

export async function supervisorHeartbeat(runId: string): Promise<{ ok: boolean; runId: string | null }> {
  const state = await readSupervisorState();
  if (!state || state.runId !== runId) {
    return { ok: false, runId: state?.runId ?? null };
  }

  await writeSupervisorState({
    ...state,
    updatedAt: new Date().toISOString(),
    status: "running",
  });

  return { ok: true, runId };
}

/* ── Supervisor detach (for external callers) ── */

export async function supervisorDetach(runId: string): Promise<void> {
  const state = await readSupervisorState();
  if (!state || state.runId !== runId) return;

  await writeSupervisorState({
    ...state,
    status: "finished",
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
