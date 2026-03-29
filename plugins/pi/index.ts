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
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { dirExists, findFiles, home, parseJsonlString, sessionIdFromPath } from "../helpers.js";

const SESSION_DIR = join(home(), ".pi", "agent", "sessions");

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

export default piPlugin;
