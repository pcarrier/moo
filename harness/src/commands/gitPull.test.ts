import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const chats = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");

describe("git pull branches command", () => {
  it("pulls and integrates remote changes instead of only fetching them", () => {
    const start = chats.indexOf("export async function fsGitPullBranchesCommand");
    const end = chats.indexOf("\nexport ", start + 1);
    const command = chats.slice(start, end < 0 ? undefined : end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(command).toContain('["git", "pull", "--all", "--prune"]');
    expect(command).not.toContain('["git", "fetch"');
    expect(command).toContain('"git pull failed"');
    expect(command).toContain('"Pulled remote branches"');
  });
});
