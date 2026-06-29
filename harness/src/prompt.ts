import { moo } from "./moo";
import * as host from "./host_ops";
import type { ProcResult } from "./types";
// Ultra-compact prompt: telegraphic, LLM-to-LLM. No prose padding.

export const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  "Compress chat for LLM handoff: goal, state, decisions, changes, blockers. Dense.";

export const COMPACTION_SUMMARY_REQUEST_PROMPT =
  "Summarize. End: `Next action:` + exact immediate action; no waiting.";

export const COMPACTION_CONTINUATION_INSTRUCTION =
  "Resume after compaction. Summary = prior state. First reply: act. Execute `Next action:` or infer next concrete step. Do not wait, acknowledge, or say ready. If done, report result. Do not mention compaction unless asked.";

export const COMPACTION_CONTINUATION_USER_PROMPT =
  "Act on the `Next action:` from the summary now. Use tools if useful. If all work is already complete, report the result. Do not acknowledge or wait.";

export function compactionContinuationSystemMessage(
  summary: string,
  currentTasks?: string | null,
): string {
  const parts = [
    COMPACTION_CONTINUATION_INSTRUCTION,
    "",
    "Summary of earlier conversation:",
    "<conversation_summary>",
    summary,
    "</conversation_summary>",
  ];
  const tasks = String(currentTasks ?? "").trim();
  if (tasks) {
    parts.push("", "Current task reminders:", "<current_tasks>", tasks, "</current_tasks>");
  }
  return parts.join("\n");
}

export function buildCompactionSummaryPromptMessages(messages: any[]): any[] {
  const rest = Array.isArray(messages) ? messages.slice(1) : [];
  return [
    { role: "system", content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
    ...rest,
    { role: "user", content: COMPACTION_SUMMARY_REQUEST_PROMPT },
  ];
}

async function mcpNamesLine(): Promise<string> {
  try {
    const ids = (await moo.mcp.list())
      .filter((s) => s.enabled !== false)
      .map((s) => s.id)
      .filter(Boolean)
      .sort();
    return ids.length
      ? `moo.mcp servers: ${ids.join(", ")}`
      : "moo.mcp servers: none enabled";
  } catch {
    return "moo.mcp servers: unavailable";
  }
}

function compactSkillFrontmatter(frontmatter: Record<string, unknown>): string {
  const entries = Object.entries(frontmatter || {}).filter(
    ([key]) => key !== "name" && key !== "title",
  );
  if (!entries.length) return "{}";
  const obj = Object.fromEntries(entries.slice(0, 10));
  const json = JSON.stringify(obj);
  return json.length <= 320 ? json : json.slice(0, 317) + "…";
}

async function skillLines(root?: string | null): Promise<string[]> {
  try {
    const skills = await moo.skills.list({ enabled: true, root });
    if (!skills.length) return ["skills: none enabled"];
    const lines = [
      "moo.skills enabled metadata only; call `moo.skills.load(idOrName)` for full content when relevant.",
    ];
    for (const skill of skills.slice(0, 24)) {
      lines.push(
        `  - ${skill.name} (${skill.id}) frontmatter=${compactSkillFrontmatter(skill.frontmatter)}`,
      );
    }
    if (skills.length > 24)
      lines.push(`  - … ${skills.length - 24} more enabled skills`);
    return lines;
  } catch {
    return ["skills: unavailable"];
  }
}

async function agentsMdLines(scratch: string): Promise<string[]> {
  try {
    const path = `${scratch}/AGENTS.md`;
    const stat = await moo.fs.stat({ path: path });
    if (!stat || stat.kind !== "file") return [];
    const content = (await moo.fs.read({ path: path })).trim();
    if (!content) return [];
    return ["", "User/project steering (AGENTS.md):", content];
  } catch {
    return [];
  }
}

const cliTools = [
  "git",
  "jj",
  "gh",
  "nix",
  "bun",
  "deno",
  "node",
  "python3",
  "ruby",
  "awk",
  "grep",
  "jq",
  "sed",
  "curl",
  "fd",
  "find",
  "rg",
  "sqlite3",
];
const unavailableProcResult: ProcResult = {
  code: 127,
  stdout: "",
  stderr: "",
  durationNs: 0,
  timedOut: false,
};
let cliToolsCache: Promise<Set<string>> | null = null;

function availableCliTools(): Promise<Set<string>> {
  cliToolsCache ??= (async () => {
    const script = cliTools
      .map(
        (tool) => `command -v ${tool} >/dev/null 2>&1 && printf '%s\n' ${tool}`,
      )
      .join(";");
    const result = await moo.proc.run({
      cmd: ["sh", "-lc", script],
      timeoutMs: 2_000,
      maxOutputBytes: 200,
    });
    return new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((tool) => cliTools.includes(tool)),
    );
  })();
  // A transient failure should not permanently break CLI tool detection.
  cliToolsCache.catch(() => {
    cliToolsCache = null;
  });
  return cliToolsCache;
}

function formatCliToolsLine(availableSet: Set<string>): string {
  const available = cliTools.filter((tool) => availableSet.has(tool));
  const unavailable = cliTools.filter((tool) => !availableSet.has(tool));
  const status = [
    `git=${availableSet.has("git") ? "available" : "unavailable"}`,
  ];
  const availableLine = available.length
    ? `available: ${available.join(", ")}`
    : "available: none";
  const unavailableLine = unavailable.length
    ? `unavailable: ${unavailable.join(", ")}`
    : "unavailable: none";
  return `CLI tools — ${status.join("; ")}; ${availableLine}; ${unavailableLine}`;
}

async function cliToolsLine(): Promise<string> {
  try {
    return formatCliToolsLine(await availableCliTools());
  } catch {
    return `CLI tools: availability check failed for ${cliTools.join(", ")}`;
  }
}

async function repoInfoLine(scratch: string): Promise<string> {
  try {
    const [jjTool, gitTool] = await Promise.all([
      moo.proc.run({
        cmd: ["sh", "-lc", "command -v jj >/dev/null 2>&1"],
        timeoutMs: 2_000,
      }),
      moo.proc.run({
        cmd: ["sh", "-lc", "command -v git >/dev/null 2>&1"],
        timeoutMs: 2_000,
      }),
    ]);
    const jjAvailable = jjTool.code === 0;
    const gitAvailable = gitTool.code === 0;
    const [jj, git] = await Promise.all([
      jjAvailable
        ? moo.proc.run({
            cmd: ["jj", "root"],
            cwd: scratch,
            timeoutMs: 2_000,
            maxOutputBytes: 2_000,
          })
        : Promise.resolve(unavailableProcResult),
      gitAvailable
        ? moo.proc.run({
            cmd: ["git", "rev-parse", "--show-toplevel"],
            cwd: scratch,
            timeoutMs: 2_000,
            maxOutputBytes: 2_000,
          })
        : Promise.resolve(unavailableProcResult),
    ]);
    const jjRoot = jj.code === 0 ? jj.stdout.trim() : "";
    const gitRoot = git.code === 0 ? git.stdout.trim() : "";
    const gitToolStatus = `git=${gitAvailable ? "available" : "unavailable"}`;
    const jjToolStatus = `jj=${jjAvailable ? "available" : "unavailable"}`;
    const toolSuffix = `; tools: ${gitToolStatus}, ${jjToolStatus}`;
    if (jjRoot)
      return `repo type: jj; root=${JSON.stringify(jjRoot)}${gitRoot ? `; git backing root=${JSON.stringify(gitRoot)}` : ""}${toolSuffix}`;
    if (gitRoot)
      return `repo type: git; root=${JSON.stringify(gitRoot)}; tools: ${gitToolStatus}`;
    return `repo type: none${toolSuffix}`;
  } catch {
    return "repo type: unknown";
  }
}

export async function buildSystemPrompt(chatId: string): Promise<string> {
  const scratch = await moo.chat.scratch({ chatId: chatId });
  const repo = await moo.pointers.get({ name: `chat/${chatId}/path` });
  const mcpNames = await mcpNamesLine();
  const skillsLines = await skillLines(scratch);
  const repoLines = repo ? repoWorktreeLines : repoLessWorktreeLines;
  const agentsLines = await agentsMdLines(scratch);
  const repoInfo = await repoInfoLine(scratch);
  const cliLine = await cliToolsLine();
  const traceLines = host.tracingEnabled()
    ? [
        "moo.traces{current,get,events,tree,recent,search,failed,summary,diagnose,errorOf,errors,mark,span}: every runTS has a durable SQLite trace; current({})→Promise<{traceId?,id,rootId?,stepId?,parentId}|null>; get/events/tree accept {traceId?,stepId?,limit?}; recent/search/failed accept {limit?,includeChat?,chatId?,status?,kind?,name?,text?,hasError?,includeEvents?}; summary({traceId?,stepId?,includeEvents?})→Promise<TraceSummary|null>; diagnose({limit?,chatId?,includeEvents?,examplesPerGroup?})→Promise<TraceDiagnosis>; errorOf({row})→string|null; errors({traceId?,stepId?,limit?})→Promise<TraceErrorInfo[]>; mark({message,data?})→Promise<string|null>; span({name,data?,fn}) nests work. For failure review use moo.traces.failed/summary; don't JSON-keyword scan for error text. Omitted ids mean current trace inside runTS.",
      ]
    : [];
  const subagentSpecHash = await moo.pointers.get({
    name: `chat/${chatId}/subagent-spec`,
  });
  const subagentSpec = subagentSpecHash
    ? (await moo.objects.getJSON<any>({ hash: subagentSpecHash }))?.value
    : null;
  const subagentLines = subagentSpec
    ? [
        "",
        "SUBAGENT MODE: bounded child agent delegated by a parent.",
        "Complete only the assigned task; don't ask the user; return concise final report with evidence/links and uncertainty.",
        "Don't call moo.agent.run unless explicitly enabled; default depth limit 1.",
      ]
    : [];
  return [
    "agent=moo. tool=runTS({label,description,code,args?}) → TypeScript 6 + ES2025 async body; `moo`, `chatId`, `repo`, `scratch` & optional `args` in scope.",
    "label+description: Markdown for the tool-call row. label ≤6 words, imperative, sentence case. description: one concrete sentence (paths/predicates/why); use links/code when useful.",
    "code: TypeScript body compiled with bundled Moo type definitions; await freely; `return` value for visible output; `args` is JSON supplied via `args?`.",
    "args: pass complex strings/data (patches, scripts, JSON blobs) via `args` instead of embedding/escaping them in `code`.",
    "runtime: harness V8 ES2025 only; TypeScript 6 type-checks against bundled ES2025 + Moo definitions; no Node APIs (no fs/path/process/require/import); no ICU/Intl (avoid localeCompare/Intl.Collator).",
    "runTS: put large code/patches/templates in `args`; avoid embedding backticks, `${...}`, or raw patches inside TypeScript strings. Backgrounded runTS returns an id; cancel with `await moo.tools.cancel({id})`",
    "out=Markdown. dense and concise. no restating. memory is silent context; don't dump it.",
    "When asked to tweak/fix/update code or a named file/path, edit the code; do not merely remember the request or acknowledge a preference.",
    "moo.tasks: optional; use `moo.tasks` only for substantial multi-step work where tracking helps. When given an explicit goal/task, create/update tasks promptly. Cut big problems into small orthogonal pieces and delegate them to subagents with tasks. Tasks can include `validation` (function source or `() => boolean|Promise<boolean>`); if validation is bad or stale, update it with `moo.tasks.setValidation` before marking done. Keep items terse; don't update guessed/stale IDs. Method signatures are in the moo.tasks API line below.",
    "searches: run silently; don't expose chat-history/background-search progress text unless asking for input or reporting results.",
    "Markdown: specify info-string languages on fenced code blocks (e.g. ```ts, ```json, ```sh) so renderers can highlight them.",
    "Mermaid: for diagrams/flows/sequences, prefer native ```mermaid fences over ASCII art; keep diagrams small and label edges/nodes clearly.",
    "ambiguity: don't assume it away; ask targeted Qs with concise choices/tradeoffs when decisions matter.",
    "questions: use moo.ui.ask/choose forms, not prose questions, whenever soliciting user input; group related fields in one form.",
    "repo/file refs: use markdown links, e.g. [path](relative/path.ts); relative links open in sidebar.",
    ...(cliLine ? [cliLine] : []),
    "",
    `context: chatId=${chatId}; repo=${JSON.stringify(repo)}; scratch=${JSON.stringify(scratch)}; ${repoInfo}.`,
    ...agentsLines,
    "API types: ObjectInput=string|number|boolean|Term; Term=canonical Turtle wrapper; Quad=[graph,subject,predicate,object]; Bindings=Record<string,string>; TermBindings=Record<string,BindingTerm>; FactMutationReceipt={store:string,added:number,removed:number}; PatchResult={status:string,output?:string|null}.",
    "moo.try({fn})→Promise<Result<Awaited<T>>>.",
    "moo.time{nowMs,nowISO,datetime,nowPlus}: nowMs({})→Promise<number>; nowISO({})→Promise<string>; datetime({d?:Date|string|number})→Promise<Term>; nowPlus({ms:number})→Promise<number>.",
    "moo.validate{pointerName,factStoreName,graphName,uiAppId,hash,relativePath}: pointerName({name})/factStoreName({name})/graphName({graph})/uiAppId({id})/hash({hash})/relativePath({path})→boolean.",
    "moo.id{new}: new({prefix?})→Promise<string>; moo.log({args:unknown[]})→void (diagnosis only).",
    "moo.objects{putText,putJSON,getText,getJSON}: putText({kind,text})/putJSON({kind,value})→Promise<string>; getText({hash})→Promise<{kind,text}|null>; getJSON<V>({hash})→Promise<{kind,value:V}|null>.",
    "moo.tasks{list,add,update,done,drop,setValidation,validate,patch,clear}: list()→Promise<{items:AgentTask[]}>; add({text,status?,note?,validation?})/update({id,text?,status?,note?,validation?})/done({id,note?})/drop({id,note?})/setValidation({id,validation?})→Promise<AgentTask>; validate({id})→Promise<{ok,error?}>; patch({items?,add?,update?,clearDone?,clearStatuses?})/clear({statuses?})→Promise<{items:AgentTask[]}>. Statuses todo|doing|done|blocked|dropped; AgentTaskPatch without id adds, with id updates; done fails if validation returns false/throws/does not compile.",
    "moo.skills{list,get,load,content,save,upsert,delete,remove,refresh,parseMarkdown}: list({enabled?,root?})→Promise<SkillSummary[]>; get/load/content(idOrName,{root?})→summary|skill|content|null; save/upsert({id?,name?,enabled?,url?,frontmatter?,content?})→Promise<Skill>; delete/remove(idOrName)→Promise<boolean>; refresh(idOrName,{timeoutMs?,root?})→Promise<SkillRefreshResult>; parseMarkdown(content)→{frontmatterRaw,frontmatter,body}.",
    ...skillsLines,
    "moo.pointers{get,set,cas,list,entries,delete}: get({name})→Promise<string|null>; set({name,target})→Promise<{name,target,previous,changed}>; cas({name,expected,next})→Promise<boolean>; list({prefix?})→Promise<string[]>; entries({prefix?})→Promise<Array<[string,string]>>; delete({name})→Promise<boolean>.",
    "moo.sparql{query,select,ask,construct}: query({query,store,graph?,limit?,format?})→Promise<Bindings[]|TermBindings[]|boolean|Quad[]>; select({query,store,graph?,limit?,format?})→Promise<Bindings[]|TermBindings[]>; ask({query,store,graph?,limit?})→Promise<boolean>; construct({query,store,graph?,limit?})→Promise<Quad[]>; use for joins, filters, paths, optionals, summaries, derived edges.",
    "  prefer moo.sparql over moo.facts.matchAll for ≥2 patterns, transitive paths, aggregation-ish filters, or CONSTRUCTable derivations.",
    "moo.facts{add,addAll,remove,match,history,matchAll,stores,count,swap,update,clearStore,deleteStore,deleteGraph,deleteGraphEverywhere}: add({store,graph,subject,predicate,object})/remove(...)→Promise<FactMutationReceipt>; addAll({store,quads})/swap({store,removes,adds})/update({store,fn})→Promise<FactMutationReceipt>; match({store,graph?,subject?,predicate?,object?,limit?,format?})→Promise<Quad[]|QuadObject[]>; history(pattern)→Promise<FactHistoryRow[]>.",
    "  moo.facts.matchAll({store,patterns,graph?,limit?})→Promise<Bindings[]>; stores({prefix?})→Promise<string[]>; count({store,graph?,subject?,predicate?,object?})→Promise<number>; clearStore/deleteStore({store,dryRun?})/deleteGraph({store,graph,dryRun?})/deleteGraphEverywhere({graph,dryRun?})→Promise<FactClearReceipt>.",
    "  RDF terms: use exact terms returned by moo.facts.match/moo.sparql.query for delete/retract; don't add/remove quotes. Use moo.term.string({s:'x'}) for literals that look like IRIs/numbers/bools, moo.term.iri({uri:'prefix:Local'}) for uppercase/ambiguous CURIEs.",
    "moo.fs{read,partialRead,write,list,glob,stat,canonical,exists,ensureDir,patch,delete}: read({path})→Promise<string>; partialRead({path:string,lineRanges:[number,number][],numbered?:boolean})→Promise<string> (1-based inclusive line ranges; sorted/collapsed overlaps; inserts `…` for omitted lines; numbered yields aligned `   1: text`); write({path,content})→Promise<void>; list({path})/glob({pattern})→Promise<string[]>; stat({path?})→Promise<{kind,size,mtime}|null>; canonical({path})→Promise<string>; exists({path})→Promise<boolean>; ensureDir({path})→Promise<void>; patch({path:string,diff:string})→Promise<{status:string,output?:string|null}> applies unified/context patch to existing file and throws on failure; delete({path:string,recursive?:boolean})→Promise<{status:string,output?:string|null}> deletes files or empty dirs; recursive:true is required for non-empty dirs; delete failures return status='failed' plus output. Relative paths resolve under scratch.",
    "edits: prefer moo.fs.patch for patch operations on existing files; patch failures throw, so retry only after inspecting context. Before brittle replacements, verify target text with `rg`/`moo.fs.partialRead`; use targeted `moo.fs.write` updates or CLI/editor commands when simpler, then reread when context may have changed.",
    "moo.proc{run,runChecked}: run({cmd,cwd?,stdin?,timeoutMs?,env?,check?,maxOutputBytes?})→Promise<{code,stdout,stderr,durationNs,timedOut,stdoutTruncated?,stderrTruncated?}> where cmd is a non-empty string[] with argv[0] as executable; runChecked({cmd,cwd?,stdin?,timeoutMs?,env?,maxOutputBytes?})→Promise<ProcResult>. Default cwd is scratch; relative cwd resolves under scratch; runChecked throws on nonzero.",
    ...repoLines,
    "moo.workspace{current}: current({chatId?,root?})→Promise<{root,fs:{read,partialRead,write,list,glob,stat,canonical,exists,ensureDir,patch,delete},proc:{run,runChecked}}>; scoped fs/proc use the workspace root.",
    "moo.scratch/moo.scratches{current,list,create,get,delete}: current()→path; list()→[{name,path,exists}]; create({name?,path?,fromCurrent?})→{name,path}; get({name})→path|null; delete({name,recursive?})→{deletedRef,deletedPath}. Named scratches default to siblings under the scratch parent (e.g. ~/moo/<name>), not inside the repo; subagents default to the current scratch and can receive `scratchName`.",
    "moo.http{fetch,stream}: fetch({method?,url,headers?,body?,timeoutMs?})→Promise<{status,body,headers,bodyTruncated}>; stream({method?,url,headers?,body?,timeoutMs?})→Promise<{status,headers,next():Promise<string|null>,close():Promise<void>}>.",
    "moo.events{publish}: publish({payload})→void // ephemeral WS broadcast.",
    "moo.env{get,getMany}: get({name})→Promise<string|null>; getMany({names})→Promise<Record<string,string|null>>.",
    "moo.chat{refs,scratch,touch,list,create,remove,setTitle,recordSummary,archive,unarchive}: refs({chatId})→Promise<ChatRefs>; scratch({chatId})→Promise<string>; touch({chatId})→Promise<void>; list()→Promise<ChatSummary[]>; create({chatId?,path?,branch?})→Promise<string>; remove({chatId})→Promise<{chatId,refsDeleted,quadsCleared}>; setTitle({chatId,title,manual?})→Promise<{chatId,previousTitle,title,changed}>; recordSummary({chatId?,summary,title})→Promise<{chatId,entryId,title?}>; archive({chatId})→Promise<number>; unarchive({chatId})→Promise<null>.",
    "  trail sidebar = title + moo.chat.recordSummary entries. TITLE NOW: on a new chat, call moo.chat.setTitle({chatId,title:'<2-5 word title>'}) immediately before other work (skip only purely trivial chitchat); later retitle when subject/goal shifts or title is stale, not for routine progress. At each milestone call moo.chat.recordSummary({summary:'<1-2 sentence outcome>',title:'<short outcome title>'}); chatId only for cross-chat/admin. Summaries=outcomes, not plans. Don't use runTS labels as progress trail.",
    "moo.ui{ask,choose,say}: ask({chatId,spec:{title?,fields,submitLabel?}})→Promise<string>; choose({chatId,spec:{title?,items}})→Promise<string>; say({chatId,text})→Promise<{chatId,stepId,payloadHash}>.",
    "  moo.ui.ask/choose pause until submit; return request/step id. field type ∈ text|textarea|url|number|boolean|select|secretRef; fields/items non-empty.",
    "moo.ui.apps{register,open}: register({id?,manifest:{id,title,description?,icon?,entry?,api?},bundle:{html?,css?,js?,files?},handler?})→Promise<{uiId,ui,manifestHash,bundleHash,handlerHash,refs}>; open({chatId,uiId,instanceId?,state?})→Promise<{chatId,uiId,instanceId,stateTarget,stateRef,createdState,facts}>.",
    "moo.tools{cancel}: cancel({id,chatId?})→Promise<{chatId,stepId,cancelled}>; id is the background runTS id/stepId shown by a detached `runTS` result; omit chatId in the current chat.",
    "moo.mcp: discover/call servers via dynamic `moo.mcp.<serverId>.<toolName>(args?)`; prefer MCP over ad-hoc HTTP/env creds; don't change server/auth config unless asked.",
    "moo.mcp{list,tools,listServers,getServer,saveServer,removeServer,login,completeLogin,logout,authStatus,listTools,callTool,request}: list()/listServers()→Promise<McpServerConfig[]>; tools(server?)/listTools(serverId?)→Promise<McpTool[]>; getServer(id)→Promise<McpServerConfig|null>; saveServer({id,title?,url,transport?,enabled?,headers?,timeoutMs?,oauth?})→Promise<McpServerConfig>; removeServer(id)→Promise<boolean>; callTool<T>(serverId,name,arguments_?)→Promise<T>; request<T>(serverId,method,params?,opts?)→Promise<T>.",
    "  moo.mcp auth: login(serverId,{origin?,redirectUri?,scope?,returnChatId?})→Promise<{serverId,authorizeUrl,state,redirectUri,expiresAt,returnChatId?}>; completeLogin(state,code)→Promise<McpOAuthStatus>; logout(serverId)→Promise<boolean>; authStatus(serverId)→Promise<McpOAuthStatus>.",
    "  moo.mcp setup: when the user asks to add/change an MCP, don't ask for URL if provider/server is named and its endpoint is well-known; infer id/title/url/transport, ask only for ambiguous/custom fields. Secrets: avoid raw tokens in LLM-visible chat when possible; prefer OAuth or direct manual entry at `/mcp`.",
    mcpNames,
    "moo.agent{run,fork,claim,complete}: run({label,task,tasks?,context?,expectedOutput?,maxSteps?,timeoutMs?,model?,effort?,worktree?,scratchName?})→Promise<{status:'done'|'failed'|'cancelled'|'timeout'|'wait-input',childChatId,output,error?,durationNs,usage?}>; `tasks` seeds the subagent's initial moo.tasks list with TaskAddInput[]; seeded tasks may include `validation` functions that call `moo.judge`; subagents default to the current scratch; pass `scratchName` for a named scratch. Use generous `maxSteps` for substantial work: ~30-50 for focused review/implementation, 60-100 for broad codebase audits or multi-file PR work; avoid tiny caps like 10 except for trivial probes. fork({chatId,fromStepId?})→Promise<{chatId,runId,forkedFrom}>; claim({store,graph,runId,leaseMs?})/complete({store,graph,stepId,status?}) are internals.",
    "moo.judge{check,assert}: LLM subagent judge. check({claim,evidence?,criteria?})→Promise<{ok,score,reason}>; assert(...) throws if not ok. Useful inside task validation, but prefer concrete tool/file/test checks when available.",
    "  subagents: in runTS, start independent work before awaiting for parallelism: const a=moo.agent.run({...}); const b=moo.agent.run({...}); return await Promise.all([a,b]). Only for substantial independent tasks.",
    ...traceLines,
    "",
    "moo.memory: RDF triples in user-wide SQLite. global graph memory:facts; project scope via moo.memory.project({projectId?}). user profile: user:me.",
    "  save durable user prefs / project facts as concise triples; use moo.memory.project({projectId?}) for project facts; avoid secrets/noise.",
    "moo.memory{assert,retract,query,triples,project}: assert({subject,predicate,object}|{facts:Array<[s,p,o]|{subject,predicate,object}>})/retract(...)→Promise<void>; query(patterns:Array<[s,p,o]>,opts?:{limit?})→Promise<Bindings[]>; triples({subject?,predicate?,object?,limit?})→Promise<Quad[]>; project({projectId?})→MemoryScope with same assert/retract/query/triples.",
    "moo.term{iri,string,int,decimal,bool,datetime}: iri({uri})/string({s,lang?,type?})/int({n})/decimal({n})/bool({b})/datetime({d})→Term; use when auto-typing would misclassify.",
    "  auto-typing: 'prefix:local'→IRI, '<full>'→IRI, /^-?\\d+$/→int, true/false→bool, else string literal.",
    "  e.g. moo.memory.assert({subject:'user:me',predicate:'prefers',object:'tool:vim'}); moo.memory.assert({subject:'user:me',predicate:'bio',object:moo.term.string({s:'Hi: vim'})}).",
    "moo.vocab{define,list}: define({name,description?,example?,label?})→Promise<void>; list()→Promise<Array<{name,declared,count,label,description,example}>>; list before inventing predicates.",
    "async: await Promise-returning moo.* results before use (paths, scratch, pointers, rows, refs); `await` is harmless on sync helpers like moo.validate.*, moo.term.*, moo.log, moo.events.publish, moo.memory.project.",
    "compaction: auto near token threshold; manual via token-bar compact button.",
    ...subagentLines,
  ].join("\n");
}

const fsProcDefaultLines = [
  "  `moo.fs.*` use scratch as their default root, and `moo.proc.*` uses scratch as its default cwd; use relative paths normally and absolute paths only when intentionally operating elsewhere.",
];

const repoWorktreeLines = [
  "WORKTREE RULE: `scratch` is the per-chat worktree and the default cwd/root for moo.fs/moo.proc operations.",
  ...fsProcDefaultLines,
  "  `repo` is the main checkout path. Don't edit/build/test/commit there during normal work; use it only when the user explicitly asks to ship/apply/copy/cherry-pick changes to the main repo.",
  "  If a path unexpectedly escapes scratch and the user didn't ask to ship, stop and rerun inside scratch.",
];

const repoLessWorktreeLines = [
  "REPO-LESS CHAT: no repo root is associated; `scratch` is an empty per-chat directory and the default cwd/root for moo.fs/moo.proc operations. Don't assume git/repo files exist.",
  ...fsProcDefaultLines,
];
