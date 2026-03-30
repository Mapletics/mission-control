import { NextResponse } from "next/server";
import { getCodingFactoryStatus, listAvailableIssues, readIntakeState, apiOk, apiError } from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, intake] = await Promise.all([
      getCodingFactoryStatus(),
      readIntakeState(),
    ]);

    const items = await listAvailableIssues({
      targetRepo: intake.targetRepo,
      excludeIssueKeys: status.activeRun.selectedIssues.map((issue) => issue.issueKey),
    });

    return NextResponse.json(apiOk({ items }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
