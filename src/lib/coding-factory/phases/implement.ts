import { buildPhaseLogPath, getIssueArtifactSet, getPhaseArtifactContract } from "@/lib/coding-factory/artifacts";
import { buildPhasePrompt } from "@/lib/coding-factory/prompt-builder";
import type { CodingFactoryPromptContext, PhaseRunRequest } from "@/lib/coding-factory/types";

export function buildImplementRequest(context: Omit<CodingFactoryPromptContext, "artifacts"> & { worktreePath?: string }): Omit<PhaseRunRequest, "backend"> {
  const artifacts = getIssueArtifactSet(context.issueNumber, context.repoSlug);
  return {
    version: 2,
    issueNumber: context.issueNumber,
    issueKey: `${context.repoSlug}#${context.issueNumber}`,
    issueTitle: context.issueTitle,
    issueBody: context.issueBody,
    repoSlug: context.repoSlug,
    repoPath: context.repoPath,
    baseBranch: context.baseBranch,
    worktreePath: context.worktreePath,
    phase: "implement",
    prompt: buildPhasePrompt("implement", { ...context, artifacts }),
    outputFiles: [artifacts.implementationSummaryFile],
    artifactContract: getPhaseArtifactContract(context.issueNumber, context.repoSlug, "implement"),
    artifactRefs: [artifacts.canonical.implement],
    logPath: buildPhaseLogPath(context.issueNumber, context.repoSlug, "implement", "claude-cli"),
  };
}
