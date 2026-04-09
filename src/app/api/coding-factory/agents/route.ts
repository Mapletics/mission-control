import { NextResponse } from "next/server";
import { apiOk, apiError, readSupervisorHealth } from "@/lib/coding-factory";
import { fetchGatewaySessions, summarizeSessionsByAgent } from "@/lib/gateway-sessions";

export const dynamic = "force-dynamic";

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

export async function GET() {
  try {
    const [sessions, supervisor] = await Promise.all([
      fetchGatewaySessions().catch(() => []),
      readSupervisorHealth(),
    ]);

    const agentSummaries = summarizeSessionsByAgent(sessions);
    const now = Date.now();

    const agents = Array.from(agentSummaries.entries()).map(([agentId, summary]) => {
      const agentSessions = sessions.filter((s) => s.agentId === agentId);
      const latest = agentSessions[0];
      const isActive = summary.lastActive > 0 && now - summary.lastActive < ACTIVE_WINDOW_MS;

      return {
        agentId,
        status: isActive ? "active" as const : "idle" as const,
        sessionCount: summary.sessionCount,
        totalTokens: summary.totalTokens,
        lastActive: summary.lastActive,
        model: latest?.fullModel || null,
        thinkingLevel: latest?.thinkingLevel || null,
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
        logPath: supervisor.logPath,
        startedAt: supervisor.startedAt,
        updatedAt: supervisor.updatedAt,
      },
    }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
