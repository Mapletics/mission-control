import {
  CODING_FACTORY_PHASES,
  type CodingFactoryPhase,
  type CodingFactoryPhaseRegistryEntry,
} from "@/lib/coding-factory/types";

const PHASE_REGISTRY: Record<CodingFactoryPhase, CodingFactoryPhaseRegistryEntry> = {
  research: {
    phase: "research",
    title: "Research",
    order: 1,
    requiredArtifacts: ["research.md"],
    defaultBackend: "subagent",
    defaultAgentId: "barney",
    successPhase: "plan",
    failurePhase: null,
  },
  plan: {
    phase: "plan",
    title: "Plan",
    order: 2,
    requiredArtifacts: ["plan.md"],
    defaultBackend: "subagent",
    defaultAgentId: "claudia",
    successPhase: "implement",
    failurePhase: null,
  },
  implement: {
    phase: "implement",
    title: "Implement",
    order: 3,
    requiredArtifacts: ["implementation-summary.md"],
    defaultBackend: "subagent",
    defaultAgentId: "manfred",
    successPhase: "review",
    failurePhase: null,
  },
  review: {
    phase: "review",
    title: "Review",
    order: 4,
    requiredArtifacts: ["review.md"],
    defaultBackend: "subagent",
    defaultAgentId: "barney",
    successPhase: "pr",
    failurePhase: null,
  },
  fixAnalyze: {
    phase: "fixAnalyze",
    title: "Fix Analyze",
    order: 5,
    requiredArtifacts: ["fix-analyze.md"],
    defaultBackend: "codex",
    successPhase: "fixTests",
    failurePhase: null,
  },
  fixTests: {
    phase: "fixTests",
    title: "Fix Tests",
    order: 6,
    requiredArtifacts: ["fix-tests.md"],
    defaultBackend: "codex",
    successPhase: "review",
    failurePhase: null,
  },
  pr: {
    phase: "pr",
    title: "PR",
    order: 7,
    requiredArtifacts: ["pr.md"],
    defaultBackend: "claude-cli",
    successPhase: null,
    failurePhase: null,
  },
};

export function listCodingFactoryPhases(): CodingFactoryPhase[] {
  return [...CODING_FACTORY_PHASES];
}

export function getPhaseRegistryEntry(phase: CodingFactoryPhase): CodingFactoryPhaseRegistryEntry {
  return PHASE_REGISTRY[phase];
}

export function getNextPhase(phase: CodingFactoryPhase): CodingFactoryPhase | null {
  return PHASE_REGISTRY[phase].successPhase ?? null;
}

export function getFailurePhase(phase: CodingFactoryPhase): CodingFactoryPhase | null {
  return PHASE_REGISTRY[phase].failurePhase ?? null;
}

export function getCanonicalPhaseSequence(): CodingFactoryPhase[] {
  return listCodingFactoryPhases().sort((left, right) => PHASE_REGISTRY[left].order - PHASE_REGISTRY[right].order);
}
