import type { CodingFactoryPhase } from "@/lib/coding-factory/types";

export function nextPhaseAfter(phase: CodingFactoryPhase): CodingFactoryPhase | null {
  switch (phase) {
    case "research":
      return "plan";
    case "plan":
      return "implement";
    case "implement":
      return "review";
    case "review":
      return "fixAnalyze";
    case "fixAnalyze":
      return "fixTests";
    case "fixTests":
      return null;
    default:
      return null;
  }
}
