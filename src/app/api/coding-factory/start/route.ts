import { NextRequest, NextResponse } from "next/server";
import { apiError, apiOk, readIntakeState } from "@/lib/coding-factory";
import { launchCodingFactoryRun } from "@/lib/coding-factory-launcher";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const intake = await readIntakeState();

    const result = await launchCodingFactoryRun({
      mode: body?.mode === "batch" ? "batch" : intake.mode,
      targetRepo: typeof body?.targetRepo === "string" ? body.targetRepo : intake.targetRepo,
      baseBranch: typeof body?.baseBranch === "string" ? body.baseBranch : intake.baseBranch,
      branchStrategy: body?.branchStrategy === "isolated" ? "isolated" : intake.branchStrategy,
      workingBranch: typeof body?.workingBranch === "string" && body.workingBranch.trim() ? body.workingBranch.trim() : intake.workingBranch,
      branchStartMode: body?.branchStartMode === "existing" ? "existing" : intake.branchStartMode,
      selectedIssues: intake.selectedIssues,
      source: "start",
    });

    return NextResponse.json(apiOk(result), { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /already active/i.test(message) ? 409 : 400;
    return NextResponse.json(apiError(message), { status });
  }
}
