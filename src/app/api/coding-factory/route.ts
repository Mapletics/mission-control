import { NextResponse } from "next/server";
import { getCodingFactoryStatus, listAvailableIssues, readIntakeState, apiOk, apiError } from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, intake, availableIssues] = await Promise.all([
      getCodingFactoryStatus(),
      readIntakeState(),
      listAvailableIssues(),
    ]);

    return NextResponse.json(apiOk({
      ...status,
      intake,
      availableIssues,
    }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
