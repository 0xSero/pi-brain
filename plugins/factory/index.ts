/**
 * @file plugins/factory/index.ts
 *
 * Factory (Droid) source plugin — reads Factory coding agent JSONL sessions
 * from ~/.factory/sessions/ and converts them to CanonicalSession format.
 *
 * Factory sessions are JSONL files where each line is a typed entry:
 *   - session_start: session metadata (id, title, cwd, owner, etc.)
 *   - message: a conversation message with id/parentId tree structure
 *   - todo_state: todo list snapshots (skipped during conversion)
 *   - compaction_state: conversation compaction markers (skipped)
 *
 * Messages use id/parentId to form a tree. We walk from the leaf to the
 * root to extract the active conversation branch, identical to Pi's approach.
 *
 * Directory layout:
 *   ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl
 *   ~/.factory/sessions/<cwd-slug>/<uuid>.settings.json
 *   ~/.factory/sessions-index.json
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import {
	dirExists,
	fileExists,
	findFiles,
	home,
	parseJsonlString,
	sessionIdFromPath,
} from "../helpers.js";

const SESSION_DIR = join(home(), ".factory", "sessions");

export const factoryPlugin: SourcePlugin = {
	name: "factory",

	async listSessions(): Promise<string[]> {
		if (!dirExists(SESSION_DIR)) return [];
		return findFiles(SESSION_DIR, (name) => name.endsWith(".jsonl"));
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		// Accept absolute paths, relative paths from SESSION_DIR, or session IDs from the index
		let filePath: string;
		if (ref.startsWith("/")) {
			filePath = ref;
		} else if (ref.endsWith(".jsonl")) {
			filePath = join(SESSION_DIR, ref);
		} else {
			// Treat as a session ID — look it up via the index or scan directories
			filePath = resolveSessionId(ref);
		}

		const content = readFileSync(filePath, "utf-8");
		const entries = parseJsonlString(content);

		return factoryEntriesToCanonical(entries, filePath);
	},
};

/**
 * Resolve a bare session ID (UUID) to its JSONL file path.
 * First checks the sessions-index.json for a quick lookup, then falls
 * back to scanning the sessions directory.
 */
function resolveSessionId(sessionId: string): string {
	// Try scanning the directory tree for a matching file
	if (dirExists(SESSION_DIR)) {
		const allFiles = findFiles(SESSION_DIR, (name) => name === `${sessionId}.jsonl`);
		if (allFiles.length > 0) return allFiles[0];
	}

	throw new Error(`Factory session not found: ${sessionId}`);
}

/**
 * Convert Factory JSONL entries into a CanonicalSession.
 * Walks the entry tree from the leaf to the root to reconstruct
 * the active conversation branch.
 */
function factoryEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	if (entries.length === 0) {
		throw new Error(`Empty Factory session file: ${filePath}`);
	}

	const entryMap = new Map<string, any>();
	let header: any = null;

	for (const entry of entries) {
		const e = entry as Record<string, any>;
		if (e.type === "session_start") {
			header = e;
			continue;
		}
		// Only index message entries (skip todo_state, compaction_state)
		if (e.type === "message" && e.id) {
			entryMap.set(e.id, e);
		}
	}

	// Find the leaf (last message entry in the file — Factory always appends)
	let leaf: any = null;
	for (const entry of entries) {
		const e = entry as Record<string, any>;
		if (e.type === "message" && e.id) leaf = e;
	}

	if (!leaf) {
		throw new Error(`No messages found in Factory session: ${filePath}`);
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
		const converted = factoryMessageToCanonical(entry);
		messages.push(...converted);
	}

	if (messages.length === 0) {
		throw new Error(`No convertible messages in Factory session: ${filePath}`);
	}

	// Load settings file for model info if available
	const settingsPath = filePath.replace(/\.jsonl$/, ".settings.json");
	let model: string | undefined;
	if (fileExists(settingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			model = settings.model;
		} catch {
			// Skip if settings can't be parsed
		}
	}

	return {
		id: header?.id ?? sessionIdFromPath(filePath),
		source: "factory",
		messages,
		projectPath: header?.cwd,
		name: header?.sessionTitle ?? header?.title,
		createdAt: header?.timestamp ?? (entries[0] as Record<string, any>)?.timestamp,
		metadata: {
			sessionFile: filePath,
			...(model ? { model } : {}),
			...(header?.owner ? { owner: header.owner } : {}),
		},
	};
}

/**
 * Convert a single Factory message entry to one or more CanonicalMessages.
 *
 * Factory embeds tool results as content blocks inside user messages rather
 * than as separate messages. We split them out into separate CanonicalMessages
 * so downstream consumers see a clean user/tool-result/assistant flow.
 */
function factoryMessageToCanonical(entry: any): CanonicalMessage[] {
	const msg = entry.message;
	if (!msg || !msg.role) return [];
	const timestamp = entry.timestamp ? new Date(entry.timestamp).toISOString() : undefined;

	switch (msg.role) {
		case "user":
			return convertUserMessage(msg, timestamp);
		case "assistant":
			return convertAssistantMessage(msg, timestamp);
		default:
			return [];
	}
}

/**
 * Convert a user message, splitting out any tool_result content blocks
 * into separate CanonicalMessages.
 */
function convertUserMessage(msg: any, timestamp?: string): CanonicalMessage[] {
	const results: CanonicalMessage[] = [];

	if (typeof msg.content === "string") {
		if (msg.content) {
			results.push({ role: "user", content: msg.content, timestamp });
		}
		return results;
	}

	if (!Array.isArray(msg.content)) return results;

	// Separate text blocks from tool_result blocks
	const textParts: string[] = [];
	const toolResults: CanonicalMessage[] = [];

	for (const block of msg.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "tool_result") {
			const content =
				typeof block.content === "string"
					? block.content
					: Array.isArray(block.content)
						? block.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: JSON.stringify(block.content ?? "");
			toolResults.push({
				role: "tool-result",
				content,
				timestamp,
				toolCallId: block.tool_use_id,
			});
		}
	}

	// Emit tool results first (they respond to the previous assistant turn)
	results.push(...toolResults);

	// Then emit the user text, if any
	const userText = textParts.join("\n");
	if (userText) {
		results.push({ role: "user", content: userText, timestamp });
	}

	return results;
}

/**
 * Convert an assistant message, extracting text from content blocks.
 */
function convertAssistantMessage(msg: any, timestamp?: string): CanonicalMessage[] {
	const parts: string[] = [];

	if (typeof msg.content === "string") {
		if (msg.content) parts.push(msg.content);
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block.type === "text") {
				parts.push(block.text);
			}
			// tool_use blocks are metadata; we don't include them in content text
		}
	}

	const content = parts.join("\n");
	if (!content) return [];

	return [
		{
			role: "assistant",
			content,
			timestamp,
			model: msg.model,
		},
	];
}

export default factoryPlugin;
