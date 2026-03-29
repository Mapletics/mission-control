import { NextRequest, NextResponse } from "next/server";
import { readIntakeState, saveIntakeState } from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const intake = await readIntakeState();
    return NextResponse.json(intake);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const intake = await saveIntakeState(body);
    return NextResponse.json(intake);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
