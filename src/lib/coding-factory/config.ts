import { codingFactoryPipelineConfig } from "@/lib/coding-factory/pipeline.config";
import type {
  CodingFactoryPhase,
  CodingFactoryPhaseConfig,
  CodingFactoryPipelineConfig,
} from "@/lib/coding-factory/types";

export function getCodingFactoryPipelineConfig(): CodingFactoryPipelineConfig {
  return codingFactoryPipelineConfig;
}

export function resolvePhaseConfig(targetRepo: string, phase: CodingFactoryPhase): CodingFactoryPhaseConfig {
  const config = getCodingFactoryPipelineConfig();
  const baseConfig = config.phases[phase];
  const override = config.repoOverrides?.[targetRepo]?.[phase];

  return {
    ...baseConfig,
    ...override,
    fallback: override?.fallback ?? baseConfig.fallback,
  };
}

export function summarizePipelineForRepo(targetRepo: string) {
  const config = getCodingFactoryPipelineConfig();
  return {
    version: config.version,
    defaults: config.defaults,
    phases: Object.fromEntries(
      Object.keys(config.phases).map((phase) => [
        phase,
        resolvePhaseConfig(targetRepo, phase as CodingFactoryPhase),
      ]),
    ),
  };
}
