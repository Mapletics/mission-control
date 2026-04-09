import { access, readFile, stat } from "fs/promises";
import { buildPhaseLogPath, validateArtifactContract } from "@/lib/coding-factory/artifacts";
import { resolvePhaseConfig } from "@/lib/coding-factory/config";
import { buildExecutionTargets } from "@/lib/coding-factory/fallback-policy";
import { getPhaseRegistryEntry } from "@/lib/coding-factory-phase-registry";
import { ClaudeCliRunner } from "@/lib/coding-factory/runners/claude-cli";
import { CodexRunner } from "@/lib/coding-factory/runners/codex";
import { createPhaseResult } from "@/lib/coding-factory/runners/base";
import { SubagentRunner } from "@/lib/coding-factory/runners/subagent";
import type { CodingFactoryPhase, PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";

const RUNNERS = {
  "claude-cli": new ClaudeCliRunner(),
  codex: new CodexRunner(),
  subagent: new SubagentRunner(),
} as const;

async function fileExistsAndIsNonEmpty(path: string): Promise<{ exists: boolean; nonEmpty: boolean }> {
  try {
    await access(path);
    const details = await stat(path);
    return {
      exists: true,
      nonEmpty: details.size > 0,
    };
  } catch {
    return {
      exists: false,
      nonEmpty: false,
    };
  }
}

async function validateSuccessfulPhaseOutputs(request: PhaseRunRequest): Promise<{
  ok: boolean;
  missing: string[];
  empty: string[];
}> {
  const requiredPaths = new Set<string>([
    ...(request.outputFiles || []),
    request.artifactContract?.primaryOutput?.path || "",
    ...(request.artifactRefs || [])
      .filter((ref) => ref.required !== false)
      .map((ref) => ref.path),
  ].filter(Boolean));

  const missing: string[] = [];
  const empty: string[] = [];

  for (const path of requiredPaths) {
    const status = await fileExistsAndIsNonEmpty(path);
    if (!status.exists) {
      missing.push(path);
      continue;
    }
    if (!status.nonEmpty) {
      empty.push(path);
    }
  }

  return {
    ok: missing.length === 0 && empty.length === 0,
    missing,
    empty,
  };
}

async function resolveSuccessMetadata(request: PhaseRunRequest): Promise<Record<string, unknown> | undefined> {
  if (request.phase !== "review") return undefined;

  const reviewPath = request.artifactContract?.primaryOutput?.path
    || request.artifactRefs?.[0]?.path
    || request.outputFiles?.[0];

  if (!reviewPath) return undefined;

  try {
    const content = await readFile(reviewPath, "utf-8");
    const nextPhaseMatch = content.match(/(?:^|\n)NEXT_PHASE:\s*(pr|fixAnalyze)\s*(?:\n|$)/i);
    if (nextPhaseMatch) {
      return { nextPhase: nextPhaseMatch[1] as CodingFactoryPhase };
    }

    const verdictMatch = content.match(/(?:^|\n)VERDICT:\s*(pass|changes_required)\s*(?:\n|$)/i);
    if (verdictMatch) {
      return {
        nextPhase: verdictMatch[1].toLowerCase() === "pass" ? "pr" : "fixAnalyze",
      };
    }
  } catch {
    // best-effort semantic routing only; hard existence checks happen separately
  }

  return undefined;
}

export async function runPhaseWithFallbacks(
  request: Omit<PhaseRunRequest, "backend">,
): Promise<PhaseRunResult> {
  const phaseEntry = getPhaseRegistryEntry(request.phase);
  const phaseConfig = resolvePhaseConfig(request.repoSlug, request.phase);
  const executionTargets = buildExecutionTargets(phaseConfig);
  const errors: string[] = [];

  const contractValidation = await validateArtifactContract(request.artifactContract);
  if (!contractValidation.ok && request.phase !== "research") {
    return createPhaseResult({
      ...request,
      backend: executionTargets[0]?.backend || "claude-cli",
      logPath: buildPhaseLogPath(
        request.issueNumber,
        request.repoSlug,
        request.phase,
        executionTargets[0]?.backend || "claude-cli",
      ),
    }, {
      outcome: "blocked",
      error: `Missing required artifacts for ${phaseEntry.phase}: ${contractValidation.missing.map((item) => item.key).join(", ")}`,
      blockReason: "artifact contract validation failed",
      metadata: {
        missingArtifacts: contractValidation.missing,
      },
    });
  }

  for (const target of executionTargets) {
    const runner = RUNNERS[target.backend];
    const effectiveRequest = {
      ...request,
      backend: target.backend,
      model: target.model,
      agentId: target.agentId,
      timeoutMinutes: target.timeoutMinutes,
      logPath: buildPhaseLogPath(request.issueNumber, request.repoSlug, request.phase, target.backend),
    } satisfies PhaseRunRequest;

    const result = await runner.run(effectiveRequest);

    if (result.ok) {
      const outputValidation = await validateSuccessfulPhaseOutputs(effectiveRequest);
      if (!outputValidation.ok) {
        const validationError = [
          outputValidation.missing.length > 0
            ? `missing outputs: ${outputValidation.missing.join(", ")}`
            : null,
          outputValidation.empty.length > 0
            ? `empty outputs: ${outputValidation.empty.join(", ")}`
            : null,
        ].filter(Boolean).join(" | ");

        return createPhaseResult(effectiveRequest, {
          outcome: "fatal_error",
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          summary: result.summary,
          error: `Phase ${request.phase} reported success but failed post-run validation: ${validationError}`,
          retryHint: "Re-run the same phase only after the required output artifact is written successfully.",
          logPath: result.logPath,
          stdoutPath: result.stdoutPath,
          outputFiles: result.outputFiles,
          artifacts: result.artifacts,
          command: result.command,
          metadata: {
            ...(result.metadata || {}),
            postRunValidation: outputValidation,
            attemptedBackends: executionTargets.map((item) => item.backend),
            phaseRegistry: phaseEntry,
          },
        });
      }

      const successMetadata = await resolveSuccessMetadata(effectiveRequest);
      if (errors.length > 0 || successMetadata) {
        result.metadata = {
          ...(result.metadata || {}),
          ...(errors.length > 0 ? { recoveredAfterErrors: errors } : {}),
          ...(successMetadata || {}),
        };
      }
      return result;
    }

    errors.push(`${target.backend}: ${result.error || result.blockReason || "unknown error"}`);

    if (result.outcome === "fatal_error" || result.outcome === "blocked") {
      return {
        ...result,
        metadata: {
          ...(result.metadata || {}),
          attemptedBackends: executionTargets.map((item) => item.backend),
          phaseRegistry: phaseEntry,
        },
      };
    }
  }

  return createPhaseResult({
    ...request,
    backend: executionTargets[0]?.backend || "claude-cli",
    logPath: buildPhaseLogPath(
      request.issueNumber,
      request.repoSlug,
      request.phase,
      executionTargets[0]?.backend || "claude-cli",
    ),
  }, {
    outcome: errors.length > 0 ? "retryable_error" : "fatal_error",
    error: errors.join(" | ") || "All configured runners failed.",
    metadata: {
      attemptedBackends: executionTargets.map((target) => target.backend),
      phaseRegistry: phaseEntry,
    },
  });
}
