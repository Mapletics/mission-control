import { NextResponse } from "next/server";
import { getCodingFactoryStatus, apiOk, apiError } from "@/lib/coding-factory";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getCodingFactoryStatus();
    return NextResponse.json(apiOk(status));
  } catch (err) {
    return NextResponse.json(apiError(String(err)), { status: 500 });
  }
}
