/**
 * @file plugins/opencode/index.ts
 *
 * OpenCode source plugin — reads sessions from the SQLite database at
 * ~/.local/share/opencode/opencode.db
 *
 * Schema (Drizzle ORM):
 *   session  → id, project_id, title, directory, time_created, ...
 *   message  → id, session_id, time_created, data (JSON: {role, modelID, ...})
 *   part     → id, message_id, session_id, time_created, data (JSON: {type, text?, tool?, ...})
 *
 * Part types: text, reasoning, tool, step-start, step-finish, patch, file, compaction, agent, subtask
 *
 * We shell out to the `sqlite3` CLI (available on macOS/Linux) instead of
 * requiring a native SQLite binding.
 */

import { execFileSync } from "node:child_process";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { fileExists, home } from "../helpers.js";

/** Path to the OpenCode SQLite database. */
function getDbPath(): string | undefined {
	const candidate = `${home()}/.local/share/opencode/opencode.db`;
	return fileExists(candidate) ? candidate : undefined;
}

/**
 * Run a sqlite3 query and return parsed JSON rows.
 * Uses `-json` output mode so each row is a JSON object.
 */
function queryDb<T = Record<string, unknown>>(dbPath: string, sql: string): T[] {
	try {
		const raw = execFileSync("sqlite3", ["-json", dbPath, sql], {
			encoding: "utf-8",
			timeout: 15_000,
			maxBuffer: 50 * 1024 * 1024, // 50 MB — sessions can be large
		});
		const trimmed = raw.trim();
		if (!trimmed) return [];
		return JSON.parse(trimmed) as T[];
	} catch {
		return [];
	}
}

interface SessionRow {
	id: string;
	title: string;
	directory: string;
	time_created: number;
}

interface MessageRow {
	id: string;
	session_id: string;
	time_created: number;
	data: string; // JSON
}

interface PartRow {
	id: string;
	message_id: string;
	time_created: number;
	data: string; // JSON
}

interface MessageData {
	role: "user" | "assistant";
	modelID?: string;
	providerID?: string;
	time?: { created?: number; completed?: number };
	error?: { name?: string; data?: { message?: string } };
	cost?: number;
	tokens?: { input?: number; output?: number; reasoning?: number };
}

interface PartData {
	type: string;
	text?: string;
	tool?: string;
	callID?: string;
	state?: {
		status?: string;
		input?: Record<string, unknown>;
		output?: string;
		title?: string;
	};
	reason?: string;
}

export const opencodePlugin: SourcePlugin = {
	name: "opencode",

	async listSessions(): Promise<string[]> {
		const dbPath = getDbPath();
		if (!dbPath) return [];

		const rows = queryDb<{ id: string }>(
			dbPath,
			"SELECT id FROM session ORDER BY time_created DESC",
		);
		return rows.map((r) => r.id);
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const dbPath = getDbPath();
		if (!dbPath) {
			throw new Error("OpenCode database not found");
		}
		return loadSessionFromDb(dbPath, ref);
	},
};

function loadSessionFromDb(dbPath: string, sessionId: string): CanonicalSession {
	// Fetch session metadata
	const sessions = queryDb<SessionRow>(
		dbPath,
		`SELECT id, title, directory, time_created FROM session WHERE id = '${escapeSql(sessionId)}'`,
	);
	if (sessions.length === 0) {
		throw new Error(`OpenCode session not found: ${sessionId}`);
	}
	const session = sessions[0];

	// Fetch messages ordered by creation time
	const messages = queryDb<MessageRow>(
		dbPath,
		`SELECT id, session_id, time_created, data FROM message WHERE session_id = '${escapeSql(sessionId)}' ORDER BY time_created ASC`,
	);

	// Fetch all parts for this session, ordered by message + creation time
	const parts = queryDb<PartRow>(
		dbPath,
		`SELECT id, message_id, time_created, data FROM part WHERE session_id = '${escapeSql(sessionId)}' ORDER BY message_id, time_created ASC`,
	);

	// Index parts by message_id
	const partsByMessage = new Map<string, PartRow[]>();
	for (const part of parts) {
		const list = partsByMessage.get(part.message_id);
		if (list) {
			list.push(part);
		} else {
			partsByMessage.set(part.message_id, [part]);
		}
	}

	// Convert to canonical messages
	const canonical: CanonicalMessage[] = [];

	for (const msg of messages) {
		const msgData = safeParse<MessageData>(msg.data);
		if (!msgData) continue;

		const role = msgData.role === "user" ? "user" : "assistant";
		const msgParts = partsByMessage.get(msg.id) ?? [];

		// Collect text content and tool results from parts
		const textParts: string[] = [];
		const toolResults: CanonicalMessage[] = [];

		for (const part of msgParts) {
			const pd = safeParse<PartData>(part.data);
			if (!pd) continue;

			switch (pd.type) {
				case "text":
					if (pd.text) textParts.push(pd.text);
					break;

				case "reasoning":
					// Include reasoning as part of assistant content
					if (pd.text) textParts.push(pd.text);
					break;

				case "tool": {
					// Emit tool-result message for completed tool calls
					const toolOutput = pd.state?.output ?? "";
					if (pd.tool && toolOutput) {
						toolResults.push({
							role: "tool-result",
							content: toolOutput,
							toolName: pd.tool,
							toolCallId: pd.callID,
							timestamp: new Date(part.time_created).toISOString(),
						});
					}
					break;
				}

				// step-start, step-finish, patch, file, compaction, agent, subtask
				// are structural markers — skip for canonical text extraction
			}
		}

		const content = textParts.join("\n");
		const timestamp = new Date(msg.time_created).toISOString();
		const model = msgData.modelID;

		// Only emit if there's actual content
		if (content) {
			canonical.push({ role, content, timestamp, model });
		}

		// Append tool-result messages after their parent assistant message
		for (const tr of toolResults) {
			canonical.push(tr);
		}
	}

	if (canonical.length === 0) {
		throw new Error(`No messages found in OpenCode session: ${sessionId}`);
	}

	return {
		id: sessionId,
		source: "opencode",
		messages: canonical,
		projectPath: session.directory || undefined,
		name: session.title || undefined,
		createdAt: new Date(session.time_created).toISOString(),
		metadata: { dbPath },
	};
}

/** Escape a string for safe inclusion in a SQL literal. */
function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}

/** Safely parse a JSON string, returning undefined on failure. */
function safeParse<T>(json: string): T | undefined {
	try {
		return JSON.parse(json) as T;
	} catch {
		return undefined;
	}
}

export default opencodePlugin;
