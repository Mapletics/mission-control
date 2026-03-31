import { NextRequest, NextResponse } from "next/server";
import { apiError, apiOk } from "@/lib/coding-factory";
import { buildResumeLaunchInput, launchCodingFactoryRun } from "@/lib/coding-factory-launcher";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const runId = typeof body?.runId === "string" ? body.runId : "";
    const input = await buildResumeLaunchInput(runId);
    const result = await launchCodingFactoryRun(input);
    return NextResponse.json(apiOk(result), { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /already active/i.test(message) ? 409 : 400;
    return NextResponse.json(apiError(message), { status });
  }
}
