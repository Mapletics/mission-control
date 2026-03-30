import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/coding-factory";
import { validateAndResume, type ResumeRequest } from "@/lib/coding-factory-launcher";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<ResumeRequest>;

    if (!body.runId || !body.targetRepo || !body.baseBranch || !body.selectedIssues?.length) {
      return NextResponse.json(
        apiError("Missing required fields: runId, targetRepo, baseBranch, selectedIssues"),
        { status: 400 },
      );
    }

    const result = await validateAndResume({
      runId: body.runId,
      targetRepo: body.targetRepo,
      baseBranch: body.baseBranch,
      selectedIssues: body.selectedIssues,
    });

    if (!result.ok) {
      const status =
        result.code === "ALREADY_RUNNING" || result.code === "CONFLICTING_RUN" ? 409
          : result.code === "RUN_NOT_FOUND" ? 404
            : result.code === "IDENTITY_MISMATCH" || result.code === "AMBIGUOUS_RESUME" ? 409
              : 400;
      return NextResponse.json(apiError(result.error), { status });
    }

    return NextResponse.json(apiOk({ run: result.run, supervisor: result.supervisor }));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
