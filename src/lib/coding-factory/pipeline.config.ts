import type { CodingFactoryPipelineConfig } from "@/lib/coding-factory/types";

export const codingFactoryPipelineConfig: CodingFactoryPipelineConfig = {
  version: 2,
  defaults: {
    targetRepo: "Mapletics/App_frontend",
    baseBranch: "dev",
    timeoutMinutes: 45,
    profile: "balanced",
  },
  phases: {
    research: {
      backend: "subagent",
      agentId: "barney",
      timeoutMinutes: 15,
    },
    plan: {
      backend: "subagent",
      agentId: "claudia",
      timeoutMinutes: 20,
    },
    implement: {
      backend: "subagent",
      agentId: "manfred",
      timeoutMinutes: 60,
    },
    review: {
      backend: "subagent",
      agentId: "barney",
      timeoutMinutes: 30,
    },
    fixAnalyze: {
      backend: "codex",
      model: "gpt-5.4",
      timeoutMinutes: 20,
      fallback: [{ backend: "subagent", agentId: "manfred" }],
    },
    fixTests: {
      backend: "codex",
      model: "gpt-5.4",
      timeoutMinutes: 20,
      fallback: [{ backend: "subagent", agentId: "manfred" }],
    },
    pr: {
      backend: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMinutes: 20,
      fallback: [{ backend: "codex", model: "gpt-5.4" }],
    },
  },
  repoOverrides: {
    "Mapletics/mapletics-dashboard": {
      research: { backend: "subagent", agentId: "barney" },
      plan: { backend: "subagent", agentId: "claudia" },
      implement: { backend: "subagent", agentId: "manfred" },
      review: { backend: "subagent", agentId: "barney" },
      pr: { backend: "claude-cli", model: "claude-sonnet-4-6" },
    },
    "Mapletics/mapletics-website": {
      research: { backend: "subagent", agentId: "barney" },
      plan: { backend: "subagent", agentId: "claudia" },
      implement: { backend: "subagent", agentId: "manfred" },
      review: { backend: "subagent", agentId: "barney" },
      pr: { backend: "claude-cli", model: "claude-sonnet-4-6" },
    },
  },
};
