import { openSync } from "fs";
import { access, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import {
  CODING_FACTORY_SUPERVISOR_PATH,
  DEFAULT_TARGET_REPO,
  createDraftRunState,
  readIssueStates,
  readRunState,
  readSupervisorHealth,
  readSupervisorState,
  saveRunState,
  selectIssuesByKey,
  writeJson,
  type CodingFactoryIntakeState,
  type CodingFactoryMode,
  type CodingFactoryRunState,
  type CodingFactorySupervisorState,
  type IssueRef,
} from "@/lib/coding-factory";
import { applyRunTransition, isTerminalIssueState } from "@/lib/coding-factory-state-machine";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const LEGACY_NIGHT_MODE_SCRIPT = process.env.CODING_FACTORY_NIGHT_MODE_SCRIPT || "/home/ubuntu/dev-handbook/automation/old_night-mode.sh";
const DEFAULT_LOG_DIR = process.env.CODING_FACTORY_LOG_DIR || "/tmp";
const ALLOWED_TARGET_REPO = process.env.CODING_FACTORY_ALLOWED_REPO || DEFAULT_TARGET_REPO;

export type LaunchSource = "start" | "resume";

export type CodingFactoryLaunchInput = {
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: IssueRef[];
  runId?: string;
  source: LaunchSource;
};

export type CodingFactoryLaunchResult = {
  run: CodingFactoryRunState;
  supervisor: CodingFactorySupervisorState;
};

function validateLaunchInput(input: CodingFactoryLaunchInput): string | null {
  if (!REPO_PATTERN.test(input.targetRepo)) return "Invalid targetRepo (expected owner/repo).";
  if (!BRANCH_PATTERN.test(input.baseBranch)) return "Invalid baseBranch.";
  if (input.targetRepo !== ALLOWED_TARGET_REPO) {
    return `Unsupported targetRepo for v1 launcher: ${input.targetRepo}. Expected ${ALLOWED_TARGET_REPO}.`;
  }
  if (!Array.isArray(input.selectedIssues) || input.selectedIssues.length === 0) {
    return "At least one selected issue is required.";
  }
  if (input.selectedIssues.some((issue) => issue.repo !== input.targetRepo)) {
    return "Selected issues must all belong to the exact targetRepo.";
  }
  return null;
}

async function ensureScriptExists(): Promise<void> {
  await access(LEGACY_NIGHT_MODE_SCRIPT);
}

function buildRunId(): string {
  return `cf-${new Date().toISOString()}`;
}

function buildCommand(input: CodingFactoryLaunchInput): string[] {
  return [
    "bash",
    LEGACY_NIGHT_MODE_SCRIPT,
    ...input.selectedIssues.map((issue) => String(issue.issue)),
    "--base",
    input.baseBranch,
    "--repo",
    input.targetRepo,
  ];
}

function queueAndStartRunState(
  draft: CodingFactoryRunState,
  at: string,
  reason: string,
): CodingFactoryRunState {
  let current = {
    state: draft.state,
    stateHistory: [...draft.stateHistory],
    stateUpdatedAt: draft.stateUpdatedAt,
  };

  if (current.state === "running") {
    try {
      current = applyRunTransition(current, {
        to: "stuck",
        at,
        source: "api",
        reason: `${reason}-stale-running`,
      });
    } catch {
      // keep state history as-is and continue with hard reset below
    }
  }

  if (current.state !== "queued") {
    current = applyRunTransition(current, {
      to: "queued",
      at,
      source: "api",
      reason: `${reason}-queued`,
    });
  }

  current = applyRunTransition(current, {
    to: "running",
    at,
    source: "api",
    reason: `${reason}-running`,
  });

  return {
    ...draft,
    updatedAt: at,
    status: "running",
    state: current.state,
    stateUpdatedAt: current.stateUpdatedAt,
    stateHistory: current.stateHistory,
  };
}

async function spawnDetached(command: string[], logPath: string): Promise<number> {
  await mkdir(DEFAULT_LOG_DIR, { recursive: true });
  const fd = openSync(logPath, "a");
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  child.unref();
  return child.pid ?? 0;
}

async function saveSupervisorState(state: CodingFactorySupervisorState): Promise<CodingFactorySupervisorState> {
  await writeJson(CODING_FACTORY_SUPERVISOR_PATH, state);
  return state;
}

function createSupervisorState(
  input: CodingFactoryLaunchInput,
  run: CodingFactoryRunState,
  pid: number,
  logPath: string,
  command: string[],
): CodingFactorySupervisorState {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: run.runId,
    status: "running",
    source: input.source,
    pid,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    issueKeys: input.selectedIssues.map((issue) => issue.issueKey),
    issueNumbers: input.selectedIssues.map((issue) => issue.issue),
    command,
    logPath,
    startedAt: now,
    updatedAt: now,
  };
}

export async function launchCodingFactoryRun(input: CodingFactoryLaunchInput): Promise<CodingFactoryLaunchResult> {
  const validationError = validateLaunchInput(input);
  if (validationError) throw new Error(validationError);

  await ensureScriptExists();

  const supervisorHealth = await readSupervisorHealth();
  if (supervisorHealth.isHealthy || supervisorHealth.fallbackNightModeProcess) {
    throw new Error("A Coding Factory / Night Mode run is already active. Refusing to launch another run.");
  }

  const now = new Date().toISOString();
  const draftInput: CodingFactoryIntakeState = {
    version: 1,
    updatedAt: now,
    mode: input.mode,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    selectedIssues: input.selectedIssues,
  };

  const currentRun = await readRunState(draftInput);
  const runBase = input.source === "resume"
    ? {
        ...currentRun,
        mode: input.mode,
        targetRepo: input.targetRepo,
        baseBranch: input.baseBranch,
        selectedIssues: input.selectedIssues,
        runId: input.runId || currentRun.runId,
      }
    : {
        ...createDraftRunState(draftInput, "draft"),
        runId: input.runId || buildRunId(),
      };

  const preparedRun = queueAndStartRunState(runBase, now, input.source);
  const command = buildCommand(input);
  const logPath = join(DEFAULT_LOG_DIR, `coding-factory-${preparedRun.runId}.log`);
  const pid = await spawnDetached(command, logPath);

  if (!pid) {
    throw new Error("Failed to start Coding Factory launcher process.");
  }

  const run = await saveRunState(preparedRun, draftInput);
  const supervisor = await saveSupervisorState(createSupervisorState(input, run, pid, logPath, command));
  return { run, supervisor };
}

export async function buildResumeLaunchInput(runId: string): Promise<CodingFactoryLaunchInput> {
  const trimmedRunId = runId.trim();
  if (!trimmedRunId) throw new Error("runId is required for resume.");

  const [run, supervisor, allIssues] = await Promise.all([
    readRunState(),
    readSupervisorState(),
    readIssueStates(),
  ]);

  if (!run.runId || run.runId !== trimmedRunId) {
    throw new Error(`Resume rejected: runId ${trimmedRunId} does not match the persisted run identity.`);
  }

  if (run.selectedIssues.length === 0) {
    throw new Error("Resume rejected: persisted run has no selected issues.");
  }

  if (supervisor && supervisor.status === "running" && supervisor.runId !== trimmedRunId) {
    throw new Error(`Resume rejected: supervisor file belongs to a different run (${supervisor.runId}).`);
  }

  const selectedIssueStates = selectIssuesByKey(allIssues, run.selectedIssues);
  const selectedIssueStateKeys = new Set(selectedIssueStates.map((issue) => issue.issueKey));
  const missingIssueKeys = run.selectedIssues
    .map((issue) => issue.issueKey)
    .filter((issueKey) => !selectedIssueStateKeys.has(issueKey));

  if (missingIssueKeys.length > 0) {
    throw new Error(`Resume rejected: missing exact issue state for ${missingIssueKeys.join(", ")}.`);
  }

  const resumableIssues = selectedIssueStates
    .filter((issue) => !isTerminalIssueState(issue.state) && issue.state !== "pr_created")
    .map((issue) => run.selectedIssues.find((selected) => selected.issueKey === issue.issueKey)!)
    .filter(Boolean);

  if (resumableIssues.length === 0) {
    throw new Error("Resume rejected: no resumable issues remain for this run.");
  }

  return {
    mode: run.mode,
    targetRepo: run.targetRepo,
    baseBranch: run.baseBranch,
    selectedIssues: resumableIssues,
    runId: run.runId,
    source: "resume",
  };
}
