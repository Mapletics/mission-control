import { validateArtifactContract } from "@/lib/coding-factory/artifacts";
import { resolvePhaseConfig } from "@/lib/coding-factory/config";
import { buildExecutionTargets } from "@/lib/coding-factory/fallback-policy";
import { getPhaseRegistryEntry } from "@/lib/coding-factory-phase-registry";
import { ClaudeCliRunner } from "@/lib/coding-factory/runners/claude-cli";
import { CodexRunner } from "@/lib/coding-factory/runners/codex";
import { createPhaseResult } from "@/lib/coding-factory/runners/base";
import { SubagentRunner } from "@/lib/coding-factory/runners/subagent";
import type { PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";

const RUNNERS = {
  "claude-cli": new ClaudeCliRunner(),
  codex: new CodexRunner(),
  subagent: new SubagentRunner(),
} as const;

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
    const result = await runner.run({
      ...request,
      backend: target.backend,
      model: target.model,
      agentId: target.agentId,
      timeoutMinutes: target.timeoutMinutes,
    });

    if (result.ok) {
      if (errors.length > 0) {
        result.metadata = {
          ...(result.metadata || {}),
          recoveredAfterErrors: errors,
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
  }, {
    outcome: errors.length > 0 ? "retryable_error" : "fatal_error",
    error: errors.join(" | ") || "All configured runners failed.",
    metadata: {
      attemptedBackends: executionTargets.map((target) => target.backend),
      phaseRegistry: phaseEntry,
    },
  });
}
