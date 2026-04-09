import type { CodingFactoryPhaseConfig, CodingFactoryPhaseExecutionTarget } from "@/lib/coding-factory/types";

export function buildExecutionTargets(config: CodingFactoryPhaseConfig): CodingFactoryPhaseExecutionTarget[] {
  const primary: CodingFactoryPhaseExecutionTarget = {
    backend: config.backend,
    model: config.model,
    agentId: config.agentId,
    timeoutMinutes: config.timeoutMinutes,
  };

  const fallbacks = (config.fallback || []).map((fallback) => ({
    backend: fallback.backend,
    model: fallback.model,
    agentId: fallback.agentId,
    timeoutMinutes: config.timeoutMinutes,
  }));

  return [primary, ...fallbacks];
}
