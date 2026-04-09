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
  const artifactBlock = buildArtifactBlock(context);

  switch (phase) {
    case "research":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nDo research only. Write findings to ${context.artifacts.researchFile}. Do not change product code. Return only after the artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "plan":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nRead the research file and produce an implementation plan. Write it to ${context.artifacts.planFile}. Keep legacy compatibility in mind with ${context.artifacts.legacyCompat.contractFile}. Do not change product code. Return only after the artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "implement":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nImplement only the agreed scope. If app work is needed, use ${context.baseBranch} as the base branch. Write an implementation summary to ${context.artifacts.implementationSummaryFile}. Return only after the summary artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "review":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nReview the implementation against the plan and scope. Write the review summary to ${context.artifacts.reviewFile}. End the file with exactly one machine-readable line: NEXT_PHASE: pr or NEXT_PHASE: fixAnalyze. Return only after the review artifact exists and is non-empty.\n\nArtifacts:\n${artifactBlock}`;
    case "fixAnalyze":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nFix analyzer findings only. Stay in scope. Write the result summary to ${context.artifacts.fixAnalyzeFile}. Use artifacts:\n${artifactBlock}`;
    case "fixTests":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nFix failing tests only. Stay in scope. Write the result summary to ${context.artifacts.fixTestsFile}. Use artifacts:\n${artifactBlock}`;
    case "pr":
      return `${issueHeader}\n\n${workspaceLine}\n${branchLine}\n\nPrepare the PR handover only. Summarize branch, scope, validation, and PR metadata in ${context.artifacts.prFile}. Use artifacts:\n${artifactBlock}`;
    default:
      return issueHeader;
  }
}
