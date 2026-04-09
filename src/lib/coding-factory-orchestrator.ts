import { getCanonicalPhaseSequence, getNextPhase } from "@/lib/coding-factory-phase-registry";
import type {
  CodingFactoryIssueExecutionV2,
  CodingFactoryPhase,
  CodingFactoryProfile,
  CodingFactoryRunExecutionV2,
  PhaseRunRequest,
  PhaseRunResult,
} from "@/lib/coding-factory/types";
import { runPhaseWithFallbacks } from "@/lib/coding-factory/phase-runner";

export type CodingFactoryOrchestratorLaunchMode = "orchestrator" | "legacy-adapter";

export type CodingFactoryOrchestratorLaunchEnvelope = {
  version: 2;
  mode: CodingFactoryOrchestratorLaunchMode;
  runId: string;
  targetRepo: string;
  baseBranch: string;
  issueKeys: string[];
  selectedIssues: Array<{ issue: number; issueKey: string; title: string }>;
  profile: CodingFactoryProfile;
  phases: CodingFactoryPhase[];
  createdAt: string;
};

export type CodingFactoryOrchestratorIssueTask = {
  issueKey: string;
  issueNumber: number;
  currentPhase: CodingFactoryPhase | null;
  nextPhase: CodingFactoryPhase | null;
  execution: CodingFactoryIssueExecutionV2;
};

export type CodingFactoryOrchestrator = {
  createLaunchEnvelope(): CodingFactoryOrchestratorLaunchEnvelope;
  buildIssueTask(issueKey: string, issueNumber: number): CodingFactoryOrchestratorIssueTask;
  executePhase(request: Omit<PhaseRunRequest, "backend">): Promise<PhaseRunResult>;
  pause(runId: string): Promise<{ ok: true; runId: string }>;
  cancel(runId: string): Promise<{ ok: true; runId: string }>;
  resume(runId: string): Promise<{ ok: true; runId: string }>;
};

export type CreateCodingFactoryOrchestratorInput = {
  runId: string;
  targetRepo: string;
  baseBranch: string;
  selectedIssues: Array<{ issue: number; issueKey: string; title: string }>;
  profile?: CodingFactoryProfile;
  launchMode?: CodingFactoryOrchestratorLaunchMode;
};

export function createEmptyRunExecutionV2(profile: CodingFactoryProfile, issueCount: number): CodingFactoryRunExecutionV2 {
  return {
    version: 2,
    profile,
    queue: {
      total: issueCount,
      pending: issueCount,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    },
    currentIssueKey: null,
    currentPhase: null,
  };
}

export function createEmptyIssueExecutionV2(issueKey: string, profile: CodingFactoryProfile): CodingFactoryIssueExecutionV2 {
  return {
    version: 2,
    issueKey,
    profile,
    currentPhase: null,
    resumeFromPhase: getCanonicalPhaseSequence()[0] ?? null,
    phases: {},
    attempts: 0,
  };
}

export function resolveNextPhase(execution: Pick<CodingFactoryIssueExecutionV2, "resumeFromPhase" | "currentPhase">): CodingFactoryPhase | null {
  if (execution.resumeFromPhase) return execution.resumeFromPhase;
  if (execution.currentPhase) return getNextPhase(execution.currentPhase);
  return getCanonicalPhaseSequence()[0] ?? null;
}

export function resolvePhaseTransition(phase: CodingFactoryPhase, result: Pick<PhaseRunResult, "ok" | "outcome" | "metadata">): CodingFactoryPhase | null {
  const requestedNextPhase = typeof result.metadata?.nextPhase === "string"
    ? result.metadata.nextPhase as CodingFactoryPhase
    : null;

  if (requestedNextPhase) {
    return requestedNextPhase;
  }

  if (result.ok) {
    return getNextPhase(phase);
  }

  if (result.outcome === "blocked") {
    return null;
  }

  return null;
}

export function createCodingFactoryOrchestrator(input: CreateCodingFactoryOrchestratorInput): CodingFactoryOrchestrator {
  const profile = input.profile ?? "balanced";
  const launchMode = input.launchMode ?? "legacy-adapter";

  return {
    createLaunchEnvelope() {
      return {
        version: 2,
        mode: launchMode,
        runId: input.runId,
        targetRepo: input.targetRepo,
        baseBranch: input.baseBranch,
        issueKeys: input.selectedIssues.map((issue) => issue.issueKey),
        selectedIssues: input.selectedIssues,
        profile,
        phases: getCanonicalPhaseSequence(),
        createdAt: new Date().toISOString(),
      };
    },

    buildIssueTask(issueKey, issueNumber) {
      const execution = createEmptyIssueExecutionV2(issueKey, profile);
      const nextPhase = resolveNextPhase(execution);
      return {
        issueKey,
        issueNumber,
        currentPhase: execution.currentPhase,
        nextPhase,
        execution,
      };
    },

    executePhase(request) {
      return runPhaseWithFallbacks(request);
    },

    async pause(runId) {
      return { ok: true, runId };
    },

    async cancel(runId) {
      return { ok: true, runId };
    },

    async resume(runId) {
      return { ok: true, runId };
    },
  };
}
