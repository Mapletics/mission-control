import type {
  CodingFactoryRunnerResultKind,
  PhaseRunRequest,
  PhaseRunResult,
} from "@/lib/coding-factory/types";

export interface CodingFactoryRunner {
  readonly backend: PhaseRunRequest["backend"];
  run(request: PhaseRunRequest): Promise<PhaseRunResult>;
}

export function createPhaseResult(
  request: PhaseRunRequest,
  patch: Partial<PhaseRunResult> & { outcome?: CodingFactoryRunnerResultKind },
): PhaseRunResult {
  const startedAt = patch.startedAt || new Date().toISOString();
  const finishedAt = patch.finishedAt || new Date().toISOString();
  const outcome = patch.outcome ?? (patch.ok === true ? "success" : "fatal_error");

  return {
    ok: outcome === "success",
    outcome,
    phase: request.phase,
    backend: request.backend,
    model: request.model,
    agentId: request.agentId,
    startedAt,
    finishedAt,
    summary: patch.summary,
    error: patch.error,
    blockReason: patch.blockReason,
    retryHint: patch.retryHint,
    stdoutPath: patch.stdoutPath,
    logPath: patch.logPath ?? request.logPath,
    outputFiles: patch.outputFiles ?? request.outputFiles,
    artifacts: patch.artifacts ?? request.artifactRefs,
    command: patch.command,
    metrics: {
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      ...(patch.metrics || {}),
    },
    metadata: patch.metadata,
  };
}

export function classifyRunnerError(error: unknown): Extract<CodingFactoryRunnerResultKind, "retryable_error" | "fatal_error" | "blocked"> {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("timed out")
    || normalized.includes("timeout")
    || normalized.includes("econnreset")
    || normalized.includes("temporar")
    || normalized.includes("rate limit")
  ) {
    return "retryable_error";
  }

  if (
    normalized.includes("permission")
    || normalized.includes("blocked")
    || normalized.includes("write scope")
    || normalized.includes("disabled")
    || normalized.includes("requires agentid")
  ) {
    return "blocked";
  }

  return "fatal_error";
}
