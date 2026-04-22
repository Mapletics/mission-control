import { execFile } from "child_process";
import { copyFile, mkdir, access } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import {
  CODING_FACTORY_SUPERVISOR_PATH,
  readIssueStates,
  readRunState,
  readSupervisorState,
  saveIssueState,
  saveRunState,
  selectIssuesByKey,
  writeJson,
  type CodingFactoryIntakeState,
  type CodingFactoryRunState,
  type IssueRef,
} from "@/lib/coding-factory";
import { getIssueArtifactSet } from "@/lib/coding-factory/artifacts";
import { buildFixAnalyzeRequest } from "@/lib/coding-factory/phases/fix-analyze";
import { buildFixTestsRequest } from "@/lib/coding-factory/phases/fix-tests";
import { buildImplementRequest } from "@/lib/coding-factory/phases/implement";
import { buildPlanRequest } from "@/lib/coding-factory/phases/plan";
import { buildPrRequest } from "@/lib/coding-factory/phases/pr";
import { buildResearchRequest } from "@/lib/coding-factory/phases/research";
import { buildReviewRequest } from "@/lib/coding-factory/phases/review";
import {
  createCodingFactoryOrchestrator,
  createEmptyIssueExecutionV2,
  createEmptyRunExecutionV2,
  resolveNextPhase,
  resolvePhaseTransition,
  type CodingFactoryOrchestratorLaunchEnvelope,
} from "@/lib/coding-factory-orchestrator";
import { applyIssueTransition, isCompletedIssueState } from "@/lib/coding-factory-state-machine";
import type {
  CodingFactoryIssueExecutionV2,
  CodingFactoryPhase,
  CodingFactoryPhaseExecutionRecord,
  CodingFactoryRunExecutionV2,
  PhaseRunResult,
} from "@/lib/coding-factory/types";
import { resolveCodingFactoryRepoPath } from "@/lib/paths";

const SUPPORTED_PHASES: CodingFactoryPhase[] = ["research", "plan", "implement", "review", "fixAnalyze", "fixTests", "pr"];
const CODE_PHASES = new Set<CodingFactoryPhase>(["implement", "review", "fixAnalyze", "fixTests", "pr"]);

const execFileAsync = promisify(execFile);

type QueueCounts = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
};

type IssuePersistencePatch = {
  branch?: string | null;
  branchCreated?: boolean;
  branchMode?: "shared" | "isolated";
  workingBranch?: string | null;
  worktree?: string | null;
  prUrl?: string | null;
  summary?: string;
  nextAction?: string;
  changedFiles?: string[];
  issueStartSha?: string;
  issueEndSha?: string;
  issueDiffBaseSha?: string;
  commitSha?: string;
  commitMessage?: string;
};

type IssueWorkspace = {
  branch: string;
  branchStrategy: "shared" | "isolated";
  worktreePath?: string;
  remoteBranchExists: boolean;
};

type PullRequestResult = {
  prUrl: string;
  prNumber: number | null;
  changedFiles: string[];
  merged: boolean;
};

type FinalPullRequestResult = {
  prUrl: string | null;
  prNumber: number | null;
  state: string | null;
};

type SharedIssueCommitResult = {
  issueStartSha: string;
  issueEndSha: string;
  issueDiffBaseSha: string;
  commitSha: string | null;
  commitMessage: string | null;
  changedFiles: string[];
};

function parseEnvelope(): CodingFactoryOrchestratorLaunchEnvelope {
  const raw = process.env.CODING_FACTORY_LAUNCH_ENVELOPE;
  if (!raw) throw new Error("Missing CODING_FACTORY_LAUNCH_ENVELOPE.");
  return JSON.parse(raw) as CodingFactoryOrchestratorLaunchEnvelope;
}

function nowIso(): string {
  return new Date().toISOString();
}

function deriveIssueBranchName(issueNumber: number, issueTitle: string): string {
  const slug = issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug ? `issue-${issueNumber}-${slug}` : `issue-${issueNumber}`;
}

function getIssueWorktreePath(issueNumber: number, repoSlug: string): string {
  return join(getIssueArtifactSet(issueNumber, repoSlug).rootDir, "worktree");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatExecError(error: unknown, command: string[], cwd: string): Error {
  const payload = error as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
  const stdout = typeof payload?.stdout === "string"
    ? payload.stdout.trim()
    : Buffer.isBuffer(payload?.stdout)
      ? payload.stdout.toString("utf-8").trim()
      : "";
  const stderr = typeof payload?.stderr === "string"
    ? payload.stderr.trim()
    : Buffer.isBuffer(payload?.stderr)
      ? payload.stderr.toString("utf-8").trim()
      : "";
  const details = [payload?.message, stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
    .filter(Boolean)
    .join(" | ");
  return new Error(`Command failed in ${cwd}: ${command.join(" ")} :: ${details || "unknown error"}`);
}

async function runCommand(command: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command[0], command.slice(1), {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw formatExecError(error, command, cwd);
  }
}

async function tryRunCommand(command: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  try {
    return {
      ok: true,
      stdout: await runCommand(command, cwd),
    };
  } catch {
    return {
      ok: false,
      stdout: "",
    };
  }
}

function parsePrNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)(?:$|[?#])/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function ensureCleanWorkingTree(repoPath: string): Promise<void> {
  const status = await runCommand(["git", "status", "--porcelain"], repoPath);
  if (status.trim()) {
    throw new Error(`Repository ${repoPath} has uncommitted changes. Commit/stash them before starting Coding Factory.`);
  }
}

async function getHeadSha(repoPath: string): Promise<string> {
  return runCommand(["git", "rev-parse", "HEAD"], repoPath);
}

async function ensureSharedBranchWorkspace(input: {
  repoPath: string;
  baseBranch: string;
  workingBranch: string;
  branchStartMode: "existing" | "create-from-base";
}): Promise<IssueWorkspace> {
  await ensureCleanWorkingTree(input.repoPath);
  await runCommand(["git", "fetch", "origin", input.baseBranch], input.repoPath);

  const localExists = (await tryRunCommand(["git", "show-ref", "--verify", `refs/heads/${input.workingBranch}`], input.repoPath)).ok;
  const remoteExists = (await tryRunCommand(["git", "ls-remote", "--exit-code", "--heads", "origin", input.workingBranch], input.repoPath)).ok;

  if (input.branchStartMode === "existing") {
    if (remoteExists) {
      await runCommand(["git", "fetch", "origin", `${input.workingBranch}:${input.workingBranch}`], input.repoPath);
    } else if (!localExists) {
      throw new Error(`Working branch ${input.workingBranch} does not exist locally or on origin. Choose create-from-base or create the branch first.`);
    }

    if (localExists || remoteExists) {
      await runCommand(["git", "switch", input.workingBranch], input.repoPath);
    }
    if (remoteExists) {
      await runCommand(["git", "reset", "--hard", `origin/${input.workingBranch}`], input.repoPath);
    }
  } else {
    if (remoteExists) {
      throw new Error(`Working branch ${input.workingBranch} already exists on origin. Use existing mode or choose a new working branch.`);
    }
    await runCommand(["git", "switch", "-C", input.workingBranch, `origin/${input.baseBranch}`], input.repoPath);
  }

  await ensureCleanWorkingTree(input.repoPath);

  return {
    branch: input.workingBranch,
    branchStrategy: "shared",
    worktreePath: undefined,
    remoteBranchExists: remoteExists,
  };
}

async function ensureIntegrationBranch(input: {
  repoPath: string;
  baseBranch: string;
  integrationBranch: string;
}): Promise<void> {
  await runCommand(["git", "fetch", "origin", input.baseBranch], input.repoPath);

  const remoteExists = (await tryRunCommand([
    "git",
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    input.integrationBranch,
  ], input.repoPath)).ok;

  if (remoteExists) {
    await runCommand(["git", "fetch", "origin", `${input.integrationBranch}:${input.integrationBranch}`], input.repoPath);
    await runCommand(["git", "branch", "-f", input.integrationBranch, `origin/${input.integrationBranch}`], input.repoPath);
    return;
  }

  const localExists = (await tryRunCommand(["git", "show-ref", "--verify", `refs/heads/${input.integrationBranch}`], input.repoPath)).ok;
  if (localExists) {
    await runCommand(["git", "branch", "-f", input.integrationBranch, `origin/${input.baseBranch}`], input.repoPath);
  } else {
    await runCommand(["git", "branch", input.integrationBranch, `origin/${input.baseBranch}`], input.repoPath);
  }

  await runCommand(["git", "push", "--set-upstream", "origin", `${input.integrationBranch}:${input.integrationBranch}`], input.repoPath);
}

async function ensureIssueWorkspace(input: {
  issueNumber: number;
  issueTitle: string;
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
  integrationBranch: string;
}): Promise<IssueWorkspace> {
  const branch = deriveIssueBranchName(input.issueNumber, input.issueTitle);
  const worktreePath = getIssueWorktreePath(input.issueNumber, input.repoSlug);
  const worktreeGitPath = join(worktreePath, ".git");

  await mkdir(dirname(worktreePath), { recursive: true });
  await runCommand(["git", "fetch", "origin", input.integrationBranch], input.repoPath);

  if (!await pathExists(worktreeGitPath)) {
    const localBranchExists = (await tryRunCommand(["git", "show-ref", "--verify", `refs/heads/${branch}`], input.repoPath)).ok;
    if (localBranchExists) {
      await runCommand(["git", "worktree", "add", worktreePath, branch], input.repoPath);
    } else {
      const remoteBranchExists = (await tryRunCommand(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], input.repoPath)).ok;
      if (remoteBranchExists) {
        await runCommand(["git", "fetch", "origin", `${branch}:${branch}`], input.repoPath);
        await runCommand(["git", "worktree", "add", worktreePath, branch], input.repoPath);
      } else {
        await runCommand(["git", "worktree", "add", "-b", branch, worktreePath, `origin/${input.integrationBranch}`], input.repoPath);
      }
    }
  }

  const currentBranch = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  if (currentBranch !== branch) {
    await runCommand(["git", "switch", branch], worktreePath);
  }

  await runCommand(["git", "push", "--set-upstream", "origin", branch], worktreePath);
  const remoteBranchExists = (await tryRunCommand(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], worktreePath)).ok;

  return {
    branch,
    branchStrategy: "isolated",
    worktreePath,
    remoteBranchExists,
  };
}

async function ensurePullRequest(input: {
  issueNumber: number;
  issueTitle: string;
  repoSlug: string;
  baseBranch: string;
  integrationBranch: string;
  branch: string;
  worktreePath: string;
  prFile: string;
}): Promise<PullRequestResult> {
  await runCommand(["git", "fetch", "origin", input.integrationBranch], input.worktreePath);

  const status = await runCommand(["git", "status", "--porcelain"], input.worktreePath);
  if (status.trim()) {
    await runCommand(["git", "add", "-A"], input.worktreePath);
    await runCommand(["git", "commit", "-m", `fix(issue-${input.issueNumber}): ${input.issueTitle}`], input.worktreePath);
  }

  await runCommand(["git", "push", "--set-upstream", "origin", input.branch], input.worktreePath);

  const aheadBehind = await runCommand(["git", "rev-list", "--left-right", "--count", `origin/${input.integrationBranch}...HEAD`], input.worktreePath);
  const [, aheadRaw = "0"] = aheadBehind.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw, 10);
  if (!Number.isFinite(ahead) || ahead <= 0) {
    throw new Error(`Issue branch ${input.branch} is not ahead of origin/${input.integrationBranch}; refusing PR creation.`);
  }

  const changedFilesOutput = await runCommand(["git", "diff", "--name-only", `origin/${input.integrationBranch}...HEAD`], input.worktreePath);
  const changedFiles = changedFilesOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const existingPr = await tryRunCommand([
    "gh",
    "pr",
    "view",
    input.branch,
    "--repo",
    input.repoSlug,
    "--json",
    "url,number,state,baseRefName,mergedAt",
  ], input.worktreePath);

  let prUrl = "";
  let prNumber: number | null = null;
  let merged = false;

  if (existingPr.ok && existingPr.stdout.trim()) {
    const payload = JSON.parse(existingPr.stdout) as {
      url?: string;
      number?: number;
      state?: string;
      baseRefName?: string;
      mergedAt?: string | null;
    };
    if (payload.baseRefName === input.integrationBranch && payload.url) {
      prUrl = payload.url;
      prNumber = typeof payload.number === "number" ? payload.number : parsePrNumber(payload.url);
      merged = Boolean(payload.mergedAt) || payload.state === "MERGED";
    }
  }

  if (!prUrl) {
    prUrl = (await runCommand([
      "gh",
      "pr",
      "create",
      "--repo",
      input.repoSlug,
      "--base",
      input.integrationBranch,
      "--head",
      input.branch,
      "--title",
      `fix: #${input.issueNumber} ${input.issueTitle}`,
      "--body-file",
      input.prFile,
    ], input.worktreePath)).trim();
    prNumber = parsePrNumber(prUrl);
  }

  if (!merged) {
    await runCommand([
      "gh",
      "pr",
      "merge",
      "--repo",
      input.repoSlug,
      "--squash",
      "--delete-branch=false",
      prUrl,
    ], input.worktreePath);
  }

  const mergedStateRaw = await runCommand([
    "gh",
    "pr",
    "view",
    prUrl,
    "--repo",
    input.repoSlug,
    "--json",
    "url,number,state,mergedAt",
  ], input.worktreePath);
  const mergedState = JSON.parse(mergedStateRaw) as { url?: string; number?: number; state?: string; mergedAt?: string | null };

  return {
    prUrl: mergedState.url || prUrl,
    prNumber: typeof mergedState.number === "number" ? mergedState.number : (prNumber ?? parsePrNumber(prUrl)),
    changedFiles,
    merged: Boolean(mergedState.mergedAt) || mergedState.state === "MERGED",
  };
}

function clonePhaseRecord(
  execution: CodingFactoryIssueExecutionV2,
  phase: CodingFactoryPhase,
): CodingFactoryPhaseExecutionRecord {
  return execution.phases[phase] ?? {
    version: 2,
    phase,
    status: "pending",
    attempts: 0,
    artifacts: [],
  };
}

function markPhaseRunning(
  execution: CodingFactoryIssueExecutionV2,
  phase: CodingFactoryPhase,
): CodingFactoryIssueExecutionV2 {
  const at = nowIso();
  const record = clonePhaseRecord(execution, phase);
  return {
    ...execution,
    currentPhase: phase,
    resumeFromPhase: phase,
    attempts: execution.attempts + 1,
    phases: {
      ...execution.phases,
      [phase]: {
        ...record,
        status: "running",
        attempts: record.attempts + 1,
        lastAttemptAt: at,
      },
    },
  };
}

function markPhaseResult(
  execution: CodingFactoryIssueExecutionV2,
  phase: CodingFactoryPhase,
  result: PhaseRunResult,
): CodingFactoryIssueExecutionV2 {
  const record = clonePhaseRecord(execution, phase);
  const status = result.outcome === "blocked"
    ? "blocked"
    : result.ok
      ? "completed"
      : "failed";
  const transitionPhase = resolvePhaseTransition(phase, result);
  const nextPhase = transitionPhase && SUPPORTED_PHASES.includes(transitionPhase) ? transitionPhase : null;
  const shouldContinue = result.ok || !!nextPhase;

  return {
    ...execution,
    currentPhase: shouldContinue ? null : phase,
    resumeFromPhase: shouldContinue ? nextPhase : phase,
    result: result.outcome,
    blockedReason: result.blockReason,
    phases: {
      ...execution.phases,
      [phase]: {
        ...record,
        status,
        runner: {
          backend: result.backend,
          model: result.model,
          agentId: result.agentId,
          outcome: result.outcome,
        },
        artifacts: result.artifacts ?? record.artifacts,
        latestResult: result,
        lastAttemptAt: result.finishedAt,
        completedAt: result.finishedAt,
        blockedReason: result.blockReason,
      },
    },
  };
}

function deriveIssueSnapshot(execution: CodingFactoryIssueExecutionV2): {
  phase: string;
  state: "queued" | "research_only" | "plan_ready" | "code_in_progress" | "pr_created" | "blocked" | "failed";
} {
  const pr = execution.phases.pr;
  const fixTests = execution.phases.fixTests;
  const fixAnalyze = execution.phases.fixAnalyze;
  const review = execution.phases.review;
  const implement = execution.phases.implement;
  const research = execution.phases.research;
  const plan = execution.phases.plan;

  if (pr?.status === "completed") {
    return { phase: "pr-created", state: "pr_created" };
  }
  if (pr?.status === "running") {
    return { phase: "pr", state: "code_in_progress" };
  }
  if (pr?.status === "blocked") return { phase: "pr", state: "blocked" };
  if (pr?.status === "failed") return { phase: "pr", state: "failed" };

  if (fixTests?.status === "completed") {
    return { phase: execution.resumeFromPhase === "review" ? "review" : "fixTests", state: "code_in_progress" };
  }
  if (fixTests?.status === "running") {
    return { phase: "fixTests", state: "code_in_progress" };
  }
  if (fixTests?.status === "blocked") return { phase: "fixTests", state: "blocked" };
  if (fixTests?.status === "failed") return { phase: "fixTests", state: "failed" };

  if (fixAnalyze?.status === "completed") {
    return { phase: execution.resumeFromPhase === "fixTests" ? "fixTests" : "fixAnalyze", state: "code_in_progress" };
  }
  if (fixAnalyze?.status === "running") {
    return { phase: "fixAnalyze", state: "code_in_progress" };
  }
  if (fixAnalyze?.status === "blocked") return { phase: "fixAnalyze", state: "blocked" };
  if (fixAnalyze?.status === "failed") return { phase: "fixAnalyze", state: "failed" };

  if (review?.status === "completed") {
    return { phase: execution.resumeFromPhase === "pr" ? "pr" : "review", state: "code_in_progress" };
  }
  if (review?.status === "running") {
    return { phase: "review", state: "code_in_progress" };
  }
  if (review?.status === "blocked") return { phase: "review", state: "blocked" };
  if (review?.status === "failed") return { phase: "review", state: "failed" };

  if (implement?.status === "completed" || implement?.status === "running") {
    return { phase: implement.status === "completed" && execution.resumeFromPhase === "review" ? "review" : "implement", state: "code_in_progress" };
  }
  if (implement?.status === "blocked") return { phase: "implement", state: "blocked" };
  if (implement?.status === "failed") return { phase: "implement", state: "failed" };

  if (plan?.status === "completed") return { phase: execution.resumeFromPhase === "implement" ? "implement" : "plan", state: "plan_ready" };
  if (plan?.status === "running") return { phase: "plan", state: "research_only" };
  if (plan?.status === "blocked") return { phase: "plan", state: "blocked" };
  if (plan?.status === "failed") return { phase: "plan", state: "failed" };

  if (research?.status === "completed") return { phase: execution.resumeFromPhase === "plan" ? "plan" : "research", state: "research_only" };
  if (research?.status === "running") return { phase: "research", state: "queued" };
  if (research?.status === "blocked") return { phase: "research", state: "blocked" };
  if (research?.status === "failed") return { phase: "research", state: "failed" };

  return { phase: "classify", state: "queued" };
}

async function ensureIssueArtifactDirs(issueNumber: number, repoSlug: string): Promise<void> {
  const artifacts = getIssueArtifactSet(issueNumber, repoSlug);
  await mkdir(artifacts.rootDir, { recursive: true });
  await mkdir(artifacts.logDir, { recursive: true });
  await mkdir(dirname(artifacts.legacyCompat.researchFile), { recursive: true });
}

async function mirrorLegacyCompat(issueNumber: number, repoSlug: string, phase: CodingFactoryPhase): Promise<void> {
  const artifacts = getIssueArtifactSet(issueNumber, repoSlug);
  if (phase === "research") {
    await copyFile(artifacts.researchFile, artifacts.legacyCompat.researchFile);
  }
  if (phase === "plan") {
    await copyFile(artifacts.planFile, artifacts.legacyCompat.contractFile);
  }
}

function buildNextAction(targetState: string, snapshotPhase: string): string {
  if (targetState === "plan_ready") return "Ready for V2 implement handoff.";
  if (targetState === "pr_created") return "PR handoff prepared. Create or update the PR from the generated artifact.";
  if (targetState === "code_in_progress" && snapshotPhase === "implement") return "Continue V2 review execution.";
  if (targetState === "code_in_progress" && snapshotPhase === "review") return "Review completed. Continue with PR handoff or the fix loop.";
  if (targetState === "code_in_progress" && snapshotPhase === "fixAnalyze") return "Continue V2 test-fix execution.";
  if (targetState === "code_in_progress" && snapshotPhase === "fixTests") return "Continue V2 review rerun.";
  if (targetState === "code_in_progress" && snapshotPhase === "pr") return "Continue V2 PR handoff.";
  return "Continue V2 execution.";
}

async function persistIssue(
  run: CodingFactoryRunState,
  issueRef: IssueRef,
  execution: CodingFactoryIssueExecutionV2,
  result?: PhaseRunResult,
  patch?: IssuePersistencePatch,
): Promise<void> {
  const issues = await readIssueStates();
  const existing = issues.find((item) => item.issueKey === issueRef.issueKey);
  const snapshot = deriveIssueSnapshot(execution);
  const at = result?.finishedAt ?? nowIso();
  const targetState = snapshot.state;

  let transition = {
    state: existing?.state ?? "created",
    stateHistory: existing?.stateHistory ?? [],
    stateUpdatedAt: existing?.stateUpdatedAt ?? at,
  };

  if (transition.state === "created") {
    transition = applyIssueTransition(transition, {
      to: "queued",
      at,
      source: "api",
      reason: `v2-${run.runId}-queued`,
    });
  }

  if (transition.state !== targetState) {
    transition = applyIssueTransition(transition, {
      to: targetState,
      at,
      source: "api",
      reason: `v2-${run.runId}-${snapshot.phase}`,
    });
  }

  const artifacts = getIssueArtifactSet(issueRef.issue, issueRef.repo);
  const history = [...(existing?.history ?? [])];
  if (result) {
    history.push({
      phase: result.phase,
      status: result.ok ? "done" : (result.outcome === "blocked" ? "blocked" : "failed"),
      at,
      extra: result.summary ?? result.error,
    });
  }

  await saveIssueState({
    version: 2,
    issue: issueRef.issue,
    repo: issueRef.repo,
    issueKey: issueRef.issueKey,
    title: existing?.title ?? issueRef.title,
    branch: patch?.branch ?? existing?.branch ?? "",
    branchMode: patch?.branchMode ?? existing?.branchMode,
    workingBranch: patch?.workingBranch ?? existing?.workingBranch ?? run.workingBranch,
    worktree: patch?.worktree ?? existing?.worktree ?? null,
    baseBranch: run.baseBranch,
    size: existing?.size ?? issueRef.repo.split("/")[1] ?? "",
    phase: snapshot.phase,
    state: transition.state,
    stateUpdatedAt: transition.stateUpdatedAt,
    stateHistory: transition.stateHistory,
    prUrl: patch?.prUrl ?? existing?.prUrl,
    merged: result?.metadata?.merged === true || existing?.merged === true,
    startedAt: existing?.startedAt ?? at,
    updatedAt: at,
    duration: existing?.duration ?? null,
    history,
    handover: {
      stage: execution.resumeFromPhase ?? snapshot.phase,
      codeProduced: execution.phases.implement?.status === "completed"
        || execution.phases.fixAnalyze?.status === "completed"
        || execution.phases.fixTests?.status === "completed"
        || execution.phases.pr?.status === "completed"
        || targetState === "code_in_progress"
        || targetState === "pr_created",
      branchCreated: patch?.branchCreated ?? existing?.handover?.branchCreated ?? false,
      branch: patch?.branch ?? existing?.branch ?? null,
      summary: patch?.summary ?? result?.summary ?? existing?.handover?.summary ?? "V2 execution state persisted.",
      nextAction: patch?.nextAction ?? buildNextAction(targetState, snapshot.phase),
      updatedAt: at,
      artifacts: {
        researchFile: artifacts.legacyCompat.researchFile,
        contractFile: artifacts.legacyCompat.contractFile,
        logFile: result?.logPath
          ?? execution.phases.pr?.latestResult?.logPath
          ?? execution.phases.fixTests?.latestResult?.logPath
          ?? execution.phases.fixAnalyze?.latestResult?.logPath
          ?? execution.phases.review?.latestResult?.logPath
          ?? execution.phases.implement?.latestResult?.logPath
          ?? artifacts.legacyCompat.logFile,
      },
      comment: existing?.handover?.comment,
      changedFiles: patch?.changedFiles ?? existing?.handover?.changedFiles,
      validation: existing?.handover?.validation,
    },
    issueStartSha: patch?.issueStartSha ?? existing?.issueStartSha,
    issueEndSha: patch?.issueEndSha ?? existing?.issueEndSha,
    issueDiffBaseSha: patch?.issueDiffBaseSha ?? existing?.issueDiffBaseSha,
    commitSha: patch?.commitSha ?? existing?.commitSha,
    commitMessage: patch?.commitMessage ?? existing?.commitMessage,
    profile: run.profile,
    result: result?.outcome ?? existing?.result,
    execution,
    planApproved: targetState === "plan_ready",
  });
}

function deriveExecutionQueueCounts(selected: Awaited<ReturnType<typeof readIssueStates>>): QueueCounts {
  return selected.reduce<QueueCounts>((acc, issue) => {
    const execution = issue.execution;

    if (
      execution?.result === "blocked"
      || execution?.phases.pr?.status === "blocked"
      || execution?.phases.fixTests?.status === "blocked"
      || execution?.phases.fixAnalyze?.status === "blocked"
      || execution?.phases.review?.status === "blocked"
      || execution?.phases.implement?.status === "blocked"
      || issue.state === "blocked"
      || issue.state === "stale"
    ) {
      acc.blocked += 1;
      return acc;
    }

    if (
      execution?.result === "fatal_error"
      || execution?.result === "retryable_error"
      || execution?.phases.pr?.status === "failed"
      || execution?.phases.fixTests?.status === "failed"
      || execution?.phases.fixAnalyze?.status === "failed"
      || execution?.phases.review?.status === "failed"
      || execution?.phases.implement?.status === "failed"
      || issue.state === "failed"
      || issue.state === "cancelled"
    ) {
      acc.failed += 1;
      return acc;
    }

    if (execution?.currentPhase) {
      acc.running += 1;
      return acc;
    }

    if (execution && execution.resumeFromPhase === null) {
      acc.completed += 1;
      return acc;
    }

    if (isCompletedIssueState(issue.state)) {
      acc.completed += 1;
      return acc;
    }

    acc.pending += 1;
    return acc;
  }, {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
  });
}

function deriveRunStateFromQueue(queue: QueueCounts, total: number, fallback: CodingFactoryRunState["state"]): CodingFactoryRunState["state"] {
  if (queue.failed > 0) return "failed";
  if (queue.blocked > 0) return "blocked";
  if (queue.running > 0) return "running";
  if (total > 0 && queue.completed >= total) return "completed";
  if (total > 0) return "queued";
  return fallback;
}

async function refreshRunExecution(run: CodingFactoryRunState): Promise<CodingFactoryRunState> {
  const allIssues = await readIssueStates();
  const selected = selectIssuesByKey(allIssues, run.selectedIssues);
  const total = run.selectedIssues.length;
  const queue = deriveExecutionQueueCounts(selected);

  const execution: CodingFactoryRunExecutionV2 = {
    ...(run.execution ?? createEmptyRunExecutionV2(run.profile ?? "balanced", total)),
    version: 2,
    profile: run.profile ?? "balanced",
    queue: {
      total,
      pending: queue.pending,
      running: queue.running,
      completed: queue.completed,
      failed: queue.failed,
      blocked: queue.blocked,
    },
  };

  const intake: CodingFactoryIntakeState = {
    version: 2,
    updatedAt: nowIso(),
    mode: run.mode,
    targetRepo: run.targetRepo,
    baseBranch: run.baseBranch,
    branchStrategy: run.branchStrategy,
    workingBranch: run.workingBranch,
    branchStartMode: run.branchStartMode,
    selectedIssues: run.selectedIssues,
  };

  const targetState = deriveRunStateFromQueue(queue, total, run.state);
  const targetStatus = targetState === "running"
    ? "running"
    : targetState === "completed"
      ? "completed"
      : targetState === "failed" || targetState === "blocked"
        ? "unknown"
        : total > 0
          ? "draft"
          : run.status;

  return saveRunState({
    ...run,
    updatedAt: nowIso(),
    status: targetStatus,
    state: targetState,
    stateUpdatedAt: nowIso(),
    execution,
  }, intake);
}

async function updateSupervisor(patch: Record<string, unknown>): Promise<void> {
  const supervisor = await readSupervisorState();
  if (!supervisor) return;
  await writeJson(CODING_FACTORY_SUPERVISOR_PATH, {
    ...supervisor,
    ...patch,
    updatedAt: nowIso(),
  });
}

async function finalizeSharedIssueCommit(input: {
  repoPath: string;
  issueNumber: number;
  issueTitle: string;
  issueStartSha: string;
}): Promise<SharedIssueCommitResult> {
  const issueDiffBaseSha = input.issueStartSha;
  const status = await runCommand(["git", "status", "--porcelain"], input.repoPath);
  const commitMessage = `fix(issue-${input.issueNumber}): ${input.issueTitle}`;

  if (!status.trim()) {
    return {
      issueStartSha: input.issueStartSha,
      issueEndSha: input.issueStartSha,
      issueDiffBaseSha,
      commitSha: null,
      commitMessage: null,
      changedFiles: [],
    };
  }

  await runCommand(["git", "add", "-A"], input.repoPath);
  await runCommand(["git", "commit", "-m", commitMessage], input.repoPath);
  const commitSha = await getHeadSha(input.repoPath);
  const changedFilesOutput = await runCommand(["git", "diff", "--name-only", `${input.issueStartSha}..${commitSha}`], input.repoPath);

  return {
    issueStartSha: input.issueStartSha,
    issueEndSha: commitSha,
    issueDiffBaseSha,
    commitSha,
    commitMessage,
    changedFiles: changedFilesOutput.split("\n").map((line) => line.trim()).filter(Boolean),
  };
}

async function ensureBranchPushed(repoPath: string, branch: string): Promise<void> {
  await runCommand(["git", "push", "--set-upstream", "origin", branch], repoPath);
}

async function ensureFinalPullRequest(input: {
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}): Promise<FinalPullRequestResult> {
  await runCommand(["git", "fetch", "origin", input.baseBranch], input.repoPath);
  await runCommand(["git", "fetch", "origin", input.headBranch], input.repoPath);

  const aheadBehind = await runCommand([
    "git",
    "rev-list",
    "--left-right",
    "--count",
    `origin/${input.baseBranch}...origin/${input.headBranch}`,
  ], input.repoPath);
  const [, aheadRaw = "0"] = aheadBehind.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw, 10);
  if (!Number.isFinite(ahead) || ahead <= 0) {
    return {
      prUrl: null,
      prNumber: null,
      state: "not_needed",
    };
  }

  const existingPr = await tryRunCommand([
    "gh",
    "pr",
    "list",
    "--repo",
    input.repoSlug,
    "--head",
    input.headBranch,
    "--base",
    input.baseBranch,
    "--state",
    "all",
    "--json",
    "url,number,state",
  ], input.repoPath);

  if (existingPr.ok && existingPr.stdout.trim()) {
    const items = JSON.parse(existingPr.stdout) as Array<{ url?: string; number?: number; state?: string }>;
    const pr = items[0];
    if (pr?.url) {
      return {
        prUrl: pr.url,
        prNumber: typeof pr.number === "number" ? pr.number : parsePrNumber(pr.url),
        state: pr.state ?? "OPEN",
      };
    }
  }

  const prUrl = (await runCommand([
    "gh",
    "pr",
    "create",
    "--repo",
    input.repoSlug,
    "--base",
    input.baseBranch,
    "--head",
    input.headBranch,
    "--title",
    input.title,
    "--body",
    input.body,
  ], input.repoPath)).trim();

  return {
    prUrl,
    prNumber: parsePrNumber(prUrl),
    state: "OPEN",
  };
}

function buildPhaseRequest(phase: CodingFactoryPhase, input: {
  issueNumber: number;
  issueTitle: string;
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
  branchStrategy: "shared" | "isolated";
  workingBranch: string;
  integrationBranch?: string;
  issueDiffBaseSha?: string;
  issueDiffHeadSha?: string;
  worktreePath?: string;
}) {
  const context = {
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    repoSlug: input.repoSlug,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    branchStrategy: input.branchStrategy,
    workingBranch: input.workingBranch,
    integrationBranch: input.integrationBranch,
    issueDiffBaseSha: input.issueDiffBaseSha,
    issueDiffHeadSha: input.issueDiffHeadSha,
    worktreePath: input.worktreePath,
  };

  let request: Omit<import("@/lib/coding-factory/types").PhaseRunRequest, "backend">;

  switch (phase) {
    case "research":
      request = buildResearchRequest(context);
      break;
    case "plan":
      request = buildPlanRequest(context);
      break;
    case "implement":
      request = buildImplementRequest(context);
      break;
    case "review":
      request = buildReviewRequest(context);
      break;
    case "fixAnalyze":
      request = buildFixAnalyzeRequest(context);
      break;
    case "fixTests":
      request = buildFixTestsRequest(context);
      break;
    case "pr":
      request = buildPrRequest(context);
      break;
    default:
      throw new Error(`Unsupported worker phase: ${phase}`);
  }

  return {
    ...request,
    branchStrategy: input.branchStrategy,
    workingBranch: input.workingBranch,
    integrationBranch: input.integrationBranch,
    issueDiffBaseSha: input.issueDiffBaseSha,
    issueDiffHeadSha: input.issueDiffHeadSha,
    worktreePath: input.worktreePath,
  };
}

async function main() {
  const envelope = parseEnvelope();
  const repoPath = resolveCodingFactoryRepoPath(envelope.targetRepo);
  const orchestrator = createCodingFactoryOrchestrator({
    runId: envelope.runId,
    targetRepo: envelope.targetRepo,
    baseBranch: envelope.baseBranch,
    branchStrategy: envelope.branchStrategy,
    workingBranch: envelope.workingBranch,
    branchStartMode: envelope.branchStartMode,
    integrationBranch: envelope.integrationBranch,
    selectedIssues: envelope.selectedIssues,
    profile: envelope.profile,
    launchMode: "orchestrator",
  });

  const intake: CodingFactoryIntakeState = {
    version: 2,
    updatedAt: nowIso(),
    mode: envelope.selectedIssues.length > 1 ? "batch" : "single",
    targetRepo: envelope.targetRepo,
    baseBranch: envelope.baseBranch,
    branchStrategy: envelope.branchStrategy,
    workingBranch: envelope.workingBranch,
    branchStartMode: envelope.branchStartMode,
    selectedIssues: envelope.selectedIssues.map((issue) => ({
      issue: issue.issue,
      repo: envelope.targetRepo,
      issueKey: issue.issueKey,
      title: issue.title,
    })),
  };

  let run = await readRunState(intake);
  run = await refreshRunExecution({
    ...run,
    runId: envelope.runId,
    branchStrategy: envelope.branchStrategy,
    workingBranch: envelope.workingBranch,
    branchStartMode: envelope.branchStartMode,
    integrationBranch: envelope.integrationBranch ?? null,
    finalPrUrl: run.finalPrUrl ?? null,
    finalPrNumber: run.finalPrNumber ?? null,
    finalPrState: run.finalPrState ?? null,
    profile: envelope.profile,
    execution: run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length),
  });

  const sharedWorkspace = envelope.branchStrategy === "shared"
    ? await ensureSharedBranchWorkspace({
        repoPath,
        baseBranch: envelope.baseBranch,
        workingBranch: envelope.workingBranch,
        branchStartMode: envelope.branchStartMode,
      })
    : null;

  if (envelope.branchStrategy === "isolated" && envelope.integrationBranch) {
    await ensureIntegrationBranch({
      repoPath,
      baseBranch: envelope.baseBranch,
      integrationBranch: envelope.integrationBranch,
    });
  }

  run = await saveRunState({
    ...run,
    branchStrategy: envelope.branchStrategy,
    workingBranch: envelope.workingBranch,
    branchStartMode: envelope.branchStartMode,
    integrationBranch: envelope.integrationBranch ?? null,
    currentHeadSha: envelope.branchStrategy === "shared" ? await getHeadSha(repoPath) : run.currentHeadSha ?? null,
    updatedAt: nowIso(),
  }, intake);

  for (const issue of envelope.selectedIssues) {
    const issueRef: IssueRef = {
      issue: issue.issue,
      repo: envelope.targetRepo,
      issueKey: issue.issueKey,
      title: issue.title,
    };

    await ensureIssueArtifactDirs(issue.issue, envelope.targetRepo);

    const allIssues = await readIssueStates();
    const existing = allIssues.find((item) => item.issueKey === issueRef.issueKey);
    let execution = existing?.execution ?? createEmptyIssueExecutionV2(issueRef.issueKey, envelope.profile);
    let nextPhase = resolveNextPhase(execution);
    let issueStartSha = existing?.issueStartSha;
    let workspace: IssueWorkspace | null = envelope.branchStrategy === "shared"
      ? sharedWorkspace
      : existing?.branch
        ? {
            branch: existing.branch,
            branchStrategy: "isolated",
            worktreePath: getIssueWorktreePath(issueRef.issue, envelope.targetRepo),
            remoteBranchExists: Boolean(existing.handover?.branchCreated),
          }
        : null;

    while (nextPhase && SUPPORTED_PHASES.includes(nextPhase)) {
      if (CODE_PHASES.has(nextPhase)) {
        if (envelope.branchStrategy === "shared") {
          workspace = sharedWorkspace;
          issueStartSha = issueStartSha || await getHeadSha(repoPath);
          await persistIssue(run, issueRef, execution, undefined, {
            branch: workspace?.branch,
            branchMode: "shared",
            workingBranch: envelope.workingBranch,
            branchCreated: workspace?.remoteBranchExists ?? false,
            worktree: null,
            issueStartSha,
            issueDiffBaseSha: issueStartSha,
            summary: `Prepared shared working branch ${envelope.workingBranch} in ${repoPath}.`,
            nextAction: nextPhase === "implement"
              ? "Implementation can start directly on the shared working branch. Coding Factory will create one commit for this issue after the PR handover phase."
              : undefined,
          });
        } else if (envelope.integrationBranch) {
          workspace = await ensureIssueWorkspace({
            issueNumber: issueRef.issue,
            issueTitle: issueRef.title,
            repoSlug: envelope.targetRepo,
            repoPath,
            baseBranch: envelope.baseBranch,
            integrationBranch: envelope.integrationBranch,
          });
          await persistIssue(run, issueRef, execution, undefined, {
            branch: workspace.branch,
            branchMode: "isolated",
            workingBranch: envelope.workingBranch,
            worktree: workspace.worktreePath ?? null,
            branchCreated: workspace.remoteBranchExists,
            summary: `Prepared issue branch ${workspace.branch} on top of ${envelope.integrationBranch} at ${workspace.worktreePath}.`,
            nextAction: nextPhase === "implement"
              ? "Issue branch prepared from the integration branch. Implementation can start on the isolated worktree."
              : undefined,
          });
        }
      }

      execution = markPhaseRunning(execution, nextPhase);
      await persistIssue(run, issueRef, execution, undefined, {
        branch: workspace?.branch,
        branchMode: envelope.branchStrategy,
        workingBranch: envelope.workingBranch,
        worktree: workspace?.worktreePath ?? null,
        branchCreated: workspace?.remoteBranchExists ?? false,
        issueStartSha,
        issueDiffBaseSha: issueStartSha,
      });

      run = await refreshRunExecution({
        ...run,
        status: "running",
        execution: {
          ...(run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length)),
          currentIssueKey: issueRef.issueKey,
          currentPhase: nextPhase,
        },
      });

      await updateSupervisor({
        status: "running",
        currentIssueKey: issueRef.issueKey,
        currentPhase: nextPhase,
      });

      let result = await orchestrator.executePhase({
        ...buildPhaseRequest(nextPhase, {
          issueNumber: issueRef.issue,
          issueTitle: issueRef.title,
          repoSlug: envelope.targetRepo,
          repoPath,
          baseBranch: envelope.baseBranch,
          branchStrategy: envelope.branchStrategy,
          workingBranch: envelope.workingBranch,
          integrationBranch: envelope.integrationBranch,
          issueDiffBaseSha: issueStartSha,
          worktreePath: workspace?.worktreePath,
        }),
        runId: envelope.runId,
        profile: envelope.profile,
      });

      let patch: IssuePersistencePatch | undefined = workspace
        ? {
            branch: workspace.branch,
            branchMode: envelope.branchStrategy,
            workingBranch: envelope.workingBranch,
            worktree: workspace.worktreePath ?? null,
            branchCreated: workspace.remoteBranchExists,
            issueStartSha,
            issueDiffBaseSha: issueStartSha,
          }
        : undefined;

      if (result.ok && nextPhase === "pr" && workspace) {
        if (envelope.branchStrategy === "isolated" && workspace.worktreePath && envelope.integrationBranch) {
          try {
            const prResult = await ensurePullRequest({
              issueNumber: issueRef.issue,
              issueTitle: issueRef.title,
              repoSlug: envelope.targetRepo,
              baseBranch: envelope.baseBranch,
              integrationBranch: envelope.integrationBranch,
              branch: workspace.branch,
              worktreePath: workspace.worktreePath,
              prFile: getIssueArtifactSet(issueRef.issue, envelope.targetRepo).prFile,
            });
            result.summary = `${result.summary ?? "PR artifact prepared."}\n\nIssue PR target: ${envelope.integrationBranch}\nGitHub PR: ${prResult.prUrl}\nMerged into integration: ${prResult.merged ? "yes" : "no"}`;
            result.metadata = {
              ...(result.metadata || {}),
              branch: workspace.branch,
              prUrl: prResult.prUrl,
              prNumber: prResult.prNumber,
              changedFiles: prResult.changedFiles,
              merged: prResult.merged,
              mergeTarget: envelope.integrationBranch,
            };
            patch = {
              ...patch,
              prUrl: prResult.prUrl,
              summary: result.summary,
              nextAction: prResult.merged
                ? `Issue PR merged into integration branch ${envelope.integrationBranch}: ${prResult.prUrl}`
                : `Issue PR created on GitHub: ${prResult.prUrl}`,
              changedFiles: prResult.changedFiles,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isPermissionBlock = /Resource not accessible by personal access token/i.test(message);
            result = {
              ...result,
              ok: false,
              outcome: isPermissionBlock ? "blocked" : "fatal_error",
              finishedAt: nowIso(),
              error: message,
              blockReason: isPermissionBlock ? message : undefined,
              summary: `${result.summary ?? "PR artifact prepared."}\n\nIssue PR target: ${envelope.integrationBranch}\nPR creation/merge failed: ${message}`,
              metadata: {
                ...(result.metadata || {}),
                branch: workspace.branch,
                mergeTarget: envelope.integrationBranch,
                permissionBlocked: isPermissionBlock,
              },
            };
            patch = {
              ...patch,
              summary: result.summary,
              nextAction: isPermissionBlock
                ? "External blocker: GitHub token lacks pull-request permissions for create/view/merge."
                : "PR creation failed; inspect worker log and retry after fixing the GitHub error.",
              changedFiles: [],
            };
          }
        } else {
          result.summary = `${result.summary ?? "PR handover prepared."}\n\nShared working branch: ${envelope.workingBranch}\nFinal PR target: ${envelope.baseBranch}\nPer-issue commit will be created now.`;
          result.metadata = {
            ...(result.metadata || {}),
            branch: envelope.workingBranch,
            mergeTarget: envelope.baseBranch,
            sharedBranch: true,
          };
          patch = {
            ...patch,
            summary: result.summary,
            nextAction: `Finalize the per-issue commit on shared working branch ${envelope.workingBranch}.`,
          };
        }
      }

      execution = markPhaseResult(execution, nextPhase, result);
      if (result.ok) {
        await mirrorLegacyCompat(issueRef.issue, envelope.targetRepo, nextPhase);
      }
      await persistIssue(run, issueRef, execution, result, patch);

      if (!result.ok && execution.resumeFromPhase === nextPhase) {
        run = await refreshRunExecution({
          ...run,
          status: "unknown",
          execution: {
            ...(run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length)),
            currentIssueKey: issueRef.issueKey,
            currentPhase: nextPhase,
          },
        });
        await updateSupervisor({
          status: result.outcome === "blocked" ? "blocked" : "failed",
          currentIssueKey: issueRef.issueKey,
          currentPhase: nextPhase,
          finishedAt: result.finishedAt,
          exitCode: 1,
        });
        process.exit(1);
      }

      nextPhase = resolveNextPhase(execution);
      await updateSupervisor({
        status: "running",
        currentIssueKey: issueRef.issueKey,
        currentPhase: nextPhase,
      });
    }

    if (envelope.branchStrategy === "shared" && issueStartSha) {
      const commitResult = await finalizeSharedIssueCommit({
        repoPath,
        issueNumber: issueRef.issue,
        issueTitle: issueRef.title,
        issueStartSha,
      });
      await persistIssue(run, issueRef, execution, undefined, {
        branch: envelope.workingBranch,
        branchMode: "shared",
        workingBranch: envelope.workingBranch,
        worktree: null,
        branchCreated: sharedWorkspace?.remoteBranchExists ?? false,
        issueStartSha: commitResult.issueStartSha,
        issueEndSha: commitResult.issueEndSha,
        issueDiffBaseSha: commitResult.issueDiffBaseSha,
        commitSha: commitResult.commitSha,
        commitMessage: commitResult.commitMessage,
        changedFiles: commitResult.changedFiles,
        summary: commitResult.commitSha
          ? `Committed issue changes on ${envelope.workingBranch}: ${commitResult.commitSha}`
          : `No repository changes were detected for this issue on ${envelope.workingBranch}.`,
        nextAction: commitResult.commitSha
          ? `Continue with the next issue on the shared working branch ${envelope.workingBranch}.`
          : "No code commit was needed for this issue; continue with the next issue.",
      });
      run = await saveRunState({
        ...run,
        currentHeadSha: commitResult.issueEndSha,
        updatedAt: nowIso(),
      }, intake);
    }
  }

  if (envelope.branchStrategy === "shared") {
    await ensureBranchPushed(repoPath, envelope.workingBranch);
  }

  const finalPr = await ensureFinalPullRequest({
    repoSlug: envelope.targetRepo,
    repoPath,
    baseBranch: envelope.baseBranch,
    headBranch: envelope.branchStrategy === "isolated" ? (envelope.integrationBranch || envelope.workingBranch) : envelope.workingBranch,
    title: envelope.branchStrategy === "isolated"
      ? `chore: merge ${envelope.integrationBranch || envelope.workingBranch} into ${envelope.baseBranch}`
      : `chore: merge ${envelope.workingBranch} into ${envelope.baseBranch}`,
    body: envelope.branchStrategy === "isolated"
      ? `Automated Coding Factory final integration PR.\n\nBase branch: ${envelope.baseBranch}\nIntegration branch: ${envelope.integrationBranch || envelope.workingBranch}`
      : `Automated Coding Factory final PR.\n\nBase branch: ${envelope.baseBranch}\nWorking branch: ${envelope.workingBranch}`,
  });

  run = await refreshRunExecution({
    ...run,
    integrationBranch: envelope.integrationBranch ?? null,
    currentHeadSha: envelope.branchStrategy === "shared" ? await getHeadSha(repoPath) : run.currentHeadSha ?? null,
    finalPrUrl: finalPr.prUrl,
    finalPrNumber: finalPr.prNumber,
    finalPrState: finalPr.state,
    status: "completed",
    execution: {
      ...(run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length)),
      currentIssueKey: null,
      currentPhase: null,
    },
  });

  await updateSupervisor({
    status: "finished",
    currentIssueKey: null,
    currentPhase: null,
    finishedAt: nowIso(),
    exitCode: 0,
  });
}


main().catch(async (error) => {
  await updateSupervisor({
    status: "failed",
    currentIssueKey: null,
    currentPhase: null,
    finishedAt: nowIso(),
    exitCode: 1,
  });
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exit(1);
});
