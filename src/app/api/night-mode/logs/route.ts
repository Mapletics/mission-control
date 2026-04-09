import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { buildIssueLogCandidates } from "@/lib/coding-factory/artifacts";

export const dynamic = "force-dynamic";

const MAX_LINES = 200;

function parseIssueNumber(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);

  const match = value.match(/#(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const issueParam = searchParams.get("issue");
  const issueKey = searchParams.get("issueKey")?.trim() || "";
  const issueNumber = parseIssueNumber(issueParam) ?? parseIssueNumber(issueKey);

  if (!issueNumber) {
    return NextResponse.json({ error: "issue or issueKey parameter required" }, { status: 400 });
  }

  const candidates = buildIssueLogCandidates(issueNumber, issueKey || undefined);

  let logPath: string | null = null;
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      logPath = candidate;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!logPath) {
    return NextResponse.json({ issue: issueNumber, issueKey: issueKey || null, lines: [], exists: false, candidates });
  }

  try {
    const content = await readFile(logPath, "utf-8");
    const allLines = content.split("\n");
    const lines = allLines.slice(-MAX_LINES);
    return NextResponse.json({ issue: issueNumber, issueKey: issueKey || null, logPath, lines, exists: true, candidates });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
