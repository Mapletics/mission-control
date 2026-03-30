import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { join } from "path";

export const dynamic = "force-dynamic";

const ISSUE_LOG_DIR = process.env.ISSUE_LOG_DIR || "/tmp";
const MAX_LINES = 200;

function parseIssueNumber(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);

  const match = value.match(/#(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sanitizeIssueKey(issueKey: string): string {
  return issueKey.replace(/[^A-Za-z0-9_.#-]+/g, "-");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const issueParam = searchParams.get("issue");
  const issueKey = searchParams.get("issueKey")?.trim() || "";
  const issueNumber = parseIssueNumber(issueParam) ?? parseIssueNumber(issueKey);

  if (!issueNumber) {
    return NextResponse.json({ error: "issue or issueKey parameter required" }, { status: 400 });
  }

  const candidates = [
    issueKey ? join(ISSUE_LOG_DIR, `claude-${sanitizeIssueKey(issueKey)}.log`) : null,
    join(ISSUE_LOG_DIR, `claude-issue-${issueNumber}.log`),
  ].filter((value): value is string => !!value);

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
    return NextResponse.json({ issue: issueNumber, issueKey: issueKey || null, lines: [], exists: false });
  }

  try {
    const content = await readFile(logPath, "utf-8");
    const allLines = content.split("\n");
    const lines = allLines.slice(-MAX_LINES);
    return NextResponse.json({ issue: issueNumber, issueKey: issueKey || null, lines, exists: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
