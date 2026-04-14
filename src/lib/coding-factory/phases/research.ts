import { getIssueArtifactSet, getPhaseArtifactContract } from "@/lib/coding-factory/artifacts";
import { buildPhasePrompt } from "@/lib/coding-factory/prompt-builder";
import type { CodingFactoryPromptContext, PhaseRunRequest } from "@/lib/coding-factory/types";

export function buildResearchRequest(context: Omit<CodingFactoryPromptContext, "artifacts">): Omit<PhaseRunRequest, "backend"> {
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
    phase: "research",
    prompt: buildPhasePrompt("research", { ...context, artifacts }),
    outputFiles: [artifacts.researchFile],
    artifactContract: getPhaseArtifactContract(context.issueNumber, context.repoSlug, "research"),
    artifactRefs: [artifacts.canonical.research],
  };
}
