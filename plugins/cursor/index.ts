/**
 * @file plugins/cursor/index.ts
 *
 * Cursor source plugin — reads SQLite databases (state.vscdb) from
 * ~/Library/Application Support/Cursor/User/workspaceStorage/
 * and ~/Library/Application Support/Cursor/User/globalStorage/
 *
 * NOTE: SQLite reading requires optional better-sqlite3 or similar.
 * In v1, this plugin reads pre-exported JSONL files that were extracted
 * using the ai-data-extraction toolkit. Direct SQLite support planned for v2.
 *
 * For now, it can also read cursor_complete_*.jsonl files from extracted_data/.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import {
	findExistingDirs,
	findFiles,
	home,
	parseJsonlString,
	sessionIdFromPath,
} from "../helpers.js";

function getCursorExtractedDirs(): string[] {
	const h = home();
	// Look for extracted JSONL files from ai-data-extraction
	return findExistingDirs([
		join(h, "extracted_data"),
		join(h, "ai-data-extraction", "extracted_data"),
	]);
}

export const cursorPlugin: SourcePlugin = {
	name: "cursor",

	async listSessions(): Promise<string[]> {
		const dirs = getCursorExtractedDirs();
		const files: string[] = [];
		for (const dir of dirs) {
			files.push(
				...findFiles(dir, (name) => name.startsWith("cursor_") && name.endsWith(".jsonl")),
			);
		}
		return files;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const content = readFileSync(ref, "utf-8");
		const entries = parseJsonlString(content);

		// Each line in a cursor JSONL is a full conversation object
		if (entries.length === 0) {
			throw new Error(`Empty Cursor export file: ${ref}`);
		}

		// If there's exactly one entry, treat it as a single session
		// If multiple, combine them all
		const allMessages: CanonicalMessage[] = [];
		for (const entry of entries) {
			const e = entry as Record<string, any>;
			if (Array.isArray(e.messages)) {
				for (const msg of e.messages) {
					const role =
						msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "tool-result";
					if (msg.content) {
						allMessages.push({
							role: role as CanonicalMessage["role"],
							content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
							timestamp: msg.timestamp,
							model: msg.model,
						});
					}
				}
			}
		}

		if (allMessages.length === 0) {
			throw new Error(`No messages found in Cursor export: ${ref}`);
		}

		const first = entries[0] as Record<string, any>;
		return {
			id: first.composer_id ?? first.session_id ?? sessionIdFromPath(ref),
			source: "cursor",
			messages: allMessages,
			projectPath: first.workspace_id,
			name: first.name ?? first.chat_title,
			metadata: { sessionFile: ref, source: first.source },
		};
	},
};

export default cursorPlugin;
