import { execFile } from "child_process";
import { promisify } from "util";
import type { PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";
import {
  classifyRunnerError,
  createPhaseResult,
  extractRunnerErrorDetails,
  writeRunnerLog,
  type CodingFactoryRunner,
} from "@/lib/coding-factory/runners/base";

const execFileAsync = promisify(execFile);

export class CodexRunner implements CodingFactoryRunner {
  readonly backend = "codex" as const;

  async run(request: PhaseRunRequest): Promise<PhaseRunResult> {
    const startedAt = new Date().toISOString();
    const command = [
      "codex",
      "exec",
      "--full-auto",
      request.prompt,
    ];

    if (request.model?.trim()) {
      command.splice(2, 0, "--model", request.model.trim());
    }

    try {
      const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
        cwd: request.worktreePath || request.repoPath,
        timeout: (request.timeoutMinutes || 15) * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      await writeRunnerLog(request.logPath, [
        ["COMMAND", command.join(" ")],
        ["STDOUT", stdout],
        ["STDERR", stderr],
      ]);

      return createPhaseResult(request, {
        outcome: "success",
        startedAt,
        summary: stdout.trim() || `Phase ${request.phase} completed with Codex.`,
        command,
      });
    } catch (error) {
      const { message, stdout, stderr } = extractRunnerErrorDetails(error);
      const outcome = classifyRunnerError(error);
      await writeRunnerLog(request.logPath, [
        ["COMMAND", command.join(" ")],
        ["STDOUT", stdout],
        ["STDERR", stderr],
        ["ERROR", message],
      ]);
      return createPhaseResult(request, {
        outcome,
        startedAt,
        error: message,
        blockReason: outcome === "blocked" ? message : undefined,
        retryHint: outcome === "retryable_error" ? "Retry the phase or use the configured fallback chain." : undefined,
        command,
      });
    }
  }
}
