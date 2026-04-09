import { buildPhaseLogPath, getIssueArtifactSet, getPhaseArtifactContract } from "@/lib/coding-factory/artifacts";
import { buildPhasePrompt } from "@/lib/coding-factory/prompt-builder";
import type { CodingFactoryPromptContext, PhaseRunRequest } from "@/lib/coding-factory/types";

export function buildReviewRequest(context: Omit<CodingFactoryPromptContext, "artifacts"> & { worktreePath?: string }): Omit<PhaseRunRequest, "backend"> {
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
    phase: "review",
    prompt: buildPhasePrompt("review", { ...context, artifacts }),
    outputFiles: [artifacts.reviewFile],
    artifactContract: getPhaseArtifactContract(context.issueNumber, context.repoSlug, "review"),
    artifactRefs: [artifacts.canonical.review],
    logPath: buildPhaseLogPath(context.issueNumber, context.repoSlug, "review", "claude-cli"),
  };
}
