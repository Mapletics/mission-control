export const CODING_FACTORY_PHASES = [
  "research",
  "plan",
  "implement",
  "review",
  "fixAnalyze",
  "fixTests",
  "pr",
] as const;

export const CODING_FACTORY_CORE_SUBAGENT_PHASES = [
  "research",
  "plan",
  "implement",
  "review",
] as const;

export const CODING_FACTORY_BACKENDS = [
  "claude-cli",
  "codex",
  "subagent",
] as const;

export const CODING_FACTORY_PROFILES = [
  "balanced",
  "codex-only",
  "claude-only",
  "max-quality",
  "cheap-fast",
] as const;

export const CODING_FACTORY_RUNNER_RESULT_KINDS = [
  "success",
  "retryable_error",
  "fatal_error",
  "blocked",
] as const;

export type CodingFactoryPhase = typeof CODING_FACTORY_PHASES[number];
export type CodingFactoryCoreSubagentPhase = typeof CODING_FACTORY_CORE_SUBAGENT_PHASES[number];
export type CodingFactoryBackend = typeof CODING_FACTORY_BACKENDS[number];
export type CodingFactoryProfile = typeof CODING_FACTORY_PROFILES[number];
export type CodingFactoryRunnerResultKind = typeof CODING_FACTORY_RUNNER_RESULT_KINDS[number];

export type CodingFactoryFallbackTarget = {
  backend: CodingFactoryBackend;
  model?: string;
  agentId?: string;
};

export type CodingFactoryPhaseConfig = {
  backend: CodingFactoryBackend;
  model?: string;
  agentId?: string;
  timeoutMinutes: number;
  fallback?: CodingFactoryFallbackTarget[];
};

export type CodingFactoryPipelineConfig = {
  version: number;
  defaults: {
    targetRepo: string;
    baseBranch: string;
    timeoutMinutes: number;
    profile?: CodingFactoryProfile;
  };
  phases: Record<CodingFactoryPhase, CodingFactoryPhaseConfig>;
  repoOverrides?: Record<string, Partial<Record<CodingFactoryPhase, Partial<CodingFactoryPhaseConfig>>>>;
};

export type CodingFactoryPhaseExecutionTarget = {
  backend: CodingFactoryBackend;
  model?: string;
  agentId?: string;
  timeoutMinutes?: number;
};

export type CodingFactoryArtifactRef = {
  key: string;
  phase: CodingFactoryPhase;
  path: string;
  required: boolean;
  canonical: boolean;
  kind?: "markdown" | "json" | "log" | "text";
  label?: string;
  aliases?: string[];
};

export type CodingFactoryPhaseArtifactContract = {
  required: CodingFactoryArtifactRef[];
  optional?: CodingFactoryArtifactRef[];
  primaryOutput?: CodingFactoryArtifactRef | null;
};

export type CodingFactoryPhaseRegistryEntry = {
  phase: CodingFactoryPhase;
  title: string;
  order: number;
  requiredArtifacts: readonly string[];
  defaultBackend?: CodingFactoryBackend;
  defaultAgentId?: string;
  successPhase?: CodingFactoryPhase | null;
  failurePhase?: CodingFactoryPhase | null;
};

export type CodingFactoryPhaseExecutionRecord = {
  version: 2;
  phase: CodingFactoryPhase;
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
  attempts: number;
  runner?: {
    backend: CodingFactoryBackend;
    model?: string;
    agentId?: string;
    outcome?: CodingFactoryRunnerResultKind;
  };
  artifacts: CodingFactoryArtifactRef[];
  latestResult?: PhaseRunResult;
  lastAttemptAt?: string;
  completedAt?: string;
  blockedReason?: string;
};

export type CodingFactoryIssueExecutionV2 = {
  version: 2;
  issueKey: string;
  profile: CodingFactoryProfile;
  currentPhase: CodingFactoryPhase | null;
  resumeFromPhase: CodingFactoryPhase | null;
  phases: Partial<Record<CodingFactoryPhase, CodingFactoryPhaseExecutionRecord>>;
  attempts: number;
  result?: CodingFactoryRunnerResultKind;
  blockedReason?: string;
};

export type CodingFactoryRunExecutionV2 = {
  version: 2;
  profile: CodingFactoryProfile;
  queue: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
  };
  currentIssueKey?: string | null;
  currentPhase?: CodingFactoryPhase | null;
};

export type PhaseRunRequest = {
  version: 2;
  runId?: string;
  profile?: CodingFactoryProfile;
  issueNumber: number;
  issueKey?: string;
  issueTitle?: string;
  issueBody?: string;
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
  integrationBranch?: string;
  /**
   * Optional isolated workspace chosen by the caller.
   * If absent, runners operate directly in repoPath.
   */
  worktreePath?: string;
  phase: CodingFactoryPhase;
  prompt: string;
  attempt?: number;
  outputFiles?: string[];
  artifactContract?: CodingFactoryPhaseArtifactContract;
  artifactRefs?: CodingFactoryArtifactRef[];
  logPath?: string;
} & CodingFactoryPhaseExecutionTarget;

export type PhaseRunResult = {
  ok: boolean;
  outcome: CodingFactoryRunnerResultKind;
  phase: CodingFactoryPhase;
  backend: CodingFactoryBackend;
  model?: string;
  agentId?: string;
  startedAt: string;
  finishedAt: string;
  summary?: string;
  error?: string;
  blockReason?: string;
  retryHint?: string;
  stdoutPath?: string;
  logPath?: string;
  outputFiles?: string[];
  artifacts?: CodingFactoryArtifactRef[];
  command?: string[];
  metrics?: {
    durationMs?: number;
  };
  metadata?: Record<string, unknown>;
};

export type CodingFactoryPhaseArtifactSet = {
  rootDir: string;
  issueKey: string;
  canonical: Record<CodingFactoryPhase, CodingFactoryArtifactRef>;
  required: CodingFactoryArtifactRef[];
  legacyCompat: {
    researchFile: string;
    contractFile: string;
    logFile: string;
  };
  researchFile: string;
  planFile: string;
  implementationSummaryFile: string;
  reviewFile: string;
  fixAnalyzeFile: string;
  fixTestsFile: string;
  prFile: string;
  logDir: string;
  logFile: string;
};

export type CodingFactoryPromptContext = {
  issueNumber: number;
  issueTitle?: string;
  issueBody?: string;
  repoSlug: string;
  repoPath: string;
  baseBranch: string;
  integrationBranch?: string;
  artifacts: CodingFactoryPhaseArtifactSet;
};
