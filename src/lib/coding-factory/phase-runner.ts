import { execFile } from "child_process";
import { access, readFile, stat, writeFile } from "fs/promises";
import { promisify } from "util";
import { buildPhaseLogPath, validateArtifactContract } from "@/lib/coding-factory/artifacts";
import { resolvePhaseConfig } from "@/lib/coding-factory/config";
import { buildExecutionTargets } from "@/lib/coding-factory/fallback-policy";
import { getPhaseRegistryEntry } from "@/lib/coding-factory-phase-registry";
import { ClaudeCliRunner } from "@/lib/coding-factory/runners/claude-cli";
import { CodexRunner } from "@/lib/coding-factory/runners/codex";
import { createPhaseResult, detectObviousNonArtifactOutput } from "@/lib/coding-factory/runners/base";
import { SubagentRunner } from "@/lib/coding-factory/runners/subagent";
import type { CodingFactoryPhase, PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";

const execFileAsync = promisify(execFile);

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
  invalid: Array<{
    path: string;
    outcome: "retryable_error" | "blocked";
    reason: string;
  }>;
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
  const invalid: Array<{
    path: string;
    outcome: "retryable_error" | "blocked";
    reason: string;
  }> = [];

  for (const path of requiredPaths) {
    const status = await fileExistsAndIsNonEmpty(path);
    if (!status.exists) {
      missing.push(path);
      continue;
    }
    if (!status.nonEmpty) {
      empty.push(path);
      continue;
    }

    try {
      const content = await readFile(path, "utf-8");
      const invalidOutput = detectObviousNonArtifactOutput(content);
      if (invalidOutput) {
        invalid.push({
          path,
          outcome: invalidOutput.outcome,
          reason: invalidOutput.reason,
        });
      }
    } catch {
      // Non-readable output files are handled by existence/emptiness checks above.
    }
  }

  return {
    ok: missing.length === 0 && empty.length === 0 && invalid.length === 0,
    missing,
    empty,
    invalid,
  };
}

async function tryReadText(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function tryRunGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15_000, maxBuffer: 512 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function clip(text: string, max = 1200): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}\n…`;
}

function getArtifactPath(request: PhaseRunRequest, key: string): string | undefined {
  return request.artifactRefs?.find((ref) => ref.key === key)?.path;
}

async function materializeLocalPrArtifact(request: PhaseRunRequest): Promise<string | null> {
  if (request.phase !== "pr") return null;
  const primaryOutput = request.artifactContract?.primaryOutput?.path
    || request.artifactRefs?.find((ref) => ref.required !== false)?.path
    || request.outputFiles?.[0];
  if (!primaryOutput) return null;

  const workspace = request.worktreePath || request.repoPath;
  const branch = await tryRunGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const committedRange = request.issueDiffBaseSha
    ? `${request.issueDiffBaseSha}..${request.issueDiffHeadSha || "HEAD"}`
    : `origin/${request.integrationBranch || request.baseBranch}...HEAD`;
  const committedChanged = await tryRunGit(workspace, [
    "diff",
    "--name-only",
    committedRange,
  ]);
  const workingTreeChanged = await tryRunGit(workspace, ["diff", "--name-only"]);
  const stagedChanged = await tryRunGit(workspace, ["diff", "--name-only", "--cached"]);
  const changedFiles = Array.from(new Set([
    ...committedChanged.split("\n"),
    ...workingTreeChanged.split("\n"),
    ...stagedChanged.split("\n"),
  ].map((line) => line.trim()).filter(Boolean)));

  const implementationSummary = await tryReadText(getArtifactPath(request, "implementation-summary.md"));
  const reviewSummary = await tryReadText(getArtifactPath(request, "review.md"));
  const fixAnalyzeSummary = await tryReadText(getArtifactPath(request, "fix-analyze.md"));
  const fixTestsSummary = await tryReadText(getArtifactPath(request, "fix-tests.md"));

  const validationLines = changedFiles.length > 0
    ? changedFiles.map((file) => `- ${file}`)
    : ["- No changed-file list available."];

  const lines = [
    `# Coding Factory PR Handover`,
    "",
    `Resolves #${request.issueNumber}`,
    "",
    `## Branches`,
    `- Base branch: ${request.baseBranch}`,
    `- Branch strategy: ${request.branchStrategy || "shared"}`,
    request.workingBranch ? `- Working branch: ${request.workingBranch}` : null,
    request.integrationBranch ? `- Integration branch: ${request.integrationBranch}` : null,
    branch ? `- Active branch: ${branch}` : null,
    "",
    `## Scope`,
    request.issueTitle ? `- Issue: ${request.issueTitle}` : `- Issue #${request.issueNumber}`,
    request.branchStrategy === "isolated"
      ? `- This issue PR targets \`${request.integrationBranch || request.baseBranch}\`; the final integration PR targets \`${request.baseBranch}\`.`
      : `- This issue stays on shared working branch \`${request.workingBranch || branch || request.baseBranch}\`; the final PR targets \`${request.baseBranch}\`.`,
    changedFiles.length > 0 ? `- Changed files: ${changedFiles.join(", ")}` : "- Changed files: see commit diff",
    "",
    `## Implementation summary`,
    clip(implementationSummary) || "No implementation summary artifact was available.",
    "",
    `## Review summary`,
    clip(reviewSummary) || "No review summary artifact was available.",
    fixAnalyzeSummary.trim() ? `\n## Fix analyze summary\n${clip(fixAnalyzeSummary)}` : null,
    fixTestsSummary.trim() ? `\n## Fix tests summary\n${clip(fixTestsSummary)}` : null,
    "",
    `## Validation`,
    reviewSummary.trim()
      ? "- Review artifact exists and approved the change or routed to this PR handoff."
      : "- Review artifact unavailable; validate manually.",
    ...validationLines,
    "",
    `## Notes`,
    "- PR body generated locally by Coding Factory fallback to avoid external handover-tool outages.",
  ].filter((line): line is string => Boolean(line));

  await writeFile(primaryOutput, `${lines.join("\n")}\n`, "utf-8");
  return primaryOutput;
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
  if (request.phase === "pr") {
    const materializedOutputPath = await materializeLocalPrArtifact({
      ...request,
      backend: "codex",
      logPath: buildPhaseLogPath(request.issueNumber, request.repoSlug, request.phase, "codex"),
    });
    if (materializedOutputPath) {
      return createPhaseResult({
        ...request,
        backend: "codex",
        logPath: buildPhaseLogPath(request.issueNumber, request.repoSlug, request.phase, "codex"),
      }, {
        outcome: "success",
        startedAt: new Date().toISOString(),
        summary: `PR handover generated locally at ${materializedOutputPath}.`,
        metadata: {
          materializedOutputPath,
          localPrFallback: true,
          phaseRegistry: phaseEntry,
        },
      });
    }
  }
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
        const runnerOutputSignal = detectObviousNonArtifactOutput(result.summary || undefined);
        const invalidSignals = [
          ...outputValidation.invalid,
          ...(runnerOutputSignal && outputValidation.invalid.length === 0
            ? [{
                path: "<runner-output>",
                outcome: runnerOutputSignal.outcome,
                reason: runnerOutputSignal.reason,
              }]
            : []),
        ];
        const invalidDetail = invalidSignals.map((item) => `${item.path} (${item.reason})`);
        const validationError = [
          outputValidation.missing.length > 0
            ? `missing outputs: ${outputValidation.missing.join(", ")}`
            : null,
          outputValidation.empty.length > 0
            ? `empty outputs: ${outputValidation.empty.join(", ")}`
            : null,
          invalidDetail.length > 0
            ? `non-artifact outputs: ${invalidDetail.join(", ")}`
            : null,
        ].filter(Boolean).join(" | ");
        const validationOutcome = invalidSignals.some((item) => item.outcome === "retryable_error")
          ? "retryable_error"
          : invalidSignals.length > 0
            ? "blocked"
            : "fatal_error";

        return createPhaseResult(effectiveRequest, {
          outcome: validationOutcome,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          summary: result.summary,
          error: `Phase ${request.phase} reported success but failed post-run validation: ${validationError}`,
          blockReason: validationOutcome === "blocked" ? validationError : undefined,
          retryHint: validationOutcome === "retryable_error"
            ? "Retry the same phase after the environment or quota issue is resolved."
            : "Re-run the same phase only after the required output artifact is written successfully.",
          logPath: result.logPath,
          stdoutPath: result.stdoutPath,
          outputFiles: result.outputFiles,
          artifacts: result.artifacts,
          command: result.command,
          metadata: {
            ...(result.metadata || {}),
            postRunValidation: {
              ...outputValidation,
              invalid: invalidSignals,
            },
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

    const isLastTarget = target === executionTargets[executionTargets.length - 1];
    if (result.outcome === "fatal_error" || (result.outcome === "blocked" && isLastTarget)) {
      return {
        ...result,
        metadata: {
          ...(result.metadata || {}),
          attemptedBackends: executionTargets.map((item) => item.backend),
          phaseRegistry: phaseEntry,
          ...(errors.length > 1 ? { recoveredAfterErrors: errors.slice(0, -1) } : {}),
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
