import { copyFile, mkdir } from "fs/promises";
import { dirname } from "path";
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

type QueueCounts = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
};

function parseEnvelope(): CodingFactoryOrchestratorLaunchEnvelope {
  const raw = process.env.CODING_FACTORY_LAUNCH_ENVELOPE;
  if (!raw) throw new Error("Missing CODING_FACTORY_LAUNCH_ENVELOPE.");
  return JSON.parse(raw) as CodingFactoryOrchestratorLaunchEnvelope;
}

function nowIso(): string {
  return new Date().toISOString();
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
    branch: existing?.branch ?? "",
    baseBranch: run.baseBranch,
    size: existing?.size ?? issueRef.repo.split("/")[1] ?? "",
    phase: snapshot.phase,
    state: transition.state,
    stateUpdatedAt: transition.stateUpdatedAt,
    stateHistory: transition.stateHistory,
    prUrl: existing?.prUrl,
    merged: existing?.merged ?? false,
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
      branchCreated: existing?.handover?.branchCreated ?? false,
      branch: existing?.branch ?? null,
      summary: result?.summary ?? existing?.handover?.summary ?? "V2 execution state persisted.",
      nextAction: buildNextAction(targetState, snapshot.phase),
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
      changedFiles: existing?.handover?.changedFiles,
      validation: existing?.handover?.validation,
    },
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
    version: 1,
    updatedAt: nowIso(),
    mode: run.mode,
    targetRepo: run.targetRepo,
    baseBranch: run.baseBranch,
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

function buildPhaseRequest(phase: CodingFactoryPhase, input: {
  issueNumber: number;
  issueTitle: string;
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
}) {
  const context = {
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    repoSlug: input.repoSlug,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
  };

  switch (phase) {
    case "research":
      return buildResearchRequest(context);
    case "plan":
      return buildPlanRequest(context);
    case "implement":
      return buildImplementRequest(context);
    case "review":
      return buildReviewRequest(context);
    case "fixAnalyze":
      return buildFixAnalyzeRequest(context);
    case "fixTests":
      return buildFixTestsRequest(context);
    case "pr":
      return buildPrRequest(context);
    default:
      throw new Error(`Unsupported worker phase: ${phase}`);
  }
}

async function main() {
  const envelope = parseEnvelope();
  const repoPath = resolveCodingFactoryRepoPath(envelope.targetRepo);
  const orchestrator = createCodingFactoryOrchestrator({
    runId: envelope.runId,
    targetRepo: envelope.targetRepo,
    baseBranch: envelope.baseBranch,
    selectedIssues: envelope.selectedIssues,
    profile: envelope.profile,
    launchMode: "orchestrator",
  });

  const intake: CodingFactoryIntakeState = {
    version: 1,
    updatedAt: nowIso(),
    mode: envelope.selectedIssues.length > 1 ? "batch" : "single",
    targetRepo: envelope.targetRepo,
    baseBranch: envelope.baseBranch,
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
    profile: envelope.profile,
    execution: run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length),
  });

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

    while (nextPhase && SUPPORTED_PHASES.includes(nextPhase)) {
      execution = markPhaseRunning(execution, nextPhase);
      await persistIssue(run, issueRef, execution);

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

      const result = await orchestrator.executePhase({
        ...buildPhaseRequest(nextPhase, {
          issueNumber: issueRef.issue,
          issueTitle: issueRef.title,
          repoSlug: envelope.targetRepo,
          repoPath,
          baseBranch: envelope.baseBranch,
        }),
        runId: envelope.runId,
        profile: envelope.profile,
      });

      execution = markPhaseResult(execution, nextPhase, result);
      if (result.ok) {
        await mirrorLegacyCompat(issueRef.issue, envelope.targetRepo, nextPhase);
      }
      await persistIssue(run, issueRef, execution, result);

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
  }

  run = await refreshRunExecution({
    ...run,
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
