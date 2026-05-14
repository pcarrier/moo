import ts from "typescript";
import lib0 from "typescript/lib/lib.decorators.d.ts" with { type: "text" };
import lib1 from "typescript/lib/lib.decorators.legacy.d.ts" with { type: "text" };
import lib2 from "typescript/lib/lib.es5.d.ts" with { type: "text" };
import lib3 from "typescript/lib/lib.es2015.d.ts" with { type: "text" };
import lib4 from "typescript/lib/lib.es2015.core.d.ts" with { type: "text" };
import lib5 from "typescript/lib/lib.es2015.collection.d.ts" with { type: "text" };
import lib6 from "typescript/lib/lib.es2015.iterable.d.ts" with { type: "text" };
import lib7 from "typescript/lib/lib.es2015.generator.d.ts" with { type: "text" };
import lib8 from "typescript/lib/lib.es2015.promise.d.ts" with { type: "text" };
import lib9 from "typescript/lib/lib.es2015.proxy.d.ts" with { type: "text" };
import lib10 from "typescript/lib/lib.es2015.reflect.d.ts" with { type: "text" };
import lib11 from "typescript/lib/lib.es2015.symbol.d.ts" with { type: "text" };
import lib12 from "typescript/lib/lib.es2015.symbol.wellknown.d.ts" with { type: "text" };
import lib13 from "typescript/lib/lib.es2016.d.ts" with { type: "text" };
import lib14 from "typescript/lib/lib.es2016.array.include.d.ts" with { type: "text" };
import lib15 from "typescript/lib/lib.es2016.intl.d.ts" with { type: "text" };
import lib16 from "typescript/lib/lib.es2017.d.ts" with { type: "text" };
import lib17 from "typescript/lib/lib.es2017.arraybuffer.d.ts" with { type: "text" };
import lib18 from "typescript/lib/lib.es2017.date.d.ts" with { type: "text" };
import lib19 from "typescript/lib/lib.es2017.intl.d.ts" with { type: "text" };
import lib20 from "typescript/lib/lib.es2017.object.d.ts" with { type: "text" };
import lib21 from "typescript/lib/lib.es2017.sharedmemory.d.ts" with { type: "text" };
import lib22 from "typescript/lib/lib.es2017.string.d.ts" with { type: "text" };
import lib23 from "typescript/lib/lib.es2017.typedarrays.d.ts" with { type: "text" };
import lib24 from "typescript/lib/lib.es2018.d.ts" with { type: "text" };
import lib25 from "typescript/lib/lib.es2018.asyncgenerator.d.ts" with { type: "text" };
import lib26 from "typescript/lib/lib.es2018.asynciterable.d.ts" with { type: "text" };
import lib27 from "typescript/lib/lib.es2018.intl.d.ts" with { type: "text" };
import lib28 from "typescript/lib/lib.es2018.promise.d.ts" with { type: "text" };
import lib29 from "typescript/lib/lib.es2018.regexp.d.ts" with { type: "text" };
import lib30 from "typescript/lib/lib.es2019.d.ts" with { type: "text" };
import lib31 from "typescript/lib/lib.es2019.array.d.ts" with { type: "text" };
import lib32 from "typescript/lib/lib.es2019.intl.d.ts" with { type: "text" };
import lib33 from "typescript/lib/lib.es2019.object.d.ts" with { type: "text" };
import lib34 from "typescript/lib/lib.es2019.string.d.ts" with { type: "text" };
import lib35 from "typescript/lib/lib.es2019.symbol.d.ts" with { type: "text" };
import lib36 from "typescript/lib/lib.es2020.d.ts" with { type: "text" };
import lib37 from "typescript/lib/lib.es2020.bigint.d.ts" with { type: "text" };
import lib38 from "typescript/lib/lib.es2020.date.d.ts" with { type: "text" };
import lib39 from "typescript/lib/lib.es2020.intl.d.ts" with { type: "text" };
import lib40 from "typescript/lib/lib.es2020.number.d.ts" with { type: "text" };
import lib41 from "typescript/lib/lib.es2020.promise.d.ts" with { type: "text" };
import lib42 from "typescript/lib/lib.es2020.sharedmemory.d.ts" with { type: "text" };
import lib43 from "typescript/lib/lib.es2020.string.d.ts" with { type: "text" };
import lib44 from "typescript/lib/lib.es2020.symbol.wellknown.d.ts" with { type: "text" };
import lib45 from "typescript/lib/lib.es2021.d.ts" with { type: "text" };
import lib46 from "typescript/lib/lib.es2021.intl.d.ts" with { type: "text" };
import lib47 from "typescript/lib/lib.es2021.promise.d.ts" with { type: "text" };
import lib48 from "typescript/lib/lib.es2021.string.d.ts" with { type: "text" };
import lib49 from "typescript/lib/lib.es2021.weakref.d.ts" with { type: "text" };
import lib50 from "typescript/lib/lib.es2022.d.ts" with { type: "text" };
import lib51 from "typescript/lib/lib.es2022.array.d.ts" with { type: "text" };
import lib52 from "typescript/lib/lib.es2022.error.d.ts" with { type: "text" };
import lib53 from "typescript/lib/lib.es2022.intl.d.ts" with { type: "text" };
import lib54 from "typescript/lib/lib.es2022.object.d.ts" with { type: "text" };
import lib55 from "typescript/lib/lib.es2022.regexp.d.ts" with { type: "text" };
import lib56 from "typescript/lib/lib.es2022.string.d.ts" with { type: "text" };
import lib57 from "typescript/lib/lib.es2023.d.ts" with { type: "text" };
import lib58 from "typescript/lib/lib.es2023.array.d.ts" with { type: "text" };
import lib59 from "typescript/lib/lib.es2023.collection.d.ts" with { type: "text" };
import lib60 from "typescript/lib/lib.es2023.intl.d.ts" with { type: "text" };
import lib61 from "typescript/lib/lib.es2024.d.ts" with { type: "text" };
import lib62 from "typescript/lib/lib.es2024.arraybuffer.d.ts" with { type: "text" };
import lib63 from "typescript/lib/lib.es2024.collection.d.ts" with { type: "text" };
import lib64 from "typescript/lib/lib.es2024.object.d.ts" with { type: "text" };
import lib65 from "typescript/lib/lib.es2024.promise.d.ts" with { type: "text" };
import lib66 from "typescript/lib/lib.es2024.regexp.d.ts" with { type: "text" };
import lib67 from "typescript/lib/lib.es2024.sharedmemory.d.ts" with { type: "text" };
import lib68 from "typescript/lib/lib.es2024.string.d.ts" with { type: "text" };
import lib69 from "typescript/lib/lib.es2025.d.ts" with { type: "text" };
import lib70 from "typescript/lib/lib.es2025.collection.d.ts" with { type: "text" };
import lib71 from "typescript/lib/lib.es2025.float16.d.ts" with { type: "text" };
import lib72 from "typescript/lib/lib.es2025.intl.d.ts" with { type: "text" };
import lib73 from "typescript/lib/lib.es2025.iterator.d.ts" with { type: "text" };
import lib74 from "typescript/lib/lib.es2025.promise.d.ts" with { type: "text" };
import lib75 from "typescript/lib/lib.es2025.regexp.d.ts" with { type: "text" };
import ambientTypesSource from "./runts_ambient.d.txt" with { type: "text" };

export type RunTSCompileResult = {
  js: string;
  diagnostics: string[];
};

const RUNTIME_FILE = "/runts/run.ts";
const AMBIENT_FILE = "/runts/ambient.d.ts";

const LIB_SOURCES: Array<[string, string]> = [
  ["lib.decorators.d.ts", lib0],
  ["lib.decorators.legacy.d.ts", lib1],
  ["lib.es5.d.ts", lib2],
  ["lib.es2015.d.ts", lib3],
  ["lib.es2015.core.d.ts", lib4],
  ["lib.es2015.collection.d.ts", lib5],
  ["lib.es2015.iterable.d.ts", lib6],
  ["lib.es2015.generator.d.ts", lib7],
  ["lib.es2015.promise.d.ts", lib8],
  ["lib.es2015.proxy.d.ts", lib9],
  ["lib.es2015.reflect.d.ts", lib10],
  ["lib.es2015.symbol.d.ts", lib11],
  ["lib.es2015.symbol.wellknown.d.ts", lib12],
  ["lib.es2016.d.ts", lib13],
  ["lib.es2016.array.include.d.ts", lib14],
  ["lib.es2016.intl.d.ts", lib15],
  ["lib.es2017.d.ts", lib16],
  ["lib.es2017.arraybuffer.d.ts", lib17],
  ["lib.es2017.date.d.ts", lib18],
  ["lib.es2017.intl.d.ts", lib19],
  ["lib.es2017.object.d.ts", lib20],
  ["lib.es2017.sharedmemory.d.ts", lib21],
  ["lib.es2017.string.d.ts", lib22],
  ["lib.es2017.typedarrays.d.ts", lib23],
  ["lib.es2018.d.ts", lib24],
  ["lib.es2018.asyncgenerator.d.ts", lib25],
  ["lib.es2018.asynciterable.d.ts", lib26],
  ["lib.es2018.intl.d.ts", lib27],
  ["lib.es2018.promise.d.ts", lib28],
  ["lib.es2018.regexp.d.ts", lib29],
  ["lib.es2019.d.ts", lib30],
  ["lib.es2019.array.d.ts", lib31],
  ["lib.es2019.intl.d.ts", lib32],
  ["lib.es2019.object.d.ts", lib33],
  ["lib.es2019.string.d.ts", lib34],
  ["lib.es2019.symbol.d.ts", lib35],
  ["lib.es2020.d.ts", lib36],
  ["lib.es2020.bigint.d.ts", lib37],
  ["lib.es2020.date.d.ts", lib38],
  ["lib.es2020.intl.d.ts", lib39],
  ["lib.es2020.number.d.ts", lib40],
  ["lib.es2020.promise.d.ts", lib41],
  ["lib.es2020.sharedmemory.d.ts", lib42],
  ["lib.es2020.string.d.ts", lib43],
  ["lib.es2020.symbol.wellknown.d.ts", lib44],
  ["lib.es2021.d.ts", lib45],
  ["lib.es2021.intl.d.ts", lib46],
  ["lib.es2021.promise.d.ts", lib47],
  ["lib.es2021.string.d.ts", lib48],
  ["lib.es2021.weakref.d.ts", lib49],
  ["lib.es2022.d.ts", lib50],
  ["lib.es2022.array.d.ts", lib51],
  ["lib.es2022.error.d.ts", lib52],
  ["lib.es2022.intl.d.ts", lib53],
  ["lib.es2022.object.d.ts", lib54],
  ["lib.es2022.regexp.d.ts", lib55],
  ["lib.es2022.string.d.ts", lib56],
  ["lib.es2023.d.ts", lib57],
  ["lib.es2023.array.d.ts", lib58],
  ["lib.es2023.collection.d.ts", lib59],
  ["lib.es2023.intl.d.ts", lib60],
  ["lib.es2024.d.ts", lib61],
  ["lib.es2024.arraybuffer.d.ts", lib62],
  ["lib.es2024.collection.d.ts", lib63],
  ["lib.es2024.object.d.ts", lib64],
  ["lib.es2024.promise.d.ts", lib65],
  ["lib.es2024.regexp.d.ts", lib66],
  ["lib.es2024.sharedmemory.d.ts", lib67],
  ["lib.es2024.string.d.ts", lib68],
  ["lib.es2025.d.ts", lib69],
  ["lib.es2025.collection.d.ts", lib70],
  ["lib.es2025.float16.d.ts", lib71],
  ["lib.es2025.intl.d.ts", lib72],
  ["lib.es2025.iterator.d.ts", lib73],
  ["lib.es2025.promise.d.ts", lib74],
  ["lib.es2025.regexp.d.ts", lib75],
];

const HARNESS_TYPE_SOURCES: Array<[string, string]> = [
  ["/runts/harness-types.d.ts", ambientTypesSource],
];

const RUNTS_AMBIENT = [
  "declare global {",
  "  /** Harness API object available to runTS code. */",
  "  const moo: Moo;",
  "  /** Current chat id. */",
  "  const chatId: string;",
  "  /** Repository/root pointer for the current chat, or \".\". */",
  "  const repo: string;",
  "  /** Per-chat scratch/worktree path. */",
  "  const scratch: string;",
  "  /** Optional JSON value passed as the tool args field. */",
  "  const args: any;",
  "",
  "  function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;",
  "  function clearTimeout(handle?: any): void;",
  "  function setImmediate(handler: (...args: any[]) => void, ...args: any[]): any;",
  "  function clearImmediate(handle?: any): void;",
  "",
  "  const console: {",
  "    log(...args: unknown[]): void;",
  "    error(...args: unknown[]): void;",
  "    warn(...args: unknown[]): void;",
  "  };",
  "}",
  "",
  "export {};",
].join("\n");

function normalizeFileName(fileName: string): string {
  const cleaned = String(fileName || "").replaceAll("\\", "/");
  const parts: string[] = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function baseName(fileName: string): string {
  const normalized = normalizeFileName(fileName);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function dirName(fileName: string): string {
  const normalized = normalizeFileName(fileName);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

function resolveBundledModule(moduleName: string, containingFile: string, files: Map<string, string>): string | null {
  if (moduleName.startsWith("/")) {
    const absolute = normalizeFileName(moduleName);
    for (const candidate of [absolute, absolute + ".ts", absolute + ".d.ts", absolute + "/index.ts"]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  }
  if (!moduleName.startsWith(".")) return null;
  const base = normalizeFileName(dirName(containingFile) + "/" + moduleName);
  for (const candidate of [base, base + ".ts", base + ".d.ts", base + "/index.ts"]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function runTSCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2025,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: true,
    noEmitOnError: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2025.d.ts"],
  };
}

const USER_BODY_LINE_OFFSET = 1;

function countLines(text: string): number {
  if (text.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function formatDiagnostic(diagnostic: ts.Diagnostic, userBodyLineCount = 0): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file && typeof diagnostic.start === "number") {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const file = diagnostic.file.fileName === RUNTIME_FILE ? "code" : baseName(diagnostic.file.fileName);
    let line = pos.line + 1;
    let character = pos.character + 1;
    if (diagnostic.file.fileName === RUNTIME_FILE && pos.line >= USER_BODY_LINE_OFFSET) {
      line = pos.line - USER_BODY_LINE_OFFSET + 1;
      if (userBodyLineCount > 0 && line > userBodyLineCount) line = userBodyLineCount;
    }
    return file + ":" + line + ":" + character + " TS" + diagnostic.code + ": " + message;
  }
  return "TS" + diagnostic.code + ": " + message;
}

function userBodyToProgram(code: string): string {
  return "async function __runTS__() {\n" + code + "\n}";
}

export function compileRunTS(code: string): RunTSCompileResult {
  const userBodyLineCount = countLines(code);
  const files = new Map<string, string>();
  for (const [name, source] of LIB_SOURCES) files.set(name, source);
  for (const [name, source] of HARNESS_TYPE_SOURCES) files.set(name, source);
  files.set(AMBIENT_FILE, RUNTS_AMBIENT);
  files.set(RUNTIME_FILE, userBodyToProgram(code));

  const options = runTSCompilerOptions();
  const outputs = new Map<string, string>();
  const hasVirtualFile = (fileName: string) => {
    const exact = normalizeFileName(fileName);
    return files.has(exact) || files.has(baseName(exact));
  };
  const readVirtualFile = (fileName: string) => {
    const exact = normalizeFileName(fileName);
    return files.get(exact) ?? files.get(baseName(exact));
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const exact = normalizeFileName(fileName);
      const source = readVirtualFile(exact);
      return source == null ? undefined : ts.createSourceFile(exact, source, languageVersion, true);
    },
    getDefaultLibFileName: () => "lib.es2025.d.ts",
    getDefaultLibLocation: () => "/",
    writeFile: (fileName, text) => outputs.set(normalizeFileName(fileName), text),
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: hasVirtualFile,
    readFile: readVirtualFile,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: normalizeFileName,
    getNewLine: () => "\n",
    directoryExists: () => true,
    realpath: normalizeFileName,
    resolveModuleNames: (moduleNames, containingFile) => moduleNames.map((moduleName) => {
      const resolved = resolveBundledModule(moduleName, containingFile, files);
      if (!resolved) return undefined;
      return {
        resolvedFileName: resolved,
        extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
      };
    }),
  };

  const program = ts.createProgram([...HARNESS_TYPE_SOURCES.map(([name]) => name), AMBIENT_FILE, RUNTIME_FILE], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) return { js: "", diagnostics: diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, userBodyLineCount)) };

  const source = program.getSourceFile(RUNTIME_FILE);
  if (!source) return { js: "", diagnostics: ["internal error: runTS source file missing"] };
  const emit = program.emit(source);
  const emitDiagnostics = emit.diagnostics ?? [];
  if (emit.emitSkipped || emitDiagnostics.length) {
    return { js: "", diagnostics: emitDiagnostics.map((diagnostic) => formatDiagnostic(diagnostic, userBodyLineCount)) };
  }
  const js = outputs.get("/runts/run.js") ?? outputs.get("run.js") ?? "";
  if (!js.trim()) return { js: "", diagnostics: ["internal error: TypeScript emitted no JavaScript"] };
  return { js, diagnostics: [] };
}
