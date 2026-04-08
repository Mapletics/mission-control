export const RUN_STATES = [
  "created",
  "intake_validated",
  "queued",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "stuck",
] as const;

export const ISSUE_STATES = [
  "created",
  "queued",
  "research_only",
  "plan_ready",
  "code_in_progress",
  "pr_created",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "stale",
] as const;

export type CodingFactoryRunStateName = (typeof RUN_STATES)[number];
export type CodingFactoryIssueStateName = (typeof ISSUE_STATES)[number];
export type TransitionSource = "persisted" | "legacy-history" | "legacy-top-level" | "derived" | "api";

export type StateTransition<S extends string> = {
  from: S;
  to: S;
  at: string;
  source: TransitionSource;
  reason?: string;
};

type LegacyHistoryLike = {
  phase?: string;
  status?: string;
  at?: string;
  round?: number;
  extra?: string;
};

const RUN_TRANSITIONS: Record<CodingFactoryRunStateName, readonly CodingFactoryRunStateName[]> = {
  created: ["intake_validated", "queued", "cancelled"],
  intake_validated: ["queued", "running", "blocked", "failed", "cancelled", "stuck"],
  queued: ["running", "blocked", "failed", "cancelled", "stuck"],
  running: ["completed", "blocked", "failed", "cancelled", "stuck"],
  completed: [],
  blocked: ["queued", "running", "failed", "cancelled", "stuck", "completed"],
  failed: ["queued", "running", "cancelled", "stuck"],
  cancelled: ["queued"],
  stuck: ["queued", "running", "failed", "cancelled"],
};

const ISSUE_TRANSITIONS: Record<CodingFactoryIssueStateName, readonly CodingFactoryIssueStateName[]> = {
  created: ["queued", "research_only", "blocked", "failed", "cancelled", "stale"],
  queued: ["research_only", "plan_ready", "code_in_progress", "blocked", "failed", "cancelled", "stale"],
  research_only: ["plan_ready", "code_in_progress", "blocked", "failed", "cancelled", "stale"],
  plan_ready: ["code_in_progress", "blocked", "failed", "cancelled", "stale"],
  code_in_progress: ["pr_created", "completed", "blocked", "failed", "cancelled", "stale"],
  pr_created: ["completed", "blocked", "failed", "cancelled", "stale"],
  completed: [],
  blocked: ["queued", "research_only", "plan_ready", "code_in_progress", "pr_created", "completed", "failed", "cancelled", "stale"],
  failed: ["queued", "research_only", "plan_ready", "code_in_progress", "pr_created", "completed", "cancelled", "stale"],
  cancelled: ["queued", "research_only", "plan_ready", "code_in_progress"],
  stale: ["queued", "research_only", "plan_ready", "code_in_progress", "failed", "cancelled"],
};

const RUN_TERMINAL_STATES = new Set<CodingFactoryRunStateName>(["completed", "blocked", "failed", "cancelled", "stuck"]);
const ISSUE_TERMINAL_STATES = new Set<CodingFactoryIssueStateName>(["completed", "blocked", "failed", "cancelled", "stale"]);
const ISSUE_COMPLETED_STATES = new Set<CodingFactoryIssueStateName>(["completed", "pr_created"]);
const ISSUE_ACTIVE_WORK_STATES = new Set<CodingFactoryIssueStateName>(["code_in_progress"]);

const LEGACY_ISSUE_STATE_ALIASES: Record<string, CodingFactoryIssueStateName> = {
  planning: "research_only",
  implementing: "code_in_progress",
  reviewing: "code_in_progress",
  fixing: "code_in_progress",
  approved: "code_in_progress",
  "research-only": "research_only",
  "plan-ready": "plan_ready",
  "code-in-progress": "code_in_progress",
  "pr-created": "pr_created",
  stuck: "stale",
};

function isValidDate(value: string | undefined): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

function normalizeTransitionAt(at: string | undefined): string {
  return isValidDate(at) ? at : new Date().toISOString();
}

export function isRunState(value: unknown): value is CodingFactoryRunStateName {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function isIssueState(value: unknown): value is CodingFactoryIssueStateName {
  return typeof value === "string" && (ISSUE_STATES as readonly string[]).includes(value);
}

export function coerceIssueState(value: unknown): CodingFactoryIssueStateName | null {
  if (isIssueState(value)) return value;
  if (typeof value !== "string") return null;
  return LEGACY_ISSUE_STATE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function isTerminalRunState(state: CodingFactoryRunStateName): boolean {
  return RUN_TERMINAL_STATES.has(state);
}

export function isTerminalIssueState(state: CodingFactoryIssueStateName): boolean {
  return ISSUE_TERMINAL_STATES.has(state);
}

export function isCompletedIssueState(state: CodingFactoryIssueStateName): boolean {
  return ISSUE_COMPLETED_STATES.has(state);
}

export function isActiveIssueState(state: CodingFactoryIssueStateName): boolean {
  return ISSUE_ACTIVE_WORK_STATES.has(state);
}

export function legacyRunStatusFromState(
  state: CodingFactoryRunStateName,
  options: { hasSelectedIssues?: boolean } = {},
): "draft" | "running" | "completed" | "idle" | "unknown" {
  switch (state) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "created":
      return options.hasSelectedIssues ? "draft" : "idle";
    case "intake_validated":
    case "queued":
      return "draft";
    case "blocked":
    case "failed":
    case "cancelled":
    case "stuck":
      return "unknown";
    default:
      return "unknown";
  }
}

export function inferRunStateFromLegacyStatus(
  status: string | undefined,
  options: { hasSelectedIssues?: boolean } = {},
): CodingFactoryRunStateName {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "idle":
      return "created";
    case "draft":
      return options.hasSelectedIssues ? "intake_validated" : "created";
    default:
      return options.hasSelectedIssues ? "intake_validated" : "created";
  }
}

export function issuePhaseFromState(state: CodingFactoryIssueStateName): string {
  switch (state) {
    case "created":
    case "queued":
      return "classify";
    case "research_only":
      return "research";
    case "plan_ready":
      return "plan";
    case "code_in_progress":
      return "implement";
    case "pr_created":
      return "pr-created";
    case "completed":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "aborted";
    case "stale":
      return "blocked";
    default:
      return "started";
  }
}

export function canApplyRunTransition(from: CodingFactoryRunStateName, to: CodingFactoryRunStateName): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

export function canApplyIssueTransition(from: CodingFactoryIssueStateName, to: CodingFactoryIssueStateName): boolean {
  return from === to || ISSUE_TRANSITIONS[from].includes(to);
}

export function applyRunTransition(
  current: {
    state: CodingFactoryRunStateName;
    stateHistory?: StateTransition<CodingFactoryRunStateName>[];
    stateUpdatedAt?: string;
  },
  next: {
    to: CodingFactoryRunStateName;
    at?: string;
    source?: TransitionSource;
    reason?: string;
  },
): {
  state: CodingFactoryRunStateName;
  stateHistory: StateTransition<CodingFactoryRunStateName>[];
  stateUpdatedAt: string;
} {
  const at = normalizeTransitionAt(next.at);
  const stateHistory = [...(current.stateHistory ?? [])];

  if (!canApplyRunTransition(current.state, next.to)) {
    throw new Error(`Invalid run transition: ${current.state} -> ${next.to}`);
  }

  if (current.state === next.to) {
    return {
      state: current.state,
      stateHistory,
      stateUpdatedAt: current.stateUpdatedAt ?? at,
    };
  }

  stateHistory.push({
    from: current.state,
    to: next.to,
    at,
    source: next.source ?? "api",
    reason: next.reason,
  });

  return {
    state: next.to,
    stateHistory,
    stateUpdatedAt: at,
  };
}

export function applyIssueTransition(
  current: {
    state: CodingFactoryIssueStateName;
    stateHistory?: StateTransition<CodingFactoryIssueStateName>[];
    stateUpdatedAt?: string;
  },
  next: {
    to: CodingFactoryIssueStateName;
    at?: string;
    source?: TransitionSource;
    reason?: string;
  },
): {
  state: CodingFactoryIssueStateName;
  stateHistory: StateTransition<CodingFactoryIssueStateName>[];
  stateUpdatedAt: string;
} {
  const at = normalizeTransitionAt(next.at);
  const stateHistory = [...(current.stateHistory ?? [])];

  if (!canApplyIssueTransition(current.state, next.to)) {
    throw new Error(`Invalid issue transition: ${current.state} -> ${next.to}`);
  }

  if (current.state === next.to) {
    return {
      state: current.state,
      stateHistory,
      stateUpdatedAt: current.stateUpdatedAt ?? at,
    };
  }

  stateHistory.push({
    from: current.state,
    to: next.to,
    at,
    source: next.source ?? "api",
    reason: next.reason,
  });

  return {
    state: next.to,
    stateHistory,
    stateUpdatedAt: at,
  };
}

function normalizeHistoryPhase(phase: string | undefined): string {
  const raw = (phase || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("analyze-fix")) return "code_in_progress";
  if (raw.startsWith("analyze-")) return "code_in_progress";
  if (raw.startsWith("review-")) return "code_in_progress";
  if (raw === "classify") return "created";
  if (raw === "research") return "research_only";
  if (raw === "plan") return "plan_ready";
  if (raw === "implement") return "code_in_progress";
  if (raw === "review") return "code_in_progress";
  if (raw === "gate") return "code_in_progress";
  if (raw === "ship") return "pr_created";
  if (raw === "done") return "completed";
  if (raw === "pr-created") return "pr_created";
  if (raw === "failed") return "failed";
  if (raw === "blocked") return "blocked";
  if (raw === "aborted") return "cancelled";
  if (raw === "stuck") return "stale";
  if (raw === "started") return "created";
  return raw;
}

export function inferIssueStateFromLegacyTopLevel(input: {
  phase?: string;
  status?: string;
  prUrl?: string;
  merged?: boolean;
  planApproved?: boolean;
  branch?: string;
  codeProduced?: boolean;
}): CodingFactoryIssueStateName {
  if (input.merged) return "completed";

  const normalizedPhase = (input.phase || "").trim().toLowerCase();
  if (input.prUrl && (normalizedPhase === "pr-created" || normalizedPhase === "ship" || normalizedPhase === "done")) {
    return "pr_created";
  }

  switch (normalizedPhase) {
    case "classify":
    case "started":
      return "created";
    case "research":
      return "research_only";
    case "plan":
      return input.planApproved ? "plan_ready" : "research_only";
    case "implement":
    case "review":
    case "gate":
      return "code_in_progress";
    case "ship":
    case "pr-created":
      return "pr_created";
    case "done":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    case "stuck":
      return "stale";
    default:
      if (input.codeProduced || Boolean(input.branch)) return input.prUrl ? "pr_created" : "code_in_progress";
      return input.prUrl ? "pr_created" : "created";
  }
}

export function inferIssueStateFromHistoryEvent(event: LegacyHistoryLike): CodingFactoryIssueStateName | null {
  const normalizedPhase = normalizeHistoryPhase(event.phase);
  const normalizedStatus = (event.status || "").trim().toLowerCase();

  if (normalizedStatus === "approved") return normalizedPhase === "pr_created" ? "pr_created" : "code_in_progress";
  if (normalizedStatus === "analyze_fix") return "code_in_progress";
  if (normalizedStatus === "analyze_pass") return "code_in_progress";
  if (normalizedStatus === "passed" && normalizedPhase === "code_in_progress") return "code_in_progress";
  if (normalizedStatus === "passed" && normalizedPhase === "pr_created") return "pr_created";
  if (normalizedStatus === "failed") return "failed";
  if (normalizedStatus === "blocked") return "blocked";
  if (normalizedStatus === "cancelled" || normalizedStatus === "aborted") return "cancelled";
  if (normalizedStatus === "done" && normalizedPhase === "created") return "queued";

  if (normalizedPhase === "created") return "queued";
  if (normalizedPhase === "research_only") return "research_only";
  if (normalizedPhase === "plan_ready") return normalizedStatus === "done" ? "plan_ready" : "research_only";
  if (normalizedPhase === "code_in_progress") return "code_in_progress";
  if (normalizedPhase === "pr_created") return "pr_created";
  if (normalizedPhase === "completed") return "completed";
  if (normalizedPhase === "failed") return "failed";
  if (normalizedPhase === "blocked") return "blocked";
  if (normalizedPhase === "cancelled") return "cancelled";
  if (normalizedPhase === "stale") return "stale";

  return null;
}

export function normalizePersistedTransitions<S extends string>(
  input: unknown,
  guard: (value: unknown) => value is S,
  options: { coerce?: (value: unknown) => S | null } = {},
): StateTransition<S>[] {
  if (!Array.isArray(input)) return [];

  const transitions: StateTransition<S>[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const from = options.coerce?.(item.from) ?? (guard(item.from) ? item.from : null);
    const to = options.coerce?.(item.to) ?? (guard(item.to) ? item.to : null);
    if (!from || !to) continue;
    transitions.push({
      from,
      to,
      at: normalizeTransitionAt(typeof item.at === "string" ? item.at : undefined),
      source: typeof item.source === "string" ? item.source as TransitionSource : "persisted",
      reason: typeof item.reason === "string" ? item.reason : undefined,
    });
  }

  return transitions.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function deriveIssueStateHistory(input: {
  history?: LegacyHistoryLike[];
  phase?: string;
  status?: string;
  prUrl?: string;
  merged?: boolean;
  updatedAt?: string;
  startedAt?: string;
  planApproved?: boolean;
  branch?: string;
  codeProduced?: boolean;
}): {
  state: CodingFactoryIssueStateName;
  stateHistory: StateTransition<CodingFactoryIssueStateName>[];
  stateUpdatedAt: string;
} {
  let current: {
    state: CodingFactoryIssueStateName;
    stateHistory: StateTransition<CodingFactoryIssueStateName>[];
    stateUpdatedAt: string;
  } = {
    state: "created",
    stateHistory: [],
    stateUpdatedAt: normalizeTransitionAt(input.startedAt ?? input.updatedAt),
  };

  const history = Array.isArray(input.history) ? input.history : [];
  for (const event of history) {
    const to = inferIssueStateFromHistoryEvent(event);
    if (!to) continue;
    try {
      current = applyIssueTransition(current, {
        to,
        at: event.at,
        source: "legacy-history",
        reason: `${event.phase ?? "event"}:${event.status ?? ""}`,
      });
    } catch {
      // Legacy histories can be sparse or skip steps. Keep processing and let top-level bridge finish.
    }
  }

  const topLevelState = inferIssueStateFromLegacyTopLevel(input);
  if (current.state !== topLevelState) {
    try {
      current = applyIssueTransition(current, {
        to: topLevelState,
        at: input.updatedAt,
        source: "legacy-top-level",
        reason: `phase:${input.phase ?? "unknown"}`,
      });
    } catch {
      current = {
        state: topLevelState,
        stateHistory: current.stateHistory,
        stateUpdatedAt: normalizeTransitionAt(input.updatedAt),
      };
    }
  }

  return current;
}

export function deriveRunStateHistory(input: {
  status?: string;
  state?: CodingFactoryRunStateName;
  stateHistory?: StateTransition<CodingFactoryRunStateName>[];
  updatedAt?: string;
  hasSelectedIssues?: boolean;
}): {
  state: CodingFactoryRunStateName;
  stateHistory: StateTransition<CodingFactoryRunStateName>[];
  stateUpdatedAt: string;
} {
  const persistedHistory = input.stateHistory ?? [];
  if (persistedHistory.length > 0) {
    const last = persistedHistory[persistedHistory.length - 1];
    const state = input.state ?? last.to;
    return {
      state,
      stateHistory: persistedHistory,
      stateUpdatedAt: input.updatedAt ?? last.at,
    };
  }

  const fallbackState = input.state ?? inferRunStateFromLegacyStatus(input.status, {
    hasSelectedIssues: input.hasSelectedIssues,
  });

  let current: {
    state: CodingFactoryRunStateName;
    stateHistory: StateTransition<CodingFactoryRunStateName>[];
    stateUpdatedAt: string;
  } = {
    state: "created",
    stateHistory: [],
    stateUpdatedAt: normalizeTransitionAt(input.updatedAt),
  };

  if (fallbackState !== "created") {
    const steps: CodingFactoryRunStateName[] =
      fallbackState === "running"
        ? [input.hasSelectedIssues ? "intake_validated" : "created", "queued", "running"]
        : fallbackState === "completed"
          ? [input.hasSelectedIssues ? "intake_validated" : "created", "queued", "running", "completed"]
          : fallbackState === "intake_validated"
            ? ["intake_validated"]
            : fallbackState === "queued"
              ? [input.hasSelectedIssues ? "intake_validated" : "created", "queued"]
              : [fallbackState];

    for (const to of steps) {
      if (to === current.state) continue;
      try {
        current = applyRunTransition(current, {
          to,
          at: input.updatedAt,
          source: "legacy-top-level",
          reason: `status:${input.status ?? "unknown"}`,
        });
      } catch {
        current = {
          state: to,
          stateHistory: current.stateHistory,
          stateUpdatedAt: normalizeTransitionAt(input.updatedAt),
        };
      }
    }
  }

  return current;
}

export function resolveRunStateFromIssues(input: {
  currentState: CodingFactoryRunStateName;
  selectedIssueStates: CodingFactoryIssueStateName[];
  isNightModeRunning?: boolean;
  finishedAt?: string | null;
}): CodingFactoryRunStateName {
  if (input.isNightModeRunning) {
    return "running";
  }

  const states = input.selectedIssueStates;
  if (states.length === 0) {
    return input.currentState === "completed" ? "completed" : "created";
  }

  if (states.every((state) => isCompletedIssueState(state))) return "completed";

  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "blocked")) return "blocked";
  if (states.some((state) => state === "stale")) return "stuck";

  const hasActiveWork = states.some((state) => isActiveIssueState(state));
  if (hasActiveWork) {
    return "running";
  }

  if (states.some((state) => state === "research_only" || state === "plan_ready" || state === "queued" || state === "created")) return "queued";
  if (states.some((state) => state === "cancelled")) return "cancelled";

  return input.currentState;
}
