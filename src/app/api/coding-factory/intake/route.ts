import { NextRequest, NextResponse } from "next/server";
import { readIntakeState, saveIntakeState, apiOk, apiError } from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const intake = await readIntakeState();
    return NextResponse.json(apiOk(intake));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const intake = await saveIntakeState(body);
    return NextResponse.json(apiOk(intake));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
