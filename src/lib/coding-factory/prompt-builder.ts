import type { CodingFactoryPhase, CodingFactoryPromptContext } from "@/lib/coding-factory/types";

export function buildPhasePrompt(phase: CodingFactoryPhase, context: CodingFactoryPromptContext): string {
  const issueHeader = [
    `ISSUE #${context.issueNumber}${context.issueTitle ? `: ${context.issueTitle}` : ""}`,
    context.issueBody?.trim() ? context.issueBody.trim() : "No issue body provided.",
  ].join("\n");

  const artifactBlock = [
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

  switch (phase) {
    case "research":
      return `${issueHeader}\n\nRepo: ${context.repoPath}\nBase branch: ${context.baseBranch}\n\nDo research only. Write findings to ${context.artifacts.researchFile}. No implementation code.`;
    case "plan":
      return `${issueHeader}\n\nRepo: ${context.repoPath}\nBase branch: ${context.baseBranch}\n\nRead the research file and produce an implementation plan. Write it to ${context.artifacts.planFile}. Keep legacy compatibility in mind with ${context.artifacts.legacyCompat.contractFile}. No implementation code.`;
    case "implement":
      return `${issueHeader}\n\nRepo: ${context.repoPath}\nBase branch: ${context.baseBranch}\n\nImplement only the agreed scope. Use the artifacts below and write an implementation summary to ${context.artifacts.implementationSummaryFile}:\n${artifactBlock}`;
    case "review":
      return `${issueHeader}\n\nReview the implementation against the plan and scope. Write the review summary to ${context.artifacts.reviewFile}. Use artifacts:\n${artifactBlock}`;
    case "fixAnalyze":
      return `${issueHeader}\n\nFix analyzer findings only. Stay in scope. Write the result summary to ${context.artifacts.fixAnalyzeFile}. Use artifacts:\n${artifactBlock}`;
    case "fixTests":
      return `${issueHeader}\n\nFix failing tests only. Stay in scope. Write the result summary to ${context.artifacts.fixTestsFile}. Use artifacts:\n${artifactBlock}`;
    case "pr":
      return `${issueHeader}\n\nPrepare the PR handover only. Summarize branch, scope, validation, and PR metadata in ${context.artifacts.prFile}. Use artifacts:\n${artifactBlock}`;
    default:
      return issueHeader;
  }
}
