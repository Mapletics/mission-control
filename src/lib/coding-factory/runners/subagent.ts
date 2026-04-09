import { execFile } from "child_process";
import { promisify } from "util";
import type { PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";
import { classifyRunnerError, createPhaseResult, type CodingFactoryRunner } from "@/lib/coding-factory/runners/base";

const execFileAsync = promisify(execFile);

export class SubagentRunner implements CodingFactoryRunner {
  readonly backend = "subagent" as const;

  async run(request: PhaseRunRequest): Promise<PhaseRunResult> {
    const startedAt = new Date().toISOString();
    const agentId = request.agentId?.trim();

    if (!agentId) {
      return createPhaseResult(request, {
        outcome: "blocked",
        startedAt,
        error: "subagent runner requires agentId",
        blockReason: "subagent runner requires agentId",
      });
    }

    if (process.env.CODING_FACTORY_ENABLE_SUBAGENT_RUNNER !== "1") {
      return createPhaseResult(request, {
        outcome: "blocked",
        startedAt,
        error: "subagent runner is disabled by default because repo/worktree routing is not guaranteed yet",
        blockReason: "subagent runner disabled by env guard",
      });
    }

    const command = [
      "openclaw",
      "agent",
      "--agent",
      agentId,
      "--message",
      request.prompt,
    ];

    try {
      const { stdout } = await execFileAsync(command[0], command.slice(1), {
        cwd: request.worktreePath || request.repoPath,
        timeout: (request.timeoutMinutes || 20) * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      return createPhaseResult(request, {
        outcome: "success",
        startedAt,
        summary: stdout.trim() || `Phase ${request.phase} completed with subagent ${agentId}.`,
        command,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = classifyRunnerError(error);
      return createPhaseResult(request, {
        outcome,
        startedAt,
        error: message,
        blockReason: outcome === "blocked" ? message : undefined,
        retryHint: outcome === "retryable_error" ? "Retry after ensuring routing and agent availability." : undefined,
        command,
      });
    }
  }
}
