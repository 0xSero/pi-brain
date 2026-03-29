/**
 * @file plugins/helpers.ts
 *
 * Shared utilities for source plugins: platform detection,
 * path resolution, JSONL parsing, and SQLite helpers.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

/** Detected operating system. */
export type OSPlatform = "macos" | "linux" | "windows";

/** Get the current OS platform. */
export function getOS(): OSPlatform {
	switch (platform()) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "linux";
	}
}

/** Get the user's home directory. */
export function home(): string {
	return homedir();
}

/** Check if a directory exists. */
export function dirExists(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Check if a file exists. */
export function fileExists(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve candidate directories, returning only those that exist.
 * Each candidate is an array of path segments joined with the home dir.
 */
export function findExistingDirs(candidates: string[]): string[] {
	return candidates.filter(dirExists);
}

/**
 * Recursively find files matching a pattern in a directory.
 * Returns absolute paths.
 */
export function findFiles(dir: string, match: (name: string) => boolean): string[] {
	const results: string[] = [];
	if (!dirExists(dir)) return results;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...findFiles(fullPath, match));
			} else if (entry.isFile() && match(entry.name)) {
				results.push(fullPath);
			}
		}
	} catch {
		// Permission denied or similar — skip
	}

	return results;
}

/**
 * Parse a JSONL file, yielding one parsed object per non-empty line.
 * Silently skips malformed lines.
 */
export function parseJsonlFile(filePath: string): unknown[] {
	if (!fileExists(filePath)) return [];

	const content = readFileSync(filePath, "utf-8");
	return parseJsonlString(content);
}

/** Parse a JSONL string into an array of objects. */
export function parseJsonlString(content: string): unknown[] {
	const results: unknown[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			results.push(JSON.parse(trimmed));
		} catch {
			// Skip malformed lines
		}
	}
	return results;
}

/**
 * Generate a stable session ID from a file path.
 * Uses the last two path components (parent dir + filename without extension).
 */
export function sessionIdFromPath(filePath: string): string {
	const parts = resolve(filePath).split("/");
	const fileName = parts.pop()?.replace(/\.[^.]+$/, "") ?? "unknown";
	const parent = parts.pop() ?? "unknown";
	return `${parent}/${fileName}`;
}

/**
 * Build platform-specific storage directories for a tool.
 * Returns candidate paths to check for session data.
 */
export function storageCandidates(toolDirs: {
	macos?: string[];
	linux?: string[];
	windows?: string[];
	common?: string[];
}): string[] {
	const os = getOS();
	const h = home();
	const candidates: string[] = [];

	const platformDirs =
		os === "macos" ? toolDirs.macos : os === "windows" ? toolDirs.windows : toolDirs.linux;

	if (platformDirs) {
		for (const dir of platformDirs) {
			candidates.push(
				dir.startsWith("/") || dir.startsWith("~") ? dir.replace("~", h) : join(h, dir),
			);
		}
	}

	if (toolDirs.common) {
		for (const dir of toolDirs.common) {
			candidates.push(
				dir.startsWith("/") || dir.startsWith("~") ? dir.replace("~", h) : join(h, dir),
			);
		}
	}

	return candidates;
}
