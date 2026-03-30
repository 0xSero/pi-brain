/**
 * @file plugins/claude/index.ts
 *
 * Claude Code source plugin — reads JSONL sessions from
 * ~/.claude/projects/<project>/<session>.jsonl
 *
 * Real storage format (verified from live data):
 *   - Sessions live in ~/.claude/projects/
 *   - Each project dir is named with the path where dashes replace slashes,
 *     e.g. "-Users-sero-ai-pi-brain"
 *   - Inside each project dir are JSONL files named by UUID
 *   - Each line is a JSON envelope with fields:
 *       parentUuid, isSidechain, userType, cwd, sessionId,
 *       version, type, timestamp, uuid, ...
 *   - Entry types: "user", "assistant", "system", "progress",
 *       "file-history-snapshot", "queue-operation", "last-prompt"
 *   - "user" type: message.content is a string
 *   - "assistant" type: message.content is an array of blocks:
 *       {type:"text", text:...}, {type:"thinking", ...}, {type:"tool_use", ...}
 *   - "system" type: hook summaries and context (skip for messages)
 *   - "progress", "file-history-snapshot", "queue-operation", "last-prompt": skip
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

/** Entry types that carry actual conversation messages. */
const MESSAGE_TYPES = new Set(["user", "assistant"]);

/** Entry types to skip entirely — not conversation messages. */
const SKIP_TYPES = new Set([
	"progress",
	"file-history-snapshot",
	"queue-operation",
	"last-prompt",
	"system",
]);

function getClaudeProjectsDirs(): string[] {
	const h = home();
	return findExistingDirs([
		join(h, ".claude", "projects"),
		join(h, ".claude-code", "projects"),
		join(h, ".claude-local", "projects"),
	]);
}

export const claudePlugin: SourcePlugin = {
	name: "claude",

	async listSessions(): Promise<string[]> {
		const projectsDirs = getClaudeProjectsDirs();
		const files: string[] = [];
		for (const projectsDir of projectsDirs) {
			files.push(...findFiles(projectsDir, (name) => name.endsWith(".jsonl")));
		}
		return files;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const content = readFileSync(ref, "utf-8");
		const entries = parseJsonlString(content);
		return claudeEntriesToCanonical(entries, ref);
	},
};

/** Envelope shape for every line in a Claude JSONL session file. */
interface ClaudeEntry {
	parentUuid?: string | null;
	isSidechain?: boolean;
	userType?: string;
	cwd?: string;
	sessionId?: string;
	version?: string;
	type?: string;
	message?: {
		role?: string;
		model?: string;
		content?: string | ContentBlock[];
	};
	timestamp?: string;
	uuid?: string;
}

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	signature?: string;
}

function claudeEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	const messages: CanonicalMessage[] = [];
	let projectPath: string | undefined;
	let sessionId: string | undefined;

	for (const entry of entries) {
		const e = entry as ClaudeEntry;
		const type = e.type;

		// Extract cwd and sessionId from any entry that has them
		if (e.cwd && !projectPath) projectPath = e.cwd;
		if (e.sessionId && !sessionId) sessionId = e.sessionId;

		// Skip non-message types
		if (!type || SKIP_TYPES.has(type)) continue;
		if (!MESSAGE_TYPES.has(type)) continue;

		if (type === "user") {
			const msg = e.message;
			if (!msg) continue;
			const content = typeof msg.content === "string" ? msg.content : "";
			if (content) {
				messages.push({
					role: "user",
					content,
					timestamp: e.timestamp,
				});
			}
		} else if (type === "assistant") {
			const msg = e.message;
			if (!msg) continue;

			const textParts: string[] = [];
			const contentArr = msg.content;

			if (Array.isArray(contentArr)) {
				for (const block of contentArr) {
					if (block.type === "text" && block.text) {
						textParts.push(block.text);
					}
					// Skip "thinking" and "tool_use" blocks for the text content.
					// tool_use blocks represent tool calls, not displayable text.
				}
			} else if (typeof contentArr === "string") {
				textParts.push(contentArr);
			}

			const content = textParts.join("\n");
			if (content) {
				messages.push({
					role: "assistant",
					content,
					timestamp: e.timestamp,
					model: msg.model,
				});
			}
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Claude session: ${filePath}`);
	}

	return {
		id: sessionId ?? sessionIdFromPath(filePath),
		source: "claude",
		messages,
		projectPath,
		metadata: { sessionFile: filePath },
	};
}

export default claudePlugin;
