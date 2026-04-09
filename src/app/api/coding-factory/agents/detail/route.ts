import { NextResponse } from "next/server";
import { apiOk, apiError, readSupervisorHealth } from "@/lib/coding-factory";
import { fetchGatewaySessions, type NormalizedGatewaySession } from "@/lib/gateway-sessions";

export const dynamic = "force-dynamic";

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

type AgentDetail = {
  agentId: string;
  status: "active" | "idle";
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastActive: number;
  model: string | null;
  thinkingLevel: string | null;
  sessions: SessionInfo[];
};

type SessionInfo = {
  key: string;
  sessionId: string;
  kind: string;
  model: string;
  fullModel: string;
  thinkingLevel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens: number;
  updatedAt: number;
  ageMs: number;
  originLabel: string | null;
  abortedLastRun: boolean;
  systemSent: boolean;
};

function toSessionInfo(s: NormalizedGatewaySession): SessionInfo {
  return {
    key: s.key,
    sessionId: s.sessionId,
    kind: s.kind,
    model: s.model,
    fullModel: s.fullModel,
    thinkingLevel: s.thinkingLevel ?? null,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    totalTokens: s.totalTokens,
    contextTokens: s.contextTokens,
    updatedAt: s.updatedAt,
    ageMs: s.ageMs,
    originLabel: s.originLabel ?? null,
    abortedLastRun: s.abortedLastRun,
    systemSent: s.systemSent,
  };
}

export async function GET() {
  try {
    const [sessions, supervisor] = await Promise.all([
      fetchGatewaySessions().catch(() => []),
      readSupervisorHealth(),
    ]);

    const now = Date.now();
    const byAgent = new Map<string, NormalizedGatewaySession[]>();

    for (const s of sessions) {
      const id = s.agentId ?? "_unassigned";
      const arr = byAgent.get(id) ?? [];
      arr.push(s);
      byAgent.set(id, arr);
    }

    const agents: AgentDetail[] = Array.from(byAgent.entries()).map(([agentId, agentSessions]) => {
      const sorted = agentSessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const latest = sorted[0];
      const lastActive = sorted.reduce((max, s) => Math.max(max, s.updatedAt), 0);
      const isActive = lastActive > 0 && now - lastActive < ACTIVE_WINDOW_MS;

      return {
        agentId,
        status: isActive ? "active" as const : "idle" as const,
        totalTokens: sorted.reduce((sum, s) => sum + s.totalTokens, 0),
        inputTokens: sorted.reduce((sum, s) => sum + s.inputTokens, 0),
        outputTokens: sorted.reduce((sum, s) => sum + s.outputTokens, 0),
        cacheReadTokens: sorted.reduce((sum, s) => sum + s.cacheReadTokens, 0),
        cacheWriteTokens: sorted.reduce((sum, s) => sum + s.cacheWriteTokens, 0),
        lastActive,
        model: latest?.fullModel ?? null,
        thinkingLevel: latest?.thinkingLevel ?? null,
        sessions: sorted.map(toSessionInfo),
      };
    });

    agents.sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      return b.lastActive - a.lastActive;
    });

    return NextResponse.json(apiOk({
      agents,
      supervisor: {
        status: supervisor.status,
        isHealthy: supervisor.isHealthy,
        pid: supervisor.pid,
        pidAlive: supervisor.pidAlive,
        runId: supervisor.runId,
        issueKeys: supervisor.issueKeys,
        currentIssueKey: supervisor.currentIssueKey,
        currentPhase: supervisor.currentPhase,
      },
    }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
