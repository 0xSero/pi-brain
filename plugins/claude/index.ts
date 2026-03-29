/**
 * @file plugins/claude/index.ts
 *
 * Claude Code source plugin — reads JSONL sessions from
 * ~/.claude/projects/<project>/<session>.jsonl
 *
 * Storage format: each line is a JSON event with a "type" field.
 * Messages use types "user", "assistant", "tool_result".
 * Content blocks use the same structure as Anthropic's API.
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

function getClaudeDirs(): string[] {
	const h = home();
	return findExistingDirs([
		join(h, ".claude"),
		join(h, ".claude-code"),
		join(h, ".claude-local"),
		join(h, ".claude-m2"),
		join(h, ".claude-zai"),
	]);
}

export const claudePlugin: SourcePlugin = {
	name: "claude",

	async listSessions(): Promise<string[]> {
		const dirs = getClaudeDirs();
		const files: string[] = [];
		for (const dir of dirs) {
			const projectsDir = join(dir, "projects");
			files.push(
				...findFiles(projectsDir, (name) => name.endsWith(".jsonl") && !name.startsWith("agent-")),
			);
			// Also check direct JSONL files
			files.push(
				...findFiles(dir, (name) => name.endsWith(".jsonl") && !name.startsWith("agent-")),
			);
		}
		return files;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const content = readFileSync(ref, "utf-8");
		const entries = parseJsonlString(content);
		return claudeEntriesToCanonical(entries, ref);
	},
};

function claudeEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
	const messages: CanonicalMessage[] = [];
	let projectPath: string | undefined;

	for (const entry of entries) {
		const e = entry as Record<string, any>;
		const type = e.type;

		if (type === "user") {
			const msg = e.message ?? e;
			const content =
				typeof msg.content === "string"
					? msg.content
					: typeof msg.message?.content === "string"
						? msg.message.content
						: "";
			if (content) {
				messages.push({
					role: "user",
					content,
					timestamp: e.timestamp,
				});
			}
			if (e.cwd) projectPath = e.cwd;
		} else if (type === "assistant") {
			const msg = e.message ?? e;
			const parts: string[] = [];
			const contentArr = msg.content ?? msg.message?.content;
			if (Array.isArray(contentArr)) {
				for (const c of contentArr) {
					if (c.type === "text") parts.push(c.text);
				}
			} else if (typeof contentArr === "string") {
				parts.push(contentArr);
			}
			const content = parts.join("\n");
			if (content) {
				messages.push({
					role: "assistant",
					content,
					timestamp: e.timestamp,
					model: msg.model ?? msg.message?.model,
				});
			}
		} else if (type === "tool_result") {
			const result = e.toolResult ?? e;
			const content =
				typeof result.content === "string"
					? result.content
					: Array.isArray(result.content)
						? result.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n")
						: "";
			messages.push({
				role: "tool-result",
				content,
				timestamp: e.timestamp,
				toolName: result.toolName,
				toolCallId: result.toolCallId,
			});
		}
	}

	if (messages.length === 0) {
		throw new Error(`No messages found in Claude session: ${filePath}`);
	}

	return {
		id: sessionIdFromPath(filePath),
		source: "claude",
		messages,
		projectPath,
		metadata: { sessionFile: filePath },
	};
}

export default claudePlugin;
