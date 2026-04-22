import type { CodingFactoryPhase, CodingFactoryPromptContext } from "@/lib/coding-factory/types";

function buildArtifactBlock(context: CodingFactoryPromptContext): string {
  return [
    `Research: ${context.artifacts.researchFile}`,
    `Plan: ${context.artifacts.planFile}`,
    `Implementation summary: ${context.artifacts.implementationSummaryFile}`,
    `Review: ${context.artifacts.reviewFile}`,
    `Fix analyze: ${context.artifacts.fixAnalyzeFile}`,
    `Fix tests: ${context.artifacts.fixTestsFile}`,
    `PR: ${context.artifacts.prFile}`,
    `Legacy research compat: ${context.artifacts.legacyCompat.researchFile}`,
    `Legacy contract compat: ${context.artifacts.legacyCompat.contractFile}`,
    `Legacy log compat: ${context.artifacts.legacyCompat.logFile}`,
  ].join("\n");
}

export function buildPhasePrompt(phase: CodingFactoryPhase, context: CodingFactoryPromptContext): string {
  const issueHeader = [
    `ISSUE #${context.issueNumber}${context.issueTitle ? `: ${context.issueTitle}` : ""}`,
    context.issueBody?.trim() ? context.issueBody.trim() : "No issue body provided.",
  ].join("\n");

  const workspaceLine = `Repo path: ${context.repoPath}`;
  const branchLine = `Base branch: ${context.baseBranch}`;
  const branchStrategyLine = `Branch strategy: ${context.branchStrategy || "shared"}`;
  const workingBranchLine = context.workingBranch ? `Working branch: ${context.workingBranch}` : null;
  const integrationLine = context.integrationBranch ? `Integration branch: ${context.integrationBranch}` : null;
  const artifactBlock = buildArtifactBlock(context);
  const branchMetaBlock = `${workspaceLine}\n${branchLine}\n${branchStrategyLine}${workingBranchLine ? `\n${workingBranchLine}` : ""}${integrationLine ? `\n${integrationLine}` : ""}`;

  switch (phase) {
    case "research":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nDo research only. Write findings to ${context.artifacts.researchFile}. Do not change product code. Keep the branch model in mind: ${context.baseBranch} is the long-lived base branch, and issue work must stay on ${context.workingBranch || context.integrationBranch || context.baseBranch}. Return only after the artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "plan":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nRead the research file and produce an implementation plan. Write it to ${context.artifacts.planFile}. Keep legacy compatibility in mind with ${context.artifacts.legacyCompat.contractFile}. Do not change product code. The plan must assume ${context.baseBranch} is the base branch and issue implementation happens on ${context.workingBranch || context.integrationBranch || context.baseBranch}. Return only after the artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "implement":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nImplement only the agreed scope. ${context.baseBranch} is the long-lived base branch; do not work directly on it. If app work is needed, stay on ${context.workingBranch || context.integrationBranch || context.baseBranch}. In shared mode, do not create extra worktrees or issue branches; Coding Factory will create the per-issue commit for you. Write an implementation summary to ${context.artifacts.implementationSummaryFile}. Return only after the summary artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "review":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nReview the implementation against the plan and scope. Remember the active delivery branch is ${context.workingBranch || context.integrationBranch || context.baseBranch}. In isolated mode issue PRs target ${context.integrationBranch || context.baseBranch}; in shared mode the final run PR targets ${context.baseBranch}. Write the review summary to ${context.artifacts.reviewFile}. End the file with exactly one machine-readable line: NEXT_PHASE: pr or NEXT_PHASE: fixAnalyze. Return only after the review artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "fixAnalyze":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nFix analyzer findings only. Stay in scope. Keep work on ${context.workingBranch || context.integrationBranch || context.baseBranch}, not directly on ${context.baseBranch}. Write the result summary to ${context.artifacts.fixAnalyzeFile}. Use artifacts:\n${artifactBlock}`;
    case "fixTests":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nFix failing tests only. Stay in scope. Keep work on ${context.workingBranch || context.integrationBranch || context.baseBranch}, not directly on ${context.baseBranch}. Write the result summary to ${context.artifacts.fixTestsFile}. Use artifacts:\n${artifactBlock}`;
    case "pr":
      return `${issueHeader}\n\n${branchMetaBlock}\n\nPrepare the PR handover only. Summarize branch, scope, validation, and PR metadata in ${context.artifacts.prFile}. In isolated mode the issue PR targets ${context.integrationBranch || context.baseBranch}. In shared mode there is no per-issue PR; summarize handover for the final PR from ${context.workingBranch || context.baseBranch} to ${context.baseBranch}. Use artifacts:\n${artifactBlock}`;
    default:
      return issueHeader;
  }
}
