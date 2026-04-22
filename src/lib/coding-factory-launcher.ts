import { openSync } from "fs";
import { access, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import {
  CODING_FACTORY_SUPERVISOR_PATH,
  DEFAULT_TARGET_REPO,
  createDraftRunState,
  deriveDefaultWorkingBranch,
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
import type { CodingFactoryBranchStartMode, CodingFactoryBranchStrategy } from "@/lib/coding-factory/types";
import { applyRunTransition, isTerminalIssueState } from "@/lib/coding-factory-state-machine";
import { resolvePhaseConfig } from "@/lib/coding-factory/config";
import { createCodingFactoryOrchestrator, deriveIntegrationBranchName } from "@/lib/coding-factory-orchestrator";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const LEGACY_NIGHT_MODE_SCRIPT = process.env.CODING_FACTORY_NIGHT_MODE_SCRIPT || "/home/ubuntu/dev-handbook/automation/old_night-mode.sh";
const LEGACY_WEB_SCRIPT =
  process.env.CODING_FACTORY_WEB_SCRIPT ||
  "/home/ubuntu/dev-handbook/automation/work-issue-web.sh";
const DEFAULT_LOG_DIR = process.env.CODING_FACTORY_LOG_DIR || "/tmp";
const DEFAULT_LAUNCH_MODE = "orchestrator" as const;

const ALLOWED_REPOS_RAW =
  process.env.CODING_FACTORY_ALLOWED_REPOS ||
  process.env.CODING_FACTORY_ALLOWED_REPO ||
  DEFAULT_TARGET_REPO;

const ALLOWED_TARGET_REPOS: ReadonlySet<string> = new Set(
  ALLOWED_REPOS_RAW
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean),
);

function getLegacyLauncherScriptPath(targetRepo: string): string {
  if (targetRepo === "Mapletics/App_frontend") {
    return LEGACY_NIGHT_MODE_SCRIPT;
  }

  return LEGACY_WEB_SCRIPT;
}

export function getAllowedTargetRepos(): string[] {
  return [...ALLOWED_TARGET_REPOS];
}

export type LaunchSource = "start" | "resume";

export type CodingFactoryLaunchInput = {
  mode: CodingFactoryMode;
  targetRepo: string;
  baseBranch: string;
  branchStrategy: CodingFactoryBranchStrategy;
  workingBranch: string;
  branchStartMode: CodingFactoryBranchStartMode;
  selectedIssues: IssueRef[];
  launchIssues?: IssueRef[];
  runId?: string;
  source: LaunchSource;
};

export type CodingFactoryLaunchResult = {
  run: CodingFactoryRunState;
  supervisor: CodingFactorySupervisorState;
};

function getLaunchIssues(input: CodingFactoryLaunchInput): IssueRef[] {
  return input.launchIssues ?? input.selectedIssues;
}

function validateLaunchInput(input: CodingFactoryLaunchInput): string | null {
  if (!REPO_PATTERN.test(input.targetRepo)) return "Invalid targetRepo (expected owner/repo).";
  if (!BRANCH_PATTERN.test(input.baseBranch)) return "Invalid baseBranch.";
  if (!["shared", "isolated"].includes(input.branchStrategy)) return "Invalid branchStrategy.";
  if (!BRANCH_PATTERN.test(input.workingBranch)) return "Invalid workingBranch.";
  if (!["existing", "create-from-base"].includes(input.branchStartMode)) return "Invalid branchStartMode.";
  if (!ALLOWED_TARGET_REPOS.has(input.targetRepo)) {
    const allowedRepos = [...ALLOWED_TARGET_REPOS].join(", ");
    return `Unsupported targetRepo: ${input.targetRepo}. Allowed repos: ${allowedRepos}.`;
  }
  if (!Array.isArray(input.selectedIssues) || input.selectedIssues.length === 0) {
    return "At least one selected issue is required.";
  }
  const launchIssues = getLaunchIssues(input);
  if (!Array.isArray(launchIssues) || launchIssues.length === 0) {
    return "At least one launch issue is required.";
  }
  if (input.selectedIssues.some((issue) => issue.repo !== input.targetRepo) || launchIssues.some((issue) => issue.repo !== input.targetRepo)) {
    return "Selected issues must all belong to the exact targetRepo.";
  }
  const selectedIssueKeys = new Set(input.selectedIssues.map((issue) => issue.issueKey));
  if (launchIssues.some((issue) => !selectedIssueKeys.has(issue.issueKey))) {
    return "Launch issues must be a subset of the persisted run selection.";
  }
  return null;
}

async function ensureLegacyScriptExists(targetRepo: string): Promise<void> {
  const scriptPath = getLegacyLauncherScriptPath(targetRepo);
  try {
    await access(scriptPath);
  } catch {
    throw new Error(
      `Legacy launcher adapter script not found for repo "${targetRepo}": ${scriptPath}. ` +
      `Check CODING_FACTORY_NIGHT_MODE_SCRIPT or CODING_FACTORY_WEB_SCRIPT.`,
    );
  }
}

async function ensureV2OrchestratorRuntimeExists(): Promise<void> {
  await Promise.all([
    access(join(process.cwd(), "src/lib/coding-factory-orchestrator-worker.ts")),
    access(join(process.cwd(), "node_modules/jiti/lib/jiti-cli.mjs")),
    access(join(process.cwd(), "node_modules/tsconfig-paths/register.js")),
  ]);
}

function buildRunId(): string {
  return `cf-${new Date().toISOString()}`;
}

function buildLegacyAdapterCommand(input: CodingFactoryLaunchInput): string[] {
  const scriptPath = getLegacyLauncherScriptPath(input.targetRepo);
  return [
    "bash",
    scriptPath,
    ...getLaunchIssues(input).map((issue) => String(issue.issue)),
    "--base",
    input.baseBranch,
    "--repo",
    input.targetRepo,
  ];
}

function buildOrchestratorCommand(): string[] {
  return [
    "node",
    "-r",
    join(process.cwd(), "node_modules/tsconfig-paths/register.js"),
    join(process.cwd(), "node_modules/jiti/lib/jiti-cli.mjs"),
    join(process.cwd(), "src/lib/coding-factory-orchestrator-worker.ts"),
  ];
}

function queueRunState(
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

  return {
    ...draft,
    updatedAt: at,
    status: "draft",
    state: current.state,
    stateUpdatedAt: current.stateUpdatedAt,
    stateHistory: current.stateHistory,
  };
}

function markRunRunning(
  draft: CodingFactoryRunState,
  at: string,
  reason: string,
): CodingFactoryRunState {
  const current = applyRunTransition({
    state: draft.state,
    stateHistory: [...draft.stateHistory],
    stateUpdatedAt: draft.stateUpdatedAt,
  }, {
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

function buildLauncherEnv(targetRepo: string, envelopeJson: string): NodeJS.ProcessEnv {
  const phaseConfigs = {
    research: resolvePhaseConfig(targetRepo, "research"),
    plan: resolvePhaseConfig(targetRepo, "plan"),
    implement: resolvePhaseConfig(targetRepo, "implement"),
    review: resolvePhaseConfig(targetRepo, "review"),
    fixAnalyze: resolvePhaseConfig(targetRepo, "fixAnalyze"),
    fixTests: resolvePhaseConfig(targetRepo, "fixTests"),
    pr: resolvePhaseConfig(targetRepo, "pr"),
  } as const;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    CODING_FACTORY_LAUNCH_ENVELOPE: envelopeJson,
    CODING_FACTORY_LAUNCH_MODE: DEFAULT_LAUNCH_MODE,
  };

  for (const [phase, config] of Object.entries(phaseConfigs)) {
    const prefix = `CF_${phase.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
    env[`${prefix}_BACKEND`] = config.backend;
    if (config.model) env[`${prefix}_MODEL`] = config.model;
    if (config.agentId) env[`${prefix}_AGENT`] = config.agentId;
  }

  return env;
}

async function spawnDetached(command: string[], logPath: string, env: NodeJS.ProcessEnv): Promise<number> {
  await mkdir(DEFAULT_LOG_DIR, { recursive: true });
  const fd = openSync(logPath, "a");
  const child = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
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
  const launchIssues = getLaunchIssues(input);
  return {
    version: 2,
    runId: run.runId,
    status: "running",
    source: input.source,
    pid,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    branchStrategy: input.branchStrategy,
    workingBranch: input.workingBranch,
    issueKeys: launchIssues.map((issue) => issue.issueKey),
    issueNumbers: launchIssues.map((issue) => issue.issue),
    selectedIssues: launchIssues,
    command,
    logPath,
    currentIssueKey: null,
    currentPhase: null,
    startedAt: now,
    updatedAt: now,
  };
}

async function cleanupSpawnedProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // best-effort cleanup only
  }
}

export async function launchCodingFactoryRun(input: CodingFactoryLaunchInput): Promise<CodingFactoryLaunchResult> {
  const validationError = validateLaunchInput(input);
  if (validationError) throw new Error(validationError);

  if (DEFAULT_LAUNCH_MODE === "orchestrator") {
    await ensureV2OrchestratorRuntimeExists();
  } else {
    await ensureLegacyScriptExists(input.targetRepo);
  }

  const supervisorHealth = await readSupervisorHealth();
  if (supervisorHealth.isHealthy || supervisorHealth.fallbackNightModeProcess) {
    throw new Error("A Coding Factory / Night Mode run is already active. Refusing to launch another run.");
  }

  const now = new Date().toISOString();
  const draftInput: CodingFactoryIntakeState = {
    version: 2,
    updatedAt: now,
    mode: input.mode,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    branchStrategy: input.branchStrategy,
    workingBranch: input.workingBranch,
    branchStartMode: input.branchStartMode,
    selectedIssues: input.selectedIssues,
  };

  const currentRun = await readRunState(draftInput);
  const resolvedRunId = input.runId || (input.source === "resume" ? currentRun.runId : buildRunId());
  const resolvedIntegrationBranch = input.branchStrategy === "isolated"
    ? (currentRun.integrationBranch || deriveIntegrationBranchName(resolvedRunId))
    : null;
  const runBase = input.source === "resume"
    ? {
        ...currentRun,
        mode: input.mode,
        targetRepo: input.targetRepo,
        baseBranch: input.baseBranch,
        branchStrategy: input.branchStrategy,
        workingBranch: input.workingBranch,
        branchStartMode: input.branchStartMode,
        integrationBranch: resolvedIntegrationBranch,
        selectedIssues: input.selectedIssues,
        runId: resolvedRunId,
      }
    : {
        ...createDraftRunState(draftInput, "draft"),
        runId: resolvedRunId,
        branchStrategy: input.branchStrategy,
        workingBranch: input.workingBranch,
        branchStartMode: input.branchStartMode,
        integrationBranch: resolvedIntegrationBranch,
      };

  const queuedRun = await saveRunState(queueRunState(runBase, now, input.source), draftInput);
  const orchestrator = createCodingFactoryOrchestrator({
    runId: queuedRun.runId,
    targetRepo: input.targetRepo,
    baseBranch: input.baseBranch,
    branchStrategy: input.branchStrategy,
    workingBranch: input.workingBranch,
    branchStartMode: input.branchStartMode,
    integrationBranch: queuedRun.integrationBranch || resolvedIntegrationBranch || undefined,
    selectedIssues: getLaunchIssues(input).map((issue) => ({
      issue: issue.issue,
      issueKey: issue.issueKey,
      title: issue.title,
    })),
    launchMode: DEFAULT_LAUNCH_MODE,
  });
  const envelope = orchestrator.createLaunchEnvelope();
  const command = DEFAULT_LAUNCH_MODE === "orchestrator"
    ? buildOrchestratorCommand()
    : buildLegacyAdapterCommand(input);
  const logPath = join(DEFAULT_LOG_DIR, `coding-factory-${queuedRun.runId}.log`);
  const pid = await spawnDetached(command, logPath, buildLauncherEnv(input.targetRepo, JSON.stringify(envelope)));

  if (!pid) {
    throw new Error("Failed to start Coding Factory launcher process.");
  }

  let persistedRun = queuedRun;

  try {
    persistedRun = await saveRunState(markRunRunning(queuedRun, now, input.source), draftInput);
    const supervisor = await saveSupervisorState(createSupervisorState(input, persistedRun, pid, logPath, command));
    return { run: persistedRun, supervisor };
  } catch (error) {
    await cleanupSpawnedProcess(pid);

    try {
      const stuckRun = applyRunTransition({
        state: persistedRun.state,
        stateHistory: [...persistedRun.stateHistory],
        stateUpdatedAt: persistedRun.stateUpdatedAt,
      }, {
        to: "stuck",
        at: new Date().toISOString(),
        source: "api",
        reason: `${input.source}-launch-persist-failed`,
      });

      await saveRunState({
        ...persistedRun,
        updatedAt: new Date().toISOString(),
        status: "unknown",
        state: stuckRun.state,
        stateUpdatedAt: stuckRun.stateUpdatedAt,
        stateHistory: stuckRun.stateHistory,
      }, draftInput);
    } catch {
      // best-effort state repair only
    }

    throw error;
  }
}

function resolveResumePhase(issue: { execution?: { resumeFromPhase?: string | null; phases?: Record<string, { status?: string }> } | undefined; state: string }): string | null {
  const resumeFromPhase = issue.execution?.resumeFromPhase;
  if (
    resumeFromPhase === "research"
    || resumeFromPhase === "plan"
    || resumeFromPhase === "implement"
    || resumeFromPhase === "review"
    || resumeFromPhase === "fixAnalyze"
    || resumeFromPhase === "fixTests"
    || resumeFromPhase === "pr"
  ) {
    return resumeFromPhase;
  }

  const phases = issue.execution?.phases ?? {};
  if (phases.pr?.status === "completed") return null;
  if (phases.pr?.status === "running") return "pr";
  if (phases.review?.status === "completed") return "pr";
  if (phases.review?.status === "running") return "review";
  if (phases.fixTests?.status === "completed") return "review";
  if (phases.fixTests?.status === "running") return "fixTests";
  if (phases.fixAnalyze?.status === "completed") return "fixTests";
  if (phases.fixAnalyze?.status === "running") return "fixAnalyze";
  if (phases.implement?.status === "completed") return "review";
  if (phases.implement?.status === "running") return "implement";
  if (phases.plan?.status === "completed") return "implement";
  if (phases.plan?.status === "running") return "plan";
  if (phases.research?.status === "completed") return "plan";
  if (phases.research?.status === "running") return "research";
  return "research";
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
    .filter((issue) => resolveResumePhase(issue) !== null)
    .map((issue) => run.selectedIssues.find((selected) => selected.issueKey === issue.issueKey)!)
    .filter(Boolean);

  if (resumableIssues.length === 0) {
    throw new Error("Resume rejected: no resumable issues remain for this run.");
  }

  return {
    mode: run.mode,
    targetRepo: run.targetRepo,
    baseBranch: run.baseBranch,
    branchStrategy: run.branchStrategy,
    workingBranch: run.workingBranch || deriveDefaultWorkingBranch(run.baseBranch),
    branchStartMode: run.branchStartMode,
    selectedIssues: run.selectedIssues,
    launchIssues: resumableIssues,
    runId: run.runId,
    source: "resume",
  };
}
