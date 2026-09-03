/**
 * @file plugins/gemini-takeout/index.ts
 *
 * Google Gemini Takeout source plugin — parses My Activity HTML files
 * from Google Takeout archives and converts Gemini conversations to
 * CanonicalSession format.
 *
 * Google Takeout structure (after extracting the ZIP):
 *   Takeout/Gemini/MyActivity.html — English exports
 *   Takeout/Gemini/MiActividad.html — Spanish exports
 *   Takeout/Gemini/AI Mode/ or Modo IA/ — AI Mode queries
 *
 * Each conversation in the HTML follows this pattern:
 *   - User prompt text
 *   - Date: "DD Mon YYYY, HH:MM:SS TZ"
 *   - Assistant response (in <p> tags)
 *
 * Note: This plugin parses the HTML structure directly from the
 * Takeout ZIP files placed in the exports directory.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import { findExistingDirs, findFiles, home, sessionIdFromPath } from "../helpers.js";

const ACTIVITY_FILENAMES = new Set(["miactividad.html", "myactivity.html"]);

/** True for Gemini Takeout activity HTML (locale-neutral). */
export function isGeminiActivityFile(name: string): boolean {
	const lower = name.toLowerCase();
	return ACTIVITY_FILENAMES.has(lower) || lower.endsWith("-gemini.html");
}

/**
 * Bounded roots only — never recurse all of ~/Downloads.
 * Override with PI_BRAIN_TAKEOUT_DIR.
 */
export function geminiTakeoutSearchRoots(): string[] {
	const extra = process.env.PI_BRAIN_TAKEOUT_DIR;
	return findExistingDirs(
		[join(home(), "Takeout"), join(home(), "Downloads", "Takeout"), extra].filter(
			(value): value is string => Boolean(value),
		),
	);
}

export const geminiTakeoutPlugin: SourcePlugin = {
	name: "gemini-takeout",

	async listSessions(): Promise<string[]> {
		const files: string[] = [];
		for (const dir of geminiTakeoutSearchRoots()) {
			files.push(...findFiles(dir, isGeminiActivityFile));
		}
		return files;
	},

	async loadSession(ref: string): Promise<CanonicalSession> {
		const filePath = ref;
		const content = readFileSync(filePath, "utf-8");
		return parseGeminiHtml(content, filePath);
	},
};

/**
 * Parse a Gemini Takeout HTML file into CanonicalSession(s).
 * Each conversation in the file becomes a separate session.
 *
 * The HTML structure uses mdl-grid/mdl-cell classes with conversation
 * entries separated by outer-cell divs.
 */
function parseGeminiHtml(html: string, filePath: string): CanonicalSession {
	const conversations: CanonicalMessage[] = [];
	let name: string | undefined;
	let createdAt: string | undefined;

	// Split by conversation entry markers
	// Each entry starts with "outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"
	const entryRegex = /outer-cell\s+mdl-cell\s+mdl-cell--12-col\s+mdl-shadow--2dp[^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>\s*<\/div>|outer-cell\s+mdl-cell|$)/g;

	let match;
	while ((match = entryRegex.exec(html)) !== null) {
		const entryHtml = match[1];
		const parsed = parseConversationEntry(entryHtml);
		if (parsed) {
			conversations.push(...parsed.messages);
			if (!name && parsed.name) name = parsed.name;
			if (!createdAt && parsed.createdAt) createdAt = parsed.createdAt;
		}
	}

	if (conversations.length === 0) {
		throw new Error(`No conversations found in Gemini Takeout file: ${filePath}`);
	}

	// Determine source type from path
	const lowerPath = filePath.toLowerCase();
	const isModoIA =
		lowerPath.includes("modo ia") ||
		lowerPath.includes("ai mode") ||
		lowerPath.includes("/ai_mode/") ||
		lowerPath.includes("\\ai_mode\\");
	const source = isModoIA ? "gemini-takeout-ai-mode" : "gemini-takeout";

	return {
		id: sessionIdFromPath(filePath),
		source,
		messages: conversations,
		name: name ?? "Gemini Takeout Session",
		createdAt,
		metadata: {
			sessionFile: filePath,
			totalMessages: conversations.length,
		},
	};
}

/**
 * Parse a single conversation entry from the HTML.
 */
function parseConversationEntry(html: string): {
	messages: CanonicalMessage[];
	name?: string;
	createdAt?: string;
} | null {
	// Extract date pattern: "10 abr 2026, 19:55:59 CEST"
	const dateMatch = html.match(/(\d{1,2}\s+\w{3,9}\s+\d{4},\s+\d{2}:\d{2}:\d{2}\s+\w+)/);
	const createdAt = dateMatch?.[1];

	// Extract the text content
	// The HTML structure has text in <p> tags with mdl-typography--body-1 class
	const textBlocks: string[] = [];
	const blockRegex = /class="[^"]*mdl-typography--body[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
	let blockMatch;
	while ((blockMatch = blockRegex.exec(html)) !== null) {
		let text = blockMatch[1];
		// Strip HTML tags
		text = text.replace(/<[^>]+>/g, " ");
		// Decode HTML entities
		text = text
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&nbsp;/g, " ");
		text = text.replace(/\s+/g, " ").trim();
		if (text.length > 20) {
			textBlocks.push(text);
		}
	}

	if (textBlocks.length === 0) return null;

	// Split text blocks into user/assistant messages
	// Typically: [user_prompt, ..., assistant_response, ...]
	const messages: CanonicalMessage[] = [];

	for (let i = 0; i < textBlocks.length; i++) {
		const block = textBlocks[i];
		// Alternate between user and assistant based on context
		// First block is usually the user prompt
		const isUser = i === 0 || block.length < 200;
		messages.push({
			role: isUser ? "user" : "assistant",
			content: block,
			timestamp: createdAt,
		});
	}

	if (messages.length === 0) return null;

	// Use first user message as name
	const name = messages.find((m) => m.role === "user")?.content?.substring(0, 120);

	return { messages, name, createdAt };
}

export default geminiTakeoutPlugin;
