import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileRunTS } from "./runts";

const mooSource = readFileSync(new URL("./moo.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./types.ts", import.meta.url), "utf8");
const ambientSource = readFileSync(new URL("./runts_ambient.d.txt", import.meta.url), "utf8");
const driverSource = readFileSync(new URL("../../src/driver.rs", import.meta.url), "utf8");

describe("moo.agent.start", () => {
  test("is exposed to runTS with an independent-chat result", () => {
    expect(typesSource).toContain("start(spec: AgentStartSpec): Promise<AgentStartResult>");
    expect(ambientSource).toContain("start(spec: AgentStartSpec): Promise<AgentStartResult>");
    expect(compileRunTS('return await moo.agent.start({ task: "Do work", title: "Worker" });').diagnostics).toEqual([]);
  });

  test("creates and configures a normal chat before scheduling it", () => {
    expect(mooSource).toContain("async start(spec: AgentStartSpec)");
    expect(mooSource).toContain("const inherit = spec.inherit !== false;");
    expect(mooSource).toContain('`chat/${parentChatId}/path`');
    expect(mooSource).toContain("chatRefs(parentChatId).model");
    expect(mooSource).toContain("const chatId = await chat.create");
    expect(mooSource).toContain("await applyDefaultChatSettings(chatId)");
    expect(mooSource).toContain('mode: "start"');
  });

  test("documents the minimal inherited-default call", () => {
    const promptSource = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");
    expect(promptSource).toContain("moo.agent{start,run,fork,claim,complete}");
    expect(promptSource).toContain("usually call `moo.agent.start({task})`");
  });

  test("sends a pure user message instead of a bounded subagent task", () => {
    expect(mooSource).toContain("state: subagentStepState(chatId, task, false)");
    expect(mooSource).toContain("state: subagentStepState(childChatId, buildSubagentTask(spec), true)");
    expect(driverSource).toContain('"subagent request missing state"');
  });

  test("acknowledges detached starts and records a normal user input", () => {
    expect(driverSource).toContain('request.get("mode").and_then(Value::as_str) == Some("start")');
    expect(driverSource).toContain('result: Ok(json!({ "chatId": chat_id }).to_string())');
    expect(mooSource).toContain("state: subagentStepState(chatId, task, false)");
  });
});

describe("moo.agent.run", () => {
  test("hides child chats before they become visible to chat.list", () => {
    const runStart = mooSource.indexOf("async function createSubagentRunRequest");
    const hiddenWrite = mooSource.indexOf('`chat/${childChatId}/hidden`', runStart);
    const childCreate = mooSource.indexOf("await chat.create({", runStart);

    expect(hiddenWrite).toBeGreaterThan(runStart);
    expect(hiddenWrite).toBeLessThan(childCreate);
    expect(mooSource).toContain("chatId: childChatId,\n    path: parentRoot,");
  });
});
