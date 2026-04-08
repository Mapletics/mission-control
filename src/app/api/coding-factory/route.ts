import { NextResponse } from "next/server";
import {
  getCodingFactoryStatus,
  listAvailableIssues,
  readIntakeState,
  apiOk,
  apiError,
} from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, intake] = await Promise.all([
      getCodingFactoryStatus(),
      readIntakeState(),
    ]);

    const excludeIssueKeys = new Set([
      ...status.activeRun.selectedIssues.map((issue) => issue.issueKey),
      ...intake.selectedIssues.map((issue) => issue.issueKey),
    ]);

    const availableIssues = await listAvailableIssues({
      targetRepo: intake.targetRepo,
      excludeIssueKeys,
    });

    return NextResponse.json(apiOk({
      ...status,
      intake,
      availableIssues,
      meta: {
        stateMachineVersion: 2,
        canonicalRunState: status.state,
      },
    }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
