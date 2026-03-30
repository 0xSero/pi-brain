/**
 * @file plugins/pi/index.ts
 *
 * Pi source plugin — reads Pi coding agent JSONL sessions from
 * ~/.pi/agent/sessions/ and converts them to CanonicalSession format.
 *
 * Pi sessions are JSONL files where each line is a typed entry with
 * id/parentId forming a tree. We walk from the leaf to the root to
 * extract the active conversation branch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { CanonicalMessage, CanonicalSession } from "../../core/data-processing/types.js";
import type {
	ExportFormat,
	HuggingFaceUploadConfig,
	PiBrainConfig,
	SourcePlugin,
} from "../../core/index.js";
import {
	anonymize,
	createBundle,
	resolveConfig,
	sanitize,
	upload,
	writeBundle,
} from "../../core/index.js";
import { dirExists, findFiles, home, parseJsonlString, sessionIdFromPath } from "../helpers.js";

const SESSION_DIR = join(home(), ".pi", "agent", "sessions");
const PI_CONFIG_PATH = join(home(), ".pi", "agent", "pi-brain.json");
type ExportScope = "current" | "all";
type ExportMode = "local" | "public";

export const piPlugin: SourcePlugin = {
	name: "pi",

	async listSessions(): Promise<string[]> {
		if (!dirExists(SESSION_DIR)) return [];
		return findFiles(SESSION_DIR, (name) => name.endsWith(".jsonl"));
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const filePath = ref.startsWith("/") ? ref : join(SESSION_DIR, ref);
		const content = readFileSync(filePath, "utf-8");
		const entries = parseJsonlString(content);

		return piEntriesToCanonical(entries, filePath);
	},
};

const DEFAULT_EXPORT_FORMATS = ["sessions", "sft-jsonl", "chatml"] as const;

/**
 * Register Pi commands for the Pi runtime.
 *
 * These commands intentionally stay in the same package as the source plugin so
 * `/dataset-*` can call the exact same runtime pipeline used by the standalone
 * CLI.
 */
export default function registerPiCommands(pi: ExtensionAPI) {
	pi.registerCommand("export", {
		description: "Export locally or publish sanitized Pi sessions",
		getArgumentCompletions: (prefix) => {
			const options = [
				"local",
				"public",
				"--current",
				"--all",
				"--repo",
				"--public",
				"--private",
				"--format",
				"--format=sessions",
				"--format=sft-jsonl",
				"--format=chatml",
				"--output",
			];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const resolved = await resolveExportAlias(args, ctx);
			if (!resolved) {
				showCommandResult(ctx, "Export cancelled", true);
				return;
			}

			if (resolved.mode === "local") {
				let result = await runLocalExport(
					resolved.args,
					ctx.sessionManager.getSessionFile() ?? undefined,
					resolved.scope,
				);
				if (!result.success && resolved.scope === "current") {
					const fallback = await maybeFallbackToAllSessions(
						ctx,
						result.message,
						"Export all sessions instead?",
					);
					if (fallback) {
						result = await runLocalExport(
							resolved.args,
							ctx.sessionManager.getSessionFile() ?? undefined,
							"all",
						);
					}
				}
				showCommandResult(ctx, result.message, result.success);
				return;
			}

			let result = await runPublicExport(
				resolved.args,
				ctx.sessionManager.getSessionFile() ?? undefined,
				resolved.scope,
			);
			if (!result.success && resolved.scope === "current") {
				const fallback = await maybeFallbackToAllSessions(
					ctx,
					result.message,
					"Publish all sessions instead?",
				);
				if (fallback) {
					result = await runPublicExport(
						resolved.args,
						ctx.sessionManager.getSessionFile() ?? undefined,
						"all",
					);
				}
			}
			showCommandResult(ctx, result.message, result.success);
		},
	});

	pi.registerCommand("export-local", {
		description: "Export Pi sessions to sanitized training formats",
		getArgumentCompletions: (prefix) => {
			const options = [
				"--current",
				"--all",
				"--format",
				"--format=sessions",
				"--format=sft-jsonl",
				"--format=chatml",
				"--output",
			];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const scope = await resolveExportScope(args, ctx);
			if (!scope) {
				showCommandResult(ctx, "Export cancelled", true);
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			let result = await runLocalExport(args, currentSessionFile, scope);
			if (!result.success && scope === "current") {
				const fallback = await maybeFallbackToAllSessions(
					ctx,
					result.message,
					"Export all sessions instead?",
				);
				if (fallback) {
					result = await runLocalExport(args, currentSessionFile, "all");
				}
			}

			showCommandResult(ctx, result.message, result.success);
		},
	});

	pi.registerCommand("export-public", {
		description: "Export sanitized Pi sessions and publish them to Hugging Face",
		getArgumentCompletions: (prefix) => {
			const options = [
				"--current",
				"--all",
				"--repo",
				"--public",
				"--private",
				"--format",
				"--format=sessions",
				"--format=sft-jsonl",
				"--format=chatml",
				"--output",
			];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const scope = await resolveExportScope(args, ctx);
			if (!scope) {
				showCommandResult(ctx, "Publish cancelled", true);
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			let result = await runPublicExport(args, currentSessionFile, scope);
			if (!result.success && scope === "current") {
				const fallback = await maybeFallbackToAllSessions(
					ctx,
					result.message,
					"Publish all sessions instead?",
				);
				if (fallback) {
					result = await runPublicExport(args, currentSessionFile, "all");
				}
			}

			showCommandResult(ctx, result.message, result.success);
		},
	});
}

/** Format and validate command arguments for `/dataset-export`. */
function parseExportArgs(raw: string):
	| {
			success: true;
			scope: ExportScope;
			scopeExplicit: boolean;
			formats: ReadonlyArray<ExportFormat>;
			outputDir?: string;
	  }
	| {
			success: false;
			message: string;
	  } {
	const tokens = tokenize(raw);
	const formats: ExportFormat[] = [];
	let scope: ExportScope = "current";
	let scopeExplicit = false;
	let outputDir: string | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--current") {
			scope = "current";
			scopeExplicit = true;
			continue;
		}

		if (token === "--all") {
			scope = "all";
			scopeExplicit = true;
			continue;
		}

		if (token.startsWith("--format=")) {
			const value = token.slice("--format=".length);
			if (!value) {
				return {
					success: false,
					message: "--format requires a value (sessions | sft-jsonl | chatml)",
				};
			}

			const parsed = parseFormats(value);
			if (!parsed.success) {
				return parsed;
			}
			formats.push(...parsed.formats);
			continue;
		}

		if (token === "--format") {
			const value = tokens[++index];
			if (!value) {
				return {
					success: false,
					message: "--format requires a value (sessions | sft-jsonl | chatml)",
				};
			}
			const parsed = parseFormats(value);
			if (!parsed.success) {
				return parsed;
			}
			formats.push(...parsed.formats);
			continue;
		}

		if (token === "--output") {
			const value = tokens[++index];
			if (!value) {
				return { success: false, message: "--output requires a directory path" };
			}
			outputDir = value;
			continue;
		}

		if (token.startsWith("--output=")) {
			const value = token.slice("--output=".length);
			if (!value) {
				return { success: false, message: "--output requires a directory path" };
			}
			outputDir = value;
			continue;
		}

		if (!token.startsWith("-") && token.trim()) {
			if (token !== "pi") {
				return {
					success: false,
					message: `Unknown source: ${token}. Supported source in this extension: pi`,
				};
			}
			continue;
		}

		if (token.startsWith("--")) {
			return { success: false, message: `Unknown flag: ${token}` };
		}

		return { success: false, message: `Unexpected token: ${token}` };
	}

	const resolvedFormats = formats.length > 0 ? formats : [...DEFAULT_EXPORT_FORMATS];
	return { success: true, scope, scopeExplicit, formats: resolvedFormats, outputDir };
}

function parsePublicExportArgs(
	raw: string,
	runtimeConfig: RuntimeConfig,
):
	| {
			success: true;
			scope: ExportScope;
			scopeExplicit: boolean;
			formats: ReadonlyArray<ExportFormat>;
			outputDir?: string;
			target: HuggingFaceUploadConfig;
	  }
	| {
			success: false;
			message: string;
	  } {
	const tokens = tokenize(raw);
	const formats: ExportFormat[] = [];
	let scope: ExportScope = "current";
	let scopeExplicit = false;
	let outputDir: string | undefined;
	let repo = runtimeConfig.huggingface.repo;
	let visibility: "private" | "public" = runtimeConfig.huggingface.visibility;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--current") {
			scope = "current";
			scopeExplicit = true;
			continue;
		}

		if (token === "--all") {
			scope = "all";
			scopeExplicit = true;
			continue;
		}

		if (token.startsWith("--format=")) {
			const value = token.slice("--format=".length);
			if (!value) {
				return {
					success: false,
					message: "--format requires a value (sessions | sft-jsonl | chatml)",
				};
			}

			const parsed = parseFormats(value);
			if (!parsed.success) {
				return parsed;
			}
			formats.push(...parsed.formats);
			continue;
		}

		if (token === "--format") {
			const value = tokens[++index];
			if (!value) {
				return {
					success: false,
					message: "--format requires a value (sessions | sft-jsonl | chatml)",
				};
			}

			const parsed = parseFormats(value);
			if (!parsed.success) {
				return parsed;
			}
			formats.push(...parsed.formats);
			continue;
		}

		if (token.startsWith("--output=")) {
			const value = token.slice("--output=".length);
			if (!value) {
				return { success: false, message: "--output requires a directory path" };
			}
			outputDir = value;
			continue;
		}

		if (token === "--output") {
			const value = tokens[++index];
			if (!value) {
				return { success: false, message: "--output requires a directory path" };
			}
			outputDir = value;
			continue;
		}

		if (token.startsWith("--repo=")) {
			repo = token.slice("--repo=".length);
			if (!repo) {
				return { success: false, message: "--repo requires a repository name (owner/name)" };
			}
			continue;
		}

		if (token === "--repo") {
			repo = tokens[++index];
			if (!repo) {
				return { success: false, message: "--repo requires a repository name (owner/name)" };
			}
			continue;
		}

		if (token === "--public") {
			visibility = "public";
			continue;
		}

		if (token === "--private") {
			visibility = "private";
			continue;
		}

		if (!token.startsWith("-") && token.trim()) {
			if (token !== "pi") {
				return {
					success: false,
					message: `Unknown source: ${token}. Supported source in this extension: pi`,
				};
			}
			continue;
		}

		return { success: false, message: `Unknown flag: ${token}` };
	}

	if (!repo) {
		return {
			success: false,
			message: `Missing Hugging Face repo. Use --repo owner/name or set one in ${PI_CONFIG_PATH}`,
		};
	}

	return {
		success: true,
		scope,
		scopeExplicit,
		formats: formats.length > 0 ? formats : [...DEFAULT_EXPORT_FORMATS],
		outputDir,
		target: {
			type: "huggingface",
			repo,
			visibility,
			token: runtimeConfig.huggingface.token,
		},
	};
}

async function runLocalExport(
	args: string,
	currentSessionFile?: string,
	scopeOverride?: ExportScope,
): Promise<
	{ success: true; outputDir: string; message: string } | { success: false; message: string }
> {
	const parsed = parseExportArgs(args);
	if (!parsed.success) {
		return parsed;
	}

	const runtimeConfig = resolveRuntimeConfig();
	const scope = scopeOverride ?? parsed.scope;
	const collected = await collectSanitizedPiSessions(runtimeConfig, scope, currentSessionFile);
	if (collected.sessions.length === 0) {
		return {
			success: false,
			message:
				scope === "current"
					? "Current session has no exportable messages"
					: `No exportable Pi sessions found${collected.skipped > 0 ? ` (${collected.skipped} skipped)` : ""}`,
		};
	}

	const anonymized = anonymize(collected.sessions, runtimeConfig.anonymize);
	const outputDir =
		parsed.outputDir ||
		runtimeConfig.export.outputDir ||
		join(".pi-private-data", "exports", nowTimestamp());

	const exportBundle = createBundle(anonymized.sessions, {
		...runtimeConfig.export,
		formats: parsed.formats,
	});

	await writeBundle(exportBundle, outputDir);

	return {
		success: true,
		outputDir,
		message: formatExportMessage(
			"Export complete",
			scope,
			anonymized.sessions,
			anonymized.stats.sessionsProcessed,
			collected.skipped,
			outputDir,
		),
	};
}

async function runPublicExport(
	args: string,
	currentSessionFile?: string,
	scopeOverride?: ExportScope,
): Promise<
	{ success: true; outputDir: string; message: string } | { success: false; message: string }
> {
	const runtimeConfig = resolveRuntimeConfig();
	const parsed = parsePublicExportArgs(args, runtimeConfig);
	if (!parsed.success) {
		return parsed;
	}

	const scope = scopeOverride ?? parsed.scope;
	const collected = await collectSanitizedPiSessions(runtimeConfig, scope, currentSessionFile);
	if (collected.sessions.length === 0) {
		return {
			success: false,
			message:
				scope === "current"
					? "Current session has no exportable messages"
					: `No exportable Pi sessions found${collected.skipped > 0 ? ` (${collected.skipped} skipped)` : ""}`,
		};
	}

	const anonymized = anonymize(collected.sessions, runtimeConfig.anonymize);
	const outputDir =
		parsed.outputDir ||
		runtimeConfig.export.outputDir ||
		join(".pi-private-data", "exports", nowTimestamp());

	const bundle = createBundle(anonymized.sessions, {
		...runtimeConfig.export,
		formats: parsed.formats,
	});

	await writeBundle(bundle, outputDir);
	const result = await upload(bundle, parsed.target);
	if (!result.success) {
		return {
			success: false,
			message: `Publish failed after export\n- Output: ${outputDir}\n- ${result.message}`,
		};
	}

	return {
		success: true,
		outputDir,
		message: `${formatExportMessage(
			"Publish complete",
			scope,
			anonymized.sessions,
			anonymized.stats.sessionsProcessed,
			collected.skipped,
			outputDir,
		)}\n- Repo: ${parsed.target.repo}\n- URL: ${result.url ?? `https://huggingface.co/datasets/${parsed.target.repo}`}`,
	};
}

async function collectSanitizedPiSessions(
	config: RuntimeConfig,
	scope: ExportScope,
	currentSessionFile?: string,
): Promise<{
	sessions: ReturnType<typeof anonymize>["sessions"];
	skipped: number;
}> {
	const refs =
		scope === "current"
			? currentSessionFile
				? [currentSessionFile]
				: []
			: await piPlugin.listSessions();
	const sessions = [];
	let skipped = 0;
	for (const ref of refs) {
		try {
			const raw = await piPlugin.loadSession(ref);
			const { session } = sanitize(raw, config.privacy);
			sessions.push(session);
		} catch {
			skipped++;
		}
	}
	return { sessions, skipped };
}

async function resolveExportScope(
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<ExportScope | undefined> {
	const parsed = parseScopeFlag(rawArgs);
	if (parsed) {
		return parsed;
	}

	if (!ctx.hasUI) {
		return "current";
	}

	const choice = await ctx.ui.select("Export scope", ["Current session", "All sessions"]);
	if (!choice) {
		return undefined;
	}

	return choice === "All sessions" ? "all" : "current";
}

async function resolveExportAlias(
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<{ mode: ExportMode; scope: ExportScope; args: string } | undefined> {
	const parsed = parseExportAliasArgs(rawArgs);
	const mode = parsed.mode ?? (await promptForExportMode(ctx));
	if (!mode) {
		return undefined;
	}

	const scope = (await resolveExportScope(parsed.args, ctx)) ?? parsed.scope;
	if (!scope) {
		return undefined;
	}

	return { mode, scope, args: parsed.args };
}

async function promptForExportMode(ctx: ExtensionCommandContext): Promise<ExportMode | undefined> {
	if (!ctx.hasUI) {
		return "local";
	}

	const choice = await ctx.ui.select("Export action", [
		"Export locally",
		"Publish to Hugging Face",
	]);
	if (!choice) {
		return undefined;
	}

	return choice === "Publish to Hugging Face" ? "public" : "local";
}

async function maybeFallbackToAllSessions(
	ctx: ExtensionCommandContext,
	message: string,
	prompt: string,
): Promise<boolean> {
	if (!ctx.hasUI || message !== "Current session has no exportable messages") {
		return false;
	}

	return ctx.ui.confirm("Current session is empty", prompt);
}

function parseScopeFlag(raw: string): ExportScope | undefined {
	for (const token of tokenize(raw)) {
		if (token === "--current") {
			return "current";
		}

		if (token === "--all") {
			return "all";
		}
	}

	return undefined;
}

function parseExportAliasArgs(raw: string): {
	mode?: ExportMode;
	scope?: ExportScope;
	args: string;
} {
	const tokens = tokenize(raw);
	if (tokens.length === 0) {
		return { args: raw };
	}

	const [first, ...rest] = tokens;
	if (first === "local" || first === "public") {
		return {
			mode: first,
			scope: parseScopeFlag(rest.join(" ")),
			args: rest.join(" "),
		};
	}

	const inferredMode = tokens.some(
		(token) =>
			token === "--public" ||
			token === "--private" ||
			token === "--repo" ||
			token.startsWith("--repo="),
	)
		? "public"
		: undefined;

	return {
		mode: inferredMode,
		scope: parseScopeFlag(raw),
		args: raw,
	};
}

type RuntimeConfig = ReturnType<typeof resolveConfig> & {
	huggingface: {
		repo?: string;
		visibility: "private" | "public";
		token?: string;
	};
};

function resolveRuntimeConfig(): RuntimeConfig {
	let fileConfig:
		| (PiBrainConfig & {
				huggingface?: { repo?: string; visibility?: "private" | "public"; token?: string };
		  })
		| null = null;

	try {
		fileConfig = JSON.parse(readFileSync(PI_CONFIG_PATH, "utf-8")) as PiBrainConfig & {
			huggingface?: { repo?: string; visibility?: "private" | "public"; token?: string };
		};
	} catch {
		fileConfig = null;
	}

	const baseConfig = resolveConfig(fileConfig ?? undefined);
	const envVisibility = process.env.PI_BRAIN_HF_VISIBILITY;
	const visibility =
		fileConfig?.huggingface?.visibility ||
		(envVisibility === "public" || envVisibility === "private" ? envVisibility : "private");

	return {
		...baseConfig,
		huggingface: {
			repo: fileConfig?.huggingface?.repo || process.env.PI_BRAIN_HF_REPO,
			visibility,
			token: fileConfig?.huggingface?.token || process.env.HF_TOKEN,
		},
	};
}

function formatExportMessage(
	title: string,
	scope: ExportScope,
	sessions: ReadonlyArray<{ messages: ReadonlyArray<unknown> }>,
	sessionCount: number,
	skippedCount: number,
	outputDir: string,
): string {
	const messageCount = sessions.reduce((total, session) => total + session.messages.length, 0);
	const lines = [
		title,
		`- Scope: ${scope === "current" ? "current session" : "all sessions"}`,
		`- Sessions: ${sessionCount}`,
		`- Messages: ${messageCount}`,
	];
	if (scope === "all" && skippedCount > 0) {
		lines.push(`- Skipped: ${skippedCount}`);
	}
	lines.push(`- Output: ${outputDir}`);
	return lines.join("\n");
}

/** Parse export format list from user input. */
function parseFormats(
	raw: string,
): { success: true; formats: ExportFormat[] } | { success: false; message: string } {
	const chunks = raw
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const formats: ExportFormat[] = [];

	for (const chunk of chunks) {
		if (!isSupportedFormat(chunk)) {
			return {
				success: false,
				message: `Unsupported format: ${chunk}. Valid values are: sessions, sft-jsonl, chatml`,
			};
		}
		formats.push(chunk);
	}

	if (formats.length === 0) {
		return { success: false, message: "No format values provided" };
	}

	return { success: true, formats };
}

function isSupportedFormat(value: string): value is ExportFormat {
	return DEFAULT_EXPORT_FORMATS.includes(value as ExportFormat);
}

function tokenize(raw: string): string[] {
	const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g);
	if (!matches) {
		return [];
	}

	return matches.map((token) => {
		if (
			(token.startsWith('"') && token.endsWith('"')) ||
			(token.startsWith("'") && token.endsWith("'"))
		) {
			return token.slice(1, -1);
		}
		return token;
	});
}

function nowTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function showCommandResult(ctx: ExtensionCommandContext, message: string, success: boolean): void {
	const level = success ? "info" : "error";
	if (ctx.hasUI) {
		ctx.ui.setStatus("pi-brain-export", success ? message.split("\n", 1)[0] : "Export failed");
		ctx.ui.setWidget("pi-brain-export", message.split("\n"), { placement: "aboveEditor" });
		ctx.ui.notify(message, level);
		return;
	}
	console.log(message);
}

/**
 * Convert Pi JSONL entries into a CanonicalSession.
 * Walks the entry tree from the leaf to the root to reconstruct
 * the active conversation branch.
 */
function piEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	if (entries.length === 0) {
		throw new Error(`Empty Pi session file: ${filePath}`);
	}

	// Parse entries into a map keyed by id
	const entryMap = new Map<string, any>();
	let header: any = null;

	for (const entry of entries) {
		const e = entry as Record<string, any>;
		if (e.type === "session") {
			header = e;
			continue;
		}
		if (e.id) {
			entryMap.set(e.id, e);
		}
	}

	// Find the leaf (last entry in the file — Pi always appends)
	let leaf: any = null;
	for (const entry of entries) {
		const e = entry as Record<string, any>;
		if (e.id) leaf = e;
	}

	// Walk from leaf to root to get the active branch
	const branch: any[] = [];
	let current = leaf;
	while (current) {
		branch.unshift(current);
		if (current.parentId) {
			current = entryMap.get(current.parentId);
		} else {
			break;
		}
	}

	// Convert message entries to CanonicalMessage
	const messages: CanonicalMessage[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const canonical = piMessageToCanonical(msg);
		if (canonical) messages.push(canonical);
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Pi session: ${filePath}`);
	}

	return {
		id: header?.id ?? sessionIdFromPath(filePath),
		source: "pi",
		messages,
		projectPath: header?.cwd,
		createdAt: header?.timestamp,
		metadata: { sessionFile: filePath },
	};
}

/** Convert a single Pi message to CanonicalMessage. */
function piMessageToCanonical(msg: any): CanonicalMessage | null {
	if (!msg || !msg.role) return null;

	switch (msg.role) {
		case "user": {
			const content =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: "";
			if (!content) return null;
			return {
				role: "user",
				content,
				timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : undefined,
			};
		}

		case "assistant": {
			const parts: string[] = [];
			if (Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c.type === "text") parts.push(c.text);
				}
			} else if (typeof msg.content === "string") {
				parts.push(msg.content);
			}
			const content = parts.join("\n");
			if (!content) return null;
			return {
				role: "assistant",
				content,
				timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : undefined,
				model: msg.model,
			};
		}

		case "toolResult": {
			const content = Array.isArray(msg.content)
				? msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n")
				: typeof msg.content === "string"
					? msg.content
					: "";
			return {
				role: "tool-result",
				content,
				timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : undefined,
				toolName: msg.toolName,
				toolCallId: msg.toolCallId,
			};
		}

		default:
			return null;
	}
}
