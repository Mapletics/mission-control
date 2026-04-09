import { execFile } from "child_process";
import { promisify } from "util";
import type { PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";
import { classifyRunnerError, createPhaseResult, type CodingFactoryRunner } from "@/lib/coding-factory/runners/base";

const execFileAsync = promisify(execFile);

export class ClaudeCliRunner implements CodingFactoryRunner {
  readonly backend = "claude-cli" as const;

  async run(request: PhaseRunRequest): Promise<PhaseRunResult> {
    const startedAt = new Date().toISOString();
    const command = [
      "claude",
      "--permission-mode",
      "bypassPermissions",
      "--print",
      request.prompt,
    ];

    try {
      const { stdout } = await execFileAsync(command[0], command.slice(1), {
        cwd: request.worktreePath || request.repoPath,
        timeout: (request.timeoutMinutes || 15) * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      return createPhaseResult(request, {
        outcome: "success",
        startedAt,
        summary: stdout.trim() || `Phase ${request.phase} completed with Claude CLI.`,
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
        retryHint: outcome === "retryable_error" ? "Retry the same phase or fallback to the next configured runner." : undefined,
        command,
      });
    }
  }
}
