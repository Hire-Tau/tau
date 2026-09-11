/**
 * Code AST Extension — TypeScript-aware symbol references, rename, and listing
 *
 * Tools:
 *   ast_references — Find all references to a symbol
 *   ast_symbols    — List symbols in a file
 *   ast_rename     — Rename a symbol across the codebase
 *
 * For TS/JS files: Uses TypeScript compiler API (LanguageService)
 * For other files: Falls back to ripgrep / ctags / regex patterns
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import ts from "typescript";
import { resolve, dirname, relative, extname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// --- Helpers ---

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function isTsFile(filePath: string): boolean {
  return TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function findTsConfig(filePath: string): string | undefined {
  return ts.findConfigFile(dirname(filePath), ts.sys.fileExists, "tsconfig.json");
}

function createService(files: string[], configPath?: string) {
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    compilerOptions = parsed.options;
    files = parsed.fileNames;
  }

  const serviceHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      if (!ts.sys.fileExists(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName)!);
    },
    getCurrentDirectory: () => (configPath ? dirname(configPath) : process.cwd()),
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
}

function findSymbolPosition(
  filePath: string,
  symbol: string,
  line?: number
): number | undefined {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  if (line !== undefined) {
    // Search on the specific line first (1-indexed)
    const lineIdx = line - 1;
    if (lineIdx >= 0 && lineIdx < lines.length) {
      const col = lines[lineIdx].indexOf(symbol);
      if (col !== -1) {
        let offset = 0;
        for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
        return offset + col;
      }
    }
  }

  // Search whole file for a word-boundary match
  const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  let offset = 0;
  for (const l of lines) {
    const match = regex.exec(l);
    if (match) return offset + match.index;
    offset += l.length + 1;
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLineContent(filePath: string, lineNum: number): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (lineNum > 0 && lineNum <= lines.length) {
      return lines[lineNum - 1].trim();
    }
  } catch {}
  return "";
}

interface RefLocation {
  file: string;
  line: number;
  column: number;
  context: string;
}

// --- TS-based operations ---

function tsReferences(filePath: string, symbol: string, line?: number): RefLocation[] {
  const absPath = resolve(filePath);
  const configPath = findTsConfig(absPath);
  const service = createService([absPath], configPath);

  const position = findSymbolPosition(absPath, symbol, line);
  if (position === undefined) return [];

  const refs = service.findReferences(absPath, position);
  if (!refs) return [];

  const results: RefLocation[] = [];
  for (const refGroup of refs) {
    for (const ref of refGroup.references) {
      const sourceFile = service.getProgram()?.getSourceFile(ref.fileName);
      if (!sourceFile) continue;
      const { line: refLine, character } = sourceFile.getLineAndCharacterOfPosition(
        ref.textSpan.start
      );
      results.push({
        file: ref.fileName,
        line: refLine + 1,
        column: character + 1,
        context: getLineContent(ref.fileName, refLine + 1),
      });
    }
  }

  service.dispose();
  return results;
}

function tsRename(
  filePath: string,
  oldName: string,
  newName: string,
  line?: number
): { file: string; changes: number }[] {
  const absPath = resolve(filePath);
  const configPath = findTsConfig(absPath);
  const service = createService([absPath], configPath);

  const position = findSymbolPosition(absPath, oldName, line);
  if (position === undefined) {
    service.dispose();
    return [];
  }

  const locations = service.findRenameLocations(absPath, position, false, false);
  if (!locations || locations.length === 0) {
    service.dispose();
    return [];
  }

  // Group by file
  const byFile = new Map<string, ts.RenameLocation[]>();
  for (const loc of locations) {
    const arr = byFile.get(loc.fileName) || [];
    arr.push(loc);
    byFile.set(loc.fileName, arr);
  }

  const modified: { file: string; changes: number }[] = [];

  for (const [file, locs] of byFile) {
    // Sort by position descending so edits don't shift later positions
    locs.sort((a, b) => b.textSpan.start - a.textSpan.start);

    let content = readFileSync(file, "utf-8");
    for (const loc of locs) {
      const before = content.slice(0, loc.textSpan.start);
      const after = content.slice(loc.textSpan.start + loc.textSpan.length);
      content = before + newName + after;
    }
    writeFileSync(file, content, "utf-8");
    modified.push({ file, changes: locs.length });
  }

  service.dispose();
  return modified;
}

interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
}

function tsSymbols(filePath: string, kindFilter?: string): SymbolInfo[] {
  const absPath = resolve(filePath);
  const content = readFileSync(absPath, "utf-8");
  const sourceFile = ts.createSourceFile(absPath, content, ts.ScriptTarget.ESNext, true);

  const symbols: SymbolInfo[] = [];

  function hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  function visit(node: ts.Node) {
    let name: string | undefined;
    let kind: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      kind = "function";
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
      kind = "class";
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
      kind = "interface";
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
      kind = "type";
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
      kind = "enum";
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varKind =
            node.declarationList.flags & ts.NodeFlags.Const
              ? "const"
              : node.declarationList.flags & ts.NodeFlags.Let
                ? "let"
                : "variable";
          const sym: SymbolInfo = {
            name: decl.name.text,
            kind: varKind,
            line: sourceFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
            exported,
          };
          if (!kindFilter || sym.kind === kindFilter || (kindFilter === "variable" && ["const", "let", "variable"].includes(sym.kind))) {
            symbols.push(sym);
          }
        }
      }
      return; // handled
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
      kind = "method";
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
      kind = "property";
    }

    if (name && kind) {
      const sym: SymbolInfo = {
        name,
        kind,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        exported: hasExportModifier(node),
      };
      if (!kindFilter || sym.kind === kindFilter) {
        symbols.push(sym);
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return symbols;
}

// --- Fallback (non-TS) operations ---

async function rgReferences(
  pi: ExtensionAPI,
  symbol: string,
  file: string,
  signal?: AbortSignal
): Promise<RefLocation[]> {
  const cwd = dirname(resolve(file));
  const result = await pi.exec("rg", ["--word-regexp", "--line-number", "--column", "--no-heading", symbol], {
    signal,
    cwd,
    timeout: 15000,
  });

  if (result.code !== 0 && result.code !== 1) return [];

  const refs: RefLocation[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (match) {
      refs.push({
        file: resolve(cwd, match[1]),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        context: match[4].trim(),
      });
    }
  }
  return refs;
}

async function rgRename(
  pi: ExtensionAPI,
  oldName: string,
  newName: string,
  file: string,
  signal?: AbortSignal
): Promise<{ file: string; changes: number }[]> {
  const refs = await rgReferences(pi, oldName, file, signal);
  if (refs.length === 0) return [];

  // Group by file
  const byFile = new Map<string, RefLocation[]>();
  for (const ref of refs) {
    const arr = byFile.get(ref.file) || [];
    arr.push(ref);
    byFile.set(ref.file, arr);
  }

  const modified: { file: string; changes: number }[] = [];
  const wordRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");

  for (const [filePath, _locs] of byFile) {
    const content = readFileSync(filePath, "utf-8");
    const newContent = content.replace(wordRegex, newName);
    if (content !== newContent) {
      writeFileSync(filePath, newContent, "utf-8");
      const count = (content.match(wordRegex) || []).length;
      modified.push({ file: filePath, changes: count });
    }
  }
  return modified;
}

async function fallbackSymbols(
  pi: ExtensionAPI,
  filePath: string,
  kindFilter?: string,
  signal?: AbortSignal
): Promise<SymbolInfo[]> {
  const absPath = resolve(filePath);

  // Try ctags first
  try {
    const result = await pi.exec(
      "ctags",
      ["--output-format=json", "--fields=+n", "-f", "-", absPath],
      { signal, timeout: 10000 }
    );
    if (result.code === 0 && result.stdout.trim()) {
      const symbols: SymbolInfo[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const tag = JSON.parse(line);
          const sym: SymbolInfo = {
            name: tag.name,
            kind: tag.kind || "unknown",
            line: tag.line || 0,
            exported: false,
          };
          if (!kindFilter || sym.kind === kindFilter) {
            symbols.push(sym);
          }
        } catch {}
      }
      if (symbols.length > 0) return symbols;
    }
  } catch {}

  // Regex fallback for common patterns
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const symbols: SymbolInfo[] = [];

  const patterns: [RegExp, string][] = [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,        "function"],
    [/^\s*(?:export\s+)?class\s+(\w+)/,                        "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/,             "variable"],
    [/^\s*def\s+(\w+)/,                                         "function"],    // Python
    [/^\s*class\s+(\w+)/,                                       "class"],       // Python
    [/^\s*(?:pub\s+)?fn\s+(\w+)/,                               "function"],    // Rust
    [/^\s*(?:pub\s+)?struct\s+(\w+)/,                           "class"],       // Rust
    [/^\s*(?:pub\s+)?enum\s+(\w+)/,                             "enum"],        // Rust
    [/^\s*func\s+(\w+)/,                                        "function"],    // Go
    [/^\s*type\s+(\w+)\s+struct/,                               "class"],       // Go
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const [pattern, kind] of patterns) {
      const match = lines[i].match(pattern);
      if (match) {
        const exported = /^\s*(?:export|pub)\s/.test(lines[i]);
        const sym: SymbolInfo = {
          name: match[1],
          kind,
          line: i + 1,
          exported,
        };
        if (!kindFilter || sym.kind === kindFilter) {
          symbols.push(sym);
        }
        break;
      }
    }
  }
  return symbols;
}

// --- Rendering helpers ---

function renderCallText(toolName: string, args: Record<string, any>, theme: Theme): Text {
  let text = theme.fg("toolTitle", theme.bold(toolName + " "));
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (val !== undefined) {
      parts.push(theme.fg("muted", `${key}=`) + theme.fg("dim", String(val)));
    }
  }
  text += parts.join(" ");
  return new Text(text, 0, 0);
}

function renderRefResult(
  refs: RefLocation[],
  label: string,
  theme: Theme,
  expanded: boolean
): Text {
  if (refs.length === 0) {
    return new Text(theme.fg("warning", "No references found"), 0, 0);
  }

  let text = theme.fg("success", `✓ ${refs.length} ${label}`);
  if (expanded) {
    for (const ref of refs) {
      text += "\n  " + theme.fg("accent", `${ref.file}:${ref.line}:${ref.column}`);
      if (ref.context) {
        text += " " + theme.fg("dim", ref.context);
      }
    }
  }
  return new Text(text, 0, 0);
}

function formatRefsOutput(refs: RefLocation[], cwd: string): string {
  if (refs.length === 0) return "No references found.";
  const lines = refs.map((r) => {
    const relPath = relative(cwd, r.file) || r.file;
    return `${relPath}:${r.line}:${r.column}: ${r.context}`;
  });
  return `Found ${refs.length} reference(s):\n\n${lines.join("\n")}`;
}

// --- Extension entry ---

export default function (pi: ExtensionAPI) {
  // === ast_references ===
  pi.registerTool({
    name: "ast_references",
    label: "Find References",
    description:
      "Find all references to a symbol in the codebase. For TS/JS files uses the TypeScript compiler API; for other files falls back to ripgrep word-boundary search.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to find references for" }),
      file: Type.String({ description: "File where the symbol is defined" }),
      line: Type.Optional(Type.Number({ description: "Line number where the symbol is defined (1-indexed)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = resolve(params.file.replace(/^@/, ""));

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
          details: { refs: [], error: true },
        };
      }

      let refs: RefLocation[];
      if (isTsFile(filePath)) {
        try {
          refs = tsReferences(filePath, params.symbol, params.line);
        } catch (err: any) {
          refs = await rgReferences(pi, params.symbol, filePath, signal);
        }
      } else {
        refs = await rgReferences(pi, params.symbol, filePath, signal);
      }

      const output = formatRefsOutput(refs, ctx.cwd);
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let result = truncation.content;
      if (truncation.truncated) {
        result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: result }],
        details: { refs },
      };
    },

    renderCall(args: any, theme: Theme) {
      return renderCallText("ast_references", { symbol: args.symbol, file: args.file, line: args.line }, theme);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: Theme) {
      const refs: RefLocation[] = result.details?.refs ?? [];
      return renderRefResult(refs, "reference(s)", theme, expanded);
    },
  });

  // === ast_rename ===
  pi.registerTool({
    name: "ast_rename",
    label: "Rename Symbol",
    description:
      "Rename a symbol across the codebase. For TS/JS files uses TypeScript's LanguageService findRenameLocations; for other files uses ripgrep. Actually applies the edits to all files.",
    parameters: Type.Object({
      oldName: Type.String({ description: "Current symbol name" }),
      newName: Type.String({ description: "New symbol name" }),
      file: Type.String({ description: "File where the symbol is defined" }),
      line: Type.Optional(Type.Number({ description: "Line number where the symbol is defined (1-indexed)" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = resolve(params.file.replace(/^@/, ""));

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
          details: { modified: [], error: true },
        };
      }

      let modified: { file: string; changes: number }[];
      if (isTsFile(filePath)) {
        try {
          modified = tsRename(filePath, params.oldName, params.newName, params.line);
        } catch (err: any) {
          modified = await rgRename(pi, params.oldName, params.newName, filePath, signal);
        }
      } else {
        modified = await rgRename(pi, params.oldName, params.newName, filePath, signal);
      }

      if (modified.length === 0) {
        return {
          content: [{ type: "text", text: `No occurrences of '${params.oldName}' found to rename.` }],
          details: { modified },
        };
      }

      const lines = modified.map((m) => {
        const relPath = relative(ctx.cwd, m.file) || m.file;
        return `${relPath}: ${m.changes} change(s)`;
      });
      const totalChanges = modified.reduce((sum, m) => sum + m.changes, 0);
      const output = `Renamed '${params.oldName}' → '${params.newName}' — ${totalChanges} change(s) across ${modified.length} file(s):\n\n${lines.join("\n")}`;

      return {
        content: [{ type: "text", text: output }],
        details: { modified },
      };
    },

    renderCall(args: any, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("ast_rename "));
      text += theme.fg("dim", args.oldName) + theme.fg("muted", " → ") + theme.fg("accent", args.newName);
      text += " " + theme.fg("muted", `in ${args.file}`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: Theme) {
      const modified: { file: string; changes: number }[] = result.details?.modified ?? [];
      if (result.details?.error) {
        return new Text(theme.fg("error", "Error: file not found"), 0, 0);
      }
      if (modified.length === 0) {
        return new Text(theme.fg("warning", "No occurrences found"), 0, 0);
      }
      const total = modified.reduce((s, m) => s + m.changes, 0);
      let text = theme.fg("success", `✓ ${total} change(s) in ${modified.length} file(s)`);
      if (expanded) {
        for (const m of modified) {
          text += "\n  " + theme.fg("accent", m.file) + theme.fg("dim", ` (${m.changes})`);
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // === ast_symbols ===
  pi.registerTool({
    name: "ast_symbols",
    label: "List Symbols",
    description:
      "List symbols (functions, classes, variables, interfaces, types, enums, etc.) in a file. For TS/JS files uses the TypeScript compiler API; for other files uses ctags or regex patterns.",
    parameters: Type.Object({
      file: Type.String({ description: "File to list symbols from" }),
      kind: Type.Optional(
        Type.String({
          description: "Filter by kind: function, class, variable, const, let, interface, type, enum, method, property",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = resolve(params.file.replace(/^@/, ""));

      if (!existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${filePath}` }],
          isError: true,
          details: { symbols: [], error: true },
        };
      }

      let symbols: SymbolInfo[];
      if (isTsFile(filePath)) {
        try {
          symbols = tsSymbols(filePath, params.kind);
        } catch (err: any) {
          symbols = await fallbackSymbols(pi, filePath, params.kind, signal);
        }
      } else {
        symbols = await fallbackSymbols(pi, filePath, params.kind, signal);
      }

      if (symbols.length === 0) {
        return {
          content: [{ type: "text", text: `No symbols found${params.kind ? ` of kind '${params.kind}'` : ""}.` }],
          details: { symbols },
        };
      }

      const lines = symbols.map((s) => {
        const exp = s.exported ? " (exported)" : "";
        return `  L${s.line}  ${s.kind.padEnd(12)} ${s.name}${exp}`;
      });
      const relPath = relative(ctx.cwd, filePath) || filePath;
      const output = `${symbols.length} symbol(s) in ${relPath}:\n\n${lines.join("\n")}`;

      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let result = truncation.content;
      if (truncation.truncated) {
        result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
      }

      return {
        content: [{ type: "text", text: result }],
        details: { symbols },
      };
    },

    renderCall(args: any, theme: Theme) {
      return renderCallText("ast_symbols", { file: args.file, kind: args.kind }, theme);
    },

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: Theme) {
      const symbols: SymbolInfo[] = result.details?.symbols ?? [];
      if (result.details?.error) {
        return new Text(theme.fg("error", "Error: file not found"), 0, 0);
      }
      if (symbols.length === 0) {
        return new Text(theme.fg("warning", "No symbols found"), 0, 0);
      }
      let text = theme.fg("success", `✓ ${symbols.length} symbol(s)`);
      if (expanded) {
        for (const s of symbols) {
          const exp = s.exported ? theme.fg("accent", " ✦") : "";
          text +=
            "\n  " +
            theme.fg("dim", `L${String(s.line).padStart(4)}`) +
            " " +
            theme.fg("muted", s.kind.padEnd(12)) +
            " " +
            theme.fg("toolTitle", s.name) +
            exp;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
