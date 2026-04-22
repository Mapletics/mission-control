import { getIssueArtifactSet, getPhaseArtifactContract } from "@/lib/coding-factory/artifacts";
import { buildPhasePrompt } from "@/lib/coding-factory/prompt-builder";
import type { CodingFactoryPromptContext, PhaseRunRequest } from "@/lib/coding-factory/types";

export function buildPrRequest(context: Omit<CodingFactoryPromptContext, "artifacts"> & { worktreePath?: string }): Omit<PhaseRunRequest, "backend"> {
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
    branchStrategy: context.branchStrategy,
    workingBranch: context.workingBranch,
    integrationBranch: context.integrationBranch,
    worktreePath: context.worktreePath,
    phase: "pr",
    prompt: buildPhasePrompt("pr", { ...context, artifacts }),
    outputFiles: [artifacts.prFile],
    artifactContract: getPhaseArtifactContract(context.issueNumber, context.repoSlug, "pr"),
    artifactRefs: [artifacts.canonical.pr],
  };
}
