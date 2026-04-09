import { access, mkdir, stat, writeFile } from "fs/promises";
import { dirname } from "path";
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
    || normalized.includes("usage limit")
    || normalized.includes("quota")
    || normalized.includes("insufficient credits")
    || normalized.includes("purchase more credits")
    || normalized.includes("credit balance")
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

export function detectObviousNonArtifactOutput(
  content: string | undefined,
): { outcome: Extract<CodingFactoryRunnerResultKind, "retryable_error" | "blocked">; reason: string } | null {
  const normalized = content?.trim();
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  const firstWindow = lower.slice(0, 2000);
  const shortEnough = normalized.length <= 4000;

  const retryablePatterns: Array<[RegExp, string]> = [
    [/\b(?:usage limit|quota exceeded|quota reached|rate limit|insufficient credits|purchase more credits|credit balance)\b/i, "usage or quota limit output"],
    [/\bcould(?: not|n't) complete\b/i, "completion failure output"],
  ];

  for (const [pattern, reason] of retryablePatterns) {
    if (pattern.test(firstWindow)) {
      return { outcome: "retryable_error", reason };
    }
  }

  const blockerPatterns: Array<[RegExp, string]> = [
    [/^(?:i(?:'|’)m sorry|sorry[,.!\s]|i can(?:not|'t)|i do not have access|i don't have access|unable to|access denied|permission denied|blocked\b)/i, "refusal-style output"],
    [/\b(?:access denied|permission denied|write scope|required permissions?|tool .* disabled)\b/i, "permission-blocked output"],
    [/\b(?:environment(?: is)? blocked|blocked by environment)\b/i, "environment-blocked output"],
    [/\b(?:sandbox|bubblewrap|bwrap:)\b[\s\S]{0,120}\b(?:failed|denied|blocked|unavailable|not available|not permitted)\b/i, "sandbox failure output"],
  ];

  for (const [pattern, reason] of blockerPatterns) {
    if (pattern.test(firstWindow) && shortEnough) {
      return { outcome: "blocked", reason };
    }
  }

  return null;
}

export function extractRunnerErrorDetails(error: unknown): { message: string; stdout?: string; stderr?: string } {
  const fallbackMessage = error instanceof Error ? error.message : String(error);
  const payload = (error && typeof error === "object") ? error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  } : null;

  return {
    message: typeof payload?.message === "string" ? payload.message : fallbackMessage,
    stdout: typeof payload?.stdout === "string" ? payload.stdout : undefined,
    stderr: typeof payload?.stderr === "string" ? payload.stderr : undefined,
  };
}

export async function writeRunnerLog(logPath: string | undefined, sections: Array<[label: string, value: string | undefined]>): Promise<void> {
  if (!logPath) return;

  const content = sections
    .map(([label, value]) => {
      const body = value && value.trim().length > 0 ? value.trimEnd() : "(empty)";
      return `===== ${label} =====\n${body}`;
    })
    .join("\n\n");

  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${content}\n`, "utf-8");
}

async function fileExistsAndIsNonEmpty(path: string): Promise<boolean> {
  try {
    await access(path);
    const details = await stat(path);
    return details.size > 0;
  } catch {
    return false;
  }
}

export async function materializePrimaryOutputFromText(
  request: PhaseRunRequest,
  content: string | undefined,
): Promise<string | null> {
  const normalized = content?.trim();
  if (!normalized) return null;
  if (detectObviousNonArtifactOutput(normalized)) return null;

  const primaryOutputPath = request.artifactContract?.primaryOutput?.path
    || request.outputFiles?.[0]
    || request.artifactRefs?.[0]?.path;

  if (!primaryOutputPath) return null;
  if (await fileExistsAndIsNonEmpty(primaryOutputPath)) return null;

  await mkdir(dirname(primaryOutputPath), { recursive: true });
  await writeFile(primaryOutputPath, `${normalized.trimEnd()}\n`, "utf-8");
  return primaryOutputPath;
}
