import { copyFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
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
import { buildPlanRequest } from "@/lib/coding-factory/phases/plan";
import { buildResearchRequest } from "@/lib/coding-factory/phases/research";
import {
  createCodingFactoryOrchestrator,
  createEmptyIssueExecutionV2,
  createEmptyRunExecutionV2,
  resolveNextPhase,
  type CodingFactoryOrchestratorLaunchEnvelope,
} from "@/lib/coding-factory-orchestrator";
import { applyIssueTransition, isCompletedIssueState, isTerminalIssueState } from "@/lib/coding-factory-state-machine";
import type {
  CodingFactoryIssueExecutionV2,
  CodingFactoryPhase,
  CodingFactoryPhaseExecutionRecord,
  CodingFactoryRunExecutionV2,
  PhaseRunResult,
} from "@/lib/coding-factory/types";

const SUPPORTED_PHASES: CodingFactoryPhase[] = ["research", "plan"];

function parseEnvelope(): CodingFactoryOrchestratorLaunchEnvelope {
  const raw = process.env.CODING_FACTORY_LAUNCH_ENVELOPE;
  if (!raw) throw new Error("Missing CODING_FACTORY_LAUNCH_ENVELOPE.");
  return JSON.parse(raw) as CodingFactoryOrchestratorLaunchEnvelope;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveRepoPath(repoSlug: string): string {
  const [, repoName] = repoSlug.split("/");
  if (!repoName) throw new Error(`Unable to resolve repo path for ${repoSlug}.`);
  return join("/home/ubuntu/repos", repoName);
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
  const nextPhase = result.ok ? resolveNextPhase({ currentPhase: phase, resumeFromPhase: null }) : phase;

  return {
    ...execution,
    currentPhase: result.ok ? null : phase,
    resumeFromPhase: result.ok && nextPhase && SUPPORTED_PHASES.includes(nextPhase) ? nextPhase : (result.ok ? null : phase),
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
        completedAt: result.ok ? result.finishedAt : record.completedAt,
        blockedReason: result.blockReason,
      },
    },
  };
}

function deriveIssueSnapshot(execution: CodingFactoryIssueExecutionV2): {
  phase: string;
  state: "queued" | "research_only" | "plan_ready" | "blocked" | "failed";
} {
  const research = execution.phases.research;
  const plan = execution.phases.plan;

  if (plan?.status === "completed") return { phase: "plan", state: "plan_ready" };
  if (plan?.status === "running") return { phase: "plan", state: "research_only" };
  if (plan?.status === "blocked") return { phase: "plan", state: "blocked" };
  if (plan?.status === "failed") return { phase: "plan", state: "failed" };

  if (research?.status === "completed") return { phase: "research", state: "research_only" };
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
      stage: targetState,
      codeProduced: false,
      branchCreated: false,
      branch: existing?.branch ?? null,
      summary: result?.summary ?? existing?.handover?.summary ?? "V2 research/plan state persisted.",
      nextAction: targetState === "plan_ready"
        ? "Ready for legacy implement/review handoff."
        : "Continue V2 research/plan execution.",
      updatedAt: at,
      artifacts: {
        researchFile: artifacts.legacyCompat.researchFile,
        contractFile: artifacts.legacyCompat.contractFile,
        logFile: result?.logPath ?? artifacts.legacyCompat.logFile,
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

async function refreshRunExecution(run: CodingFactoryRunState): Promise<CodingFactoryRunState> {
  const allIssues = await readIssueStates();
  const selected = selectIssuesByKey(allIssues, run.selectedIssues);
  const total = run.selectedIssues.length;
  const completed = selected.filter((issue) => isCompletedIssueState(issue.state)).length;
  const failed = selected.filter((issue) => issue.state === "failed" || issue.state === "cancelled").length;
  const blocked = selected.filter((issue) => issue.state === "blocked" || issue.state === "stale").length;
  const running = selected.filter((issue) => issue.execution?.currentPhase && !isTerminalIssueState(issue.state)).length;

  const execution: CodingFactoryRunExecutionV2 = {
    ...(run.execution ?? createEmptyRunExecutionV2(run.profile ?? "balanced", total)),
    version: 2,
    profile: run.profile ?? "balanced",
    queue: {
      total,
      pending: Math.max(total - completed - failed - blocked - running, 0),
      running,
      completed,
      failed,
      blocked,
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

  return saveRunState({
    ...run,
    updatedAt: nowIso(),
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

  return phase === "research"
    ? buildResearchRequest(context)
    : buildPlanRequest(context);
}

async function main() {
  const envelope = parseEnvelope();
  const repoPath = resolveRepoPath(envelope.targetRepo);
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

      if (!result.ok) {
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
          status: "failed",
          finishedAt: result.finishedAt,
          exitCode: 1,
        });
        process.exit(1);
      }

      nextPhase = resolveNextPhase(execution);
    }
  }

  run = await refreshRunExecution({
    ...run,
    status: "draft",
    execution: {
      ...(run.execution ?? createEmptyRunExecutionV2(envelope.profile, envelope.selectedIssues.length)),
      currentIssueKey: null,
      currentPhase: null,
    },
  });

  await updateSupervisor({
    status: "finished",
    finishedAt: nowIso(),
    exitCode: 0,
  });
}

main().catch(async (error) => {
  await updateSupervisor({
    status: "failed",
    finishedAt: nowIso(),
    exitCode: 1,
  });
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exit(1);
});
