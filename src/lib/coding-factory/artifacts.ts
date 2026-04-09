import { access } from "fs/promises";
import { join } from "path";
import {
  CODING_FACTORY_BACKENDS,
  CODING_FACTORY_PHASES,
  type CodingFactoryArtifactRef,
  type CodingFactoryBackend,
  type CodingFactoryPhase,
  type CodingFactoryPhaseArtifactContract,
  type CodingFactoryPhaseArtifactSet,
} from "@/lib/coding-factory/types";

export const WORK_STATE_DIR = process.env.WORK_STATE_DIR || "/home/ubuntu/repos/.work-state";
const ARTIFACT_ROOT_DIR = join(WORK_STATE_DIR, "coding-factory-v2");
const ISSUE_LOG_DIR = process.env.ISSUE_LOG_DIR || "/tmp";

const CANONICAL_ARTIFACT_FILENAMES: Record<CodingFactoryPhase, string> = {
  research: "research.md",
  plan: "plan.md",
  implement: "implementation-summary.md",
  review: "review.md",
  fixAnalyze: "fix-analyze.md",
  fixTests: "fix-tests.md",
  pr: "pr.md",
};

function sanitizeIssueKey(issueKey: string): string {
  return issueKey.replace(/[^A-Za-z0-9_.#-]+/g, "-");
}

function buildArtifactRef(
  phase: CodingFactoryPhase,
  path: string,
  patch?: Partial<CodingFactoryArtifactRef>,
): CodingFactoryArtifactRef {
  return {
    key: CANONICAL_ARTIFACT_FILENAMES[phase],
    phase,
    path,
    required: true,
    canonical: true,
    kind: "markdown",
    label: CANONICAL_ARTIFACT_FILENAMES[phase],
    ...patch,
  };
}

export function getIssueArtifactSet(issueNumber: number, repoSlug = "repo"): CodingFactoryPhaseArtifactSet {
  const issueKey = sanitizeIssueKey(`${repoSlug}#${issueNumber}`);
  const rootDir = join(ARTIFACT_ROOT_DIR, issueKey);
  const logDir = join(rootDir, "logs");

  const canonical = {
    research: buildArtifactRef("research", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.research)),
    plan: buildArtifactRef("plan", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.plan)),
    implement: buildArtifactRef("implement", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.implement)),
    review: buildArtifactRef("review", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.review)),
    fixAnalyze: buildArtifactRef("fixAnalyze", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.fixAnalyze)),
    fixTests: buildArtifactRef("fixTests", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.fixTests)),
    pr: buildArtifactRef("pr", join(rootDir, CANONICAL_ARTIFACT_FILENAMES.pr)),
  } satisfies Record<CodingFactoryPhase, CodingFactoryArtifactRef>;

  const legacyCompat = {
    researchFile: join(WORK_STATE_DIR, `research-${issueNumber}.md`),
    contractFile: join(WORK_STATE_DIR, `contract-${issueNumber}.md`),
    logFile: join(ISSUE_LOG_DIR, `claude-issue-${issueNumber}.log`),
  };

  return {
    rootDir,
    issueKey,
    canonical,
    required: CODING_FACTORY_PHASES.map((phase) => canonical[phase]),
    legacyCompat,
    researchFile: canonical.research.path,
    planFile: canonical.plan.path,
    implementationSummaryFile: canonical.implement.path,
    reviewFile: canonical.review.path,
    fixAnalyzeFile: canonical.fixAnalyze.path,
    fixTestsFile: canonical.fixTests.path,
    prFile: canonical.pr.path,
    logDir,
    logFile: legacyCompat.logFile,
  };
}

const REQUIRED_INPUTS_BY_PHASE: Record<CodingFactoryPhase, CodingFactoryPhase[]> = {
  research: [],
  plan: ["research"],
  implement: ["research", "plan"],
  review: ["research", "plan", "implement"],
  fixAnalyze: ["research", "plan", "implement", "review"],
  fixTests: ["research", "plan", "implement", "review", "fixAnalyze"],
  pr: ["research", "plan", "implement", "review"],
};

export function getPhaseArtifactContract(issueNumber: number, repoSlug: string, phase: CodingFactoryPhase): CodingFactoryPhaseArtifactContract {
  const artifacts = getIssueArtifactSet(issueNumber, repoSlug);
  return {
    required: REQUIRED_INPUTS_BY_PHASE[phase].map((item) => artifacts.canonical[item]),
    optional: CODING_FACTORY_PHASES
      .filter((item) => !REQUIRED_INPUTS_BY_PHASE[phase].includes(item) && item !== phase)
      .map((item) => artifacts.canonical[item]),
    primaryOutput: artifacts.canonical[phase],
  };
}

export async function validateArtifactRef(ref: CodingFactoryArtifactRef): Promise<boolean> {
  try {
    await access(ref.path);
    return true;
  } catch {
    if (ref.aliases?.length) {
      for (const alias of ref.aliases) {
        try {
          await access(alias);
          return true;
        } catch {
          // continue
        }
      }
    }
    return false;
  }
}

export async function validateArtifactContract(contract?: CodingFactoryPhaseArtifactContract | null): Promise<{ ok: boolean; missing: CodingFactoryArtifactRef[] }> {
  if (!contract) return { ok: true, missing: [] };

  const missing: CodingFactoryArtifactRef[] = [];
  for (const ref of contract.required) {
    if (!await validateArtifactRef(ref)) {
      missing.push(ref);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

export function buildPhaseLogPath(issueNumber: number, repoSlug: string, phase: CodingFactoryPhase, backend: CodingFactoryBackend): string {
  const issueKey = sanitizeIssueKey(`${repoSlug}#${issueNumber}`);
  return join(ISSUE_LOG_DIR, `coding-factory-${issueKey}-${phase}-${backend}.log`);
}

export function buildIssueLogCandidates(issueNumber: number, issueKey?: string): string[] {
  const sanitizedIssueKey = issueKey ? sanitizeIssueKey(issueKey) : null;
  const candidates = new Set<string>([
    join(ISSUE_LOG_DIR, `claude-issue-${issueNumber}.log`),
  ]);

  if (sanitizedIssueKey) {
    candidates.add(join(ISSUE_LOG_DIR, `claude-${sanitizedIssueKey}.log`));
  }

  for (const phase of CODING_FACTORY_PHASES) {
    for (const backend of CODING_FACTORY_BACKENDS) {
      candidates.add(join(ISSUE_LOG_DIR, `coding-factory-${sanitizedIssueKey ?? issueNumber}-${phase}-${backend}.log`));
      candidates.add(join(ISSUE_LOG_DIR, `coding-factory-${issueNumber}-${phase}-${backend}.log`));
    }
  }

  return [...candidates];
}
