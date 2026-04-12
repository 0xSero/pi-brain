/**
 * @file plugins/qwen-code/index.ts
 *
 * Qwen Code source plugin — reads Qwen Code session JSONL files
 * from ~/.qwen/projects/*/chats/*.jsonl and converts them to
 * CanonicalSession format.
 *
 * Qwen Code sessions are JSONL files where each line is a typed entry:
 *   - type: "system" — system events (session start, tool results)
 *   - type: "user" — user messages
 *   - type: "assistant" — assistant responses
 *
 * Directory layout:
 *   ~/.qwen/projects/<project-slug>/chats/<uuid>.jsonl
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

const QWEN_DIR = join(home(), ".qwen", "projects");

export const qwenCodePlugin: SourcePlugin = {
	name: "qwen-code",

	async listSessions(): Promise<string[]> {
		if (!dirExists(QWEN_DIR)) return [];
		return findFiles(QWEN_DIR, (name) => name.endsWith(".jsonl"));
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const filePath = ref.startsWith("/") ? ref : findSessionFile(ref);
		const content = readFileSync(filePath, "utf-8");
		const entries = parseJsonlString(content);
		return qwenEntriesToCanonical(entries, filePath);
	},
};

/**
 * Find a Qwen Code session file by ID or relative path.
 */
function findSessionFile(ref: string): string {
	if (dirExists(QWEN_DIR)) {
		const allFiles = findFiles(QWEN_DIR, (name) => name.endsWith(".jsonl"));
		// Try matching by filename (without extension)
		const id = ref.replace(/\.jsonl$/, "");
		for (const file of allFiles) {
			if (file.includes(id)) return file;
		}
	}
	throw new Error(`Qwen Code session not found: ${ref}`);
}

/**
 * Convert Qwen Code JSONL entries into a CanonicalSession.
 */
function qwenEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	const messages: CanonicalMessage[] = [];
	let sessionId = sessionIdFromPath(filePath);
	let createdAt: string | undefined;
	let name: string | undefined;

	// Extract project name from path
	// Path format: ~/.qwen/projects/<project-slug>/chats/<uuid>.jsonl
	const pathParts = filePath.split(/[\\/]/);
	const chatsIdx = pathParts.indexOf("chats");
	const projectSlug = chatsIdx > 0 ? pathParts[chatsIdx - 1] : undefined;

	for (const entry of entries) {
		const e = entry as Record<string, any>;
		const type = e.type;

		if (type === "system" && e.subtype === "session_start") {
			sessionId = e.sessionId ?? sessionId;
			createdAt = e.timestamp;
			continue;
		}

		if (type === "user" || type === "assistant") {
			const msg = e.message;
			if (!msg?.parts) continue;

			// Extract text from parts array
			const textParts: string[] = [];
			for (const part of msg.parts) {
				if (typeof part === "object" && part.text) {
					let text = part.text;
					// Strip system reminders from text
					if (text.includes("<system-reminder>")) {
						const endIdx = text.lastIndexOf("</system-reminder>");
						if (endIdx > 0) {
							text = text.substring(endIdx + "</system-reminder>".length);
						}
					}
					text = text.trim();
					if (text) textParts.push(text);
				} else if (typeof part === "string" && part.trim()) {
					textParts.push(part.trim());
				}
			}

			const content = textParts.join("\n\n");
			if (!content) continue;

			// Use first user message as session name
			if (!name && type === "user") {
				name = content.substring(0, 120);
			}

			messages.push({
				role: type === "user" ? "user" : "assistant",
				content,
				timestamp: e.timestamp,
			});
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Qwen Code session: ${filePath}`);
	}

	return {
		id: sessionId,
		source: "qwen-code",
		messages,
		name,
		createdAt,
		projectPath: projectSlug ? projectSlug.replace(/-/g, "/").replace(/^\/+/, "") : undefined,
		metadata: {
			sessionFile: filePath,
			...(projectSlug ? { project: projectSlug } : {}),
		},
	};
}

export default qwenCodePlugin;
