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
      backend: "codex",
      model: "gpt-5.4",
      timeoutMinutes: 15,
      fallback: [{ backend: "claude-cli", model: "claude-sonnet-4-6" }],
    },
    plan: {
      backend: "codex",
      model: "gpt-5.4",
      timeoutMinutes: 20,
      fallback: [{ backend: "claude-cli", model: "claude-sonnet-4-6" }],
    },
    implement: {
      backend: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMinutes: 60,
      fallback: [{ backend: "codex", model: "gpt-5.4" }],
    },
    review: {
      backend: "claude-cli",
      model: "claude-sonnet-4-6",
      timeoutMinutes: 30,
      fallback: [{ backend: "codex", model: "gpt-5.4" }],
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
      research: { backend: "codex", model: "gpt-5.4" },
      plan: { backend: "codex", model: "gpt-5.4" },
      implement: { backend: "claude-cli", model: "claude-sonnet-4-6" },
      review: { backend: "claude-cli", model: "claude-sonnet-4-6" },
      pr: { backend: "claude-cli", model: "claude-sonnet-4-6" },
    },
    "Mapletics/mapletics-website": {
      research: { backend: "codex", model: "gpt-5.4" },
      plan: { backend: "codex", model: "gpt-5.4" },
      implement: { backend: "claude-cli", model: "claude-sonnet-4-6" },
      review: { backend: "claude-cli", model: "claude-sonnet-4-6" },
      pr: { backend: "claude-cli", model: "claude-sonnet-4-6" },
    },
  },
};
