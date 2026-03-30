/**
 * @file plugins/hermes/index.ts
 *
 * Hermes Agent source plugin — reads sessions from the SQLite database at
 * ~/.hermes/state.db.
 *
 * Schema (verified from live data):
 *   sessions → id, source, model, title, started_at, ended_at, ...
 *   messages → session_id, role, content, tool_call_id, tool_calls,
 *              tool_name, timestamp, finish_reason, ...
 *
 * Role mapping:
 *   - user      -> Canonical user
 *   - assistant -> Canonical assistant
 *   - tool      -> Canonical tool-result
 *   - system    -> skipped
 *
 * Tool messages store content as JSON in many cases, typically with an
 * `output` field. Assistant messages may also include `tool_calls` JSON; we use
 * that to recover the tool name for subsequent tool results.
 */

import { execFileSync } from "node:child_process";

import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { fileExists, home } from "../helpers.js";

interface HermesSessionRow {
	id: string;
	source: string | null;
	model: string | null;
	title: string | null;
	started_at: number | null;
	ended_at: number | null;
	message_count: number | null;
	tool_call_count: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	parent_session_id: string | null;
	user_id: string | null;
}

interface HermesMessageRow {
	id: number;
	session_id: string;
	role: string;
	content: string | null;
	tool_call_id: string | null;
	tool_calls: string | null;
	tool_name: string | null;
	timestamp: number;
	token_count: number | null;
	finish_reason: string | null;
}

interface HermesToolCall {
	id?: string;
	call_id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

function getDbPath(): string | undefined {
	const candidate = `${home()}/.hermes/state.db`;
	return fileExists(candidate) ? candidate : undefined;
}

function queryDb<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
	try {
		const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
			encoding: "utf-8",
			timeout: 15_000,
			maxBuffer: 50 * 1024 * 1024,
		});
		const trimmed = raw.trim();
		if (!trimmed) return [];
		return JSON.parse(trimmed) as T[];
	} catch {
		return [];
	}
}

export const hermesPlugin: SourcePlugin = {
	name: "hermes",

	async listSessions(): Promise<string[]> {
		const dbPath = getDbPath();
		if (!dbPath) return [];

		const rows = queryDb<{ id: string }>(
			dbPath,
			"SELECT id FROM sessions ORDER BY started_at DESC",
		);
		return rows.map((row) => row.id);
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const dbPath = getDbPath();
		if (!dbPath) {
			throw new Error("Hermes database not found");
		}
		return loadSessionFromDb(dbPath, ref);
	},
};

function loadSessionFromDb(dbPath: string, sessionId: string): CanonicalSession {
	const sessions = queryDb<HermesSessionRow>(
		dbPath,
		[
			"SELECT id, source, model, title, started_at, ended_at,",
			"message_count, tool_call_count, input_tokens, output_tokens,",
			"parent_session_id, user_id",
			"FROM sessions",
			`WHERE id = '${escapeSql(sessionId)}'`,
		].join(" "),
	);

	if (sessions.length === 0) {
		throw new Error(`Hermes session not found: ${sessionId}`);
	}

	const session = sessions[0];
	const rows = queryDb<HermesMessageRow>(
		dbPath,
		[
			"SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,",
			"timestamp, token_count, finish_reason",
			"FROM messages",
			`WHERE session_id = '${escapeSql(sessionId)}'`,
			"ORDER BY timestamp ASC, id ASC",
		].join(" "),
	);

	const toolNames = new Map<string, string>();
	for (const row of rows) {
		for (const call of parseToolCalls(row.tool_calls)) {
			const toolCallId = call.call_id ?? call.id;
			const toolName = call.function?.name;
			if (toolCallId && toolName) {
				toolNames.set(toolCallId, toolName);
			}
		}
	}

	const messages: CanonicalMessage[] = [];
	for (const row of rows) {
		const timestamp = toIsoTimestamp(row.timestamp);

		switch (row.role) {
			case "user": {
				if (row.content) {
					messages.push({ role: "user", content: row.content, timestamp });
				}
				break;
			}

			case "assistant": {
				const content = row.content?.trim();
				if (content) {
					messages.push({
						role: "assistant",
						content,
						timestamp,
						model: session.model ?? undefined,
					});
				}
				break;
			}

			case "tool": {
				const content = normalizeToolContent(row.content);
				if (content) {
					messages.push({
						role: "tool-result",
						content,
						timestamp,
						toolCallId: row.tool_call_id ?? undefined,
						toolName:
							row.tool_name ?? (row.tool_call_id ? toolNames.get(row.tool_call_id) : undefined),
					});
				}
				break;
			}

			default:
				break;
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Hermes session: ${sessionId}`);
	}

	const metadata: Record<string, unknown> = { dbPath, source: session.source ?? "cli" };
	if (session.parent_session_id) metadata.parentSessionId = session.parent_session_id;
	if (session.user_id) metadata.userId = session.user_id;
	if (session.message_count !== null) metadata.messageCount = session.message_count;
	if (session.tool_call_count !== null) metadata.toolCallCount = session.tool_call_count;
	if (session.input_tokens !== null) metadata.inputTokens = session.input_tokens;
	if (session.output_tokens !== null) metadata.outputTokens = session.output_tokens;

	return {
		id: session.id,
		source: "hermes",
		messages,
		name: session.title ?? undefined,
		createdAt: toIsoTimestamp(session.started_at),
		metadata,
	};
}

function parseToolCalls(raw: string | null): HermesToolCall[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as HermesToolCall[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function normalizeToolContent(raw: string | null): string {
	if (!raw) return "";
	try {
		const parsed = JSON.parse(raw) as { output?: unknown; content?: unknown };
		if (typeof parsed.output === "string") return parsed.output;
		if (typeof parsed.content === "string") return parsed.content;
		return JSON.stringify(parsed);
	} catch {
		return raw;
	}
}

function toIsoTimestamp(value: number | null | undefined): string | undefined {
	if (value === null || value === undefined) return undefined;
	const millis = value > 1_000_000_000_000 ? value : value * 1000;
	return new Date(millis).toISOString();
}

function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}

export default hermesPlugin;
