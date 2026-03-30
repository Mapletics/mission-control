import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/coding-factory";
import { validateAndStart, type LaunchRequest } from "@/lib/coding-factory-launcher";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<LaunchRequest>;

    if (!body.targetRepo || !body.baseBranch || !body.selectedIssues?.length) {
      return NextResponse.json(
        apiError("Missing required fields: targetRepo, baseBranch, selectedIssues"),
        { status: 400 },
      );
    }

    const result = await validateAndStart({
      targetRepo: body.targetRepo,
      baseBranch: body.baseBranch,
      mode: body.mode === "batch" ? "batch" : "single",
      selectedIssues: body.selectedIssues,
    });

    if (!result.ok) {
      const status = result.code === "CONFLICTING_RUN" || result.code === "ALREADY_RUNNING" ? 409 : 400;
      return NextResponse.json(apiError(result.error), { status });
    }

    return NextResponse.json(apiOk({ run: result.run, supervisor: result.supervisor }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
