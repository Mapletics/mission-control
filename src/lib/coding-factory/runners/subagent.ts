import { randomUUID } from "crypto";
import { gatewayCall } from "@/lib/openclaw";
import type { PhaseRunRequest, PhaseRunResult } from "@/lib/coding-factory/types";
import {
  classifyRunnerError,
  createPhaseResult,
  writeRunnerLog,
  type CodingFactoryRunner,
} from "@/lib/coding-factory/runners/base";

type GatewayMessage = {
  role?: string;
  toolName?: string;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  timestamp?: number;
};

type AgentAccepted = {
  runId?: string;
  status?: string;
  acceptedAt?: number;
};

type ChatHistoryResult = {
  sessionKey?: string;
  messages?: GatewayMessage[];
};

function extractText(message: GatewayMessage): string {
  const chunks = Array.isArray(message.content) ? message.content : [];
  return chunks
    .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
    .map((chunk) => String(chunk.text))
    .join("\n")
    .trim();
}

function buildSessionKey(request: PhaseRunRequest, agentId: string): string {
  const scope = (request.runId || request.issueKey || `${request.repoSlug}#${request.issueNumber}`)
    .replace(/[^A-Za-z0-9_.#:-]+/g, "-");
  return `agent:${agentId}:coding-factory:${scope}:${request.phase}:${randomUUID()}`;
}

function buildSubagentMessage(request: PhaseRunRequest, agentId: string): string {
  const workspacePath = request.worktreePath || request.repoPath;
  const requiredOutputs = [...new Set([
    request.artifactContract?.primaryOutput?.path,
    ...(request.artifactRefs || []).filter((ref) => ref.required !== false).map((ref) => ref.path),
    ...(request.outputFiles || []),
  ].filter(Boolean))];

  const requiredInputs = (request.artifactContract?.required || []).map((ref) => ref.path);

  return [
    `You are the Coding Factory ${request.phase} phase runner for ${request.issueKey || `${request.repoSlug}#${request.issueNumber}`}.`,
    `Assigned agent: ${agentId}.`,
    `Work only in: ${workspacePath}`,
    `Base branch: ${request.baseBranch}`,
    "Success requires writing the required output artifact(s) to disk. Do not stop at a chat-only summary.",
    requiredInputs.length > 0 ? `Required input artifacts:\n- ${requiredInputs.join("\n- ")}` : "Required input artifacts: none.",
    requiredOutputs.length > 0 ? `Required output artifacts:\n- ${requiredOutputs.join("\n- ")}` : "Required output artifacts: none declared.",
    "If you perform app work, keep the base branch anchored to the requested base branch.",
    "After the artifact(s) exist, reply with a short status summary.",
    "",
    "PHASE INSTRUCTIONS",
    request.prompt,
  ].join("\n");
}

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

    const sessionKey = buildSessionKey(request, agentId);
    const runTimeoutMs = Math.max(10, request.timeoutMinutes || 20) * 60_000;
    const message = buildSubagentMessage(request, agentId);

    try {
      const accepted = await gatewayCall<AgentAccepted>(
        "agent",
        {
          agentId,
          message,
          sessionKey,
          timeout: Math.max(10, request.timeoutMinutes || 20) * 60,
          idempotencyKey: randomUUID(),
          label: "coding-factory-phase-runner",
          inputProvenance: {
            kind: "external_user",
            sourceChannel: "mission-control",
            sourceTool: "coding-factory",
          },
        },
        runTimeoutMs + 10_000,
      );

      const runId = String(accepted?.runId || "").trim();
      const wait = await gatewayCall<Record<string, unknown>>(
        "agent.wait",
        { runId: runId || undefined, timeoutMs: runTimeoutMs },
        runTimeoutMs + 10_000,
      );

      const history = await gatewayCall<ChatHistoryResult>(
        "chat.history",
        { sessionKey, limit: 60 },
        20_000,
      );

      const messages = Array.isArray(history.messages) ? history.messages : [];
      const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant" && extractText(entry));
      const assistantText = lastAssistant ? extractText(lastAssistant) : "";
      const toolResults = messages
        .filter((entry) => entry.role === "toolResult")
        .map((entry) => ({ toolName: entry.toolName || null, text: extractText(entry) }));

      await writeRunnerLog(request.logPath, [
        ["AGENT", agentId],
        ["SESSION_KEY", sessionKey],
        ["RUN_ID", runId || undefined],
        ["MESSAGE", message],
        ["WAIT_RESULT", JSON.stringify(wait, null, 2)],
        ["ASSISTANT", assistantText || undefined],
        ["TOOL_RESULTS", toolResults.length > 0 ? JSON.stringify(toolResults, null, 2) : undefined],
      ]);

      return createPhaseResult(request, {
        outcome: "success",
        startedAt,
        summary: assistantText || `Phase ${request.phase} completed with subagent ${agentId}.`,
        metadata: {
          sessionKey,
          runId: runId || null,
          wait,
          toolResults,
        },
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const outcome = classifyRunnerError(error);

      await writeRunnerLog(request.logPath, [
        ["AGENT", agentId],
        ["SESSION_KEY", sessionKey],
        ["MESSAGE", message],
        ["ERROR", messageText],
      ]);

      return createPhaseResult(request, {
        outcome,
        startedAt,
        error: messageText,
        blockReason: outcome === "blocked" ? messageText : undefined,
        retryHint: outcome === "retryable_error"
          ? "Retry the same phase after the gateway/subagent issue is resolved."
          : undefined,
        metadata: {
          sessionKey,
        },
      });
    }
  }
}
