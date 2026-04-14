import { getIssueArtifactSet, getPhaseArtifactContract } from "@/lib/coding-factory/artifacts";
import { buildPhasePrompt } from "@/lib/coding-factory/prompt-builder";
import type { CodingFactoryPromptContext, PhaseRunRequest } from "@/lib/coding-factory/types";

export function buildFixTestsRequest(context: Omit<CodingFactoryPromptContext, "artifacts"> & { worktreePath?: string }): Omit<PhaseRunRequest, "backend"> {
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
    integrationBranch: context.integrationBranch,
    worktreePath: context.worktreePath,
    phase: "fixTests",
    prompt: buildPhasePrompt("fixTests", { ...context, artifacts }),
    outputFiles: [artifacts.fixTestsFile],
    artifactContract: getPhaseArtifactContract(context.issueNumber, context.repoSlug, "fixTests"),
    artifactRefs: [artifacts.canonical.fixTests],
  };
}
