#!/usr/bin/env node
/**
 * @file cli.ts
 *
 * Standalone CLI for pi-brain. Provides dataset-export, dataset-upload,
 * and dataset-config commands without requiring Pi to be installed.
 * When used as a Pi extension, these commands are also available as
 * /dataset-export, /dataset-upload, /dataset-config.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	type ExportArtifact,
	type ExportBundle,
	type ExportFormat,
	type SourcePlugin,
	type UploadConfig,
	anonymize,
	createBundle,
	resolveConfig,
	sanitize,
	upload,
	writeBundle,
} from "./core/index.js";

import { claudePlugin } from "./plugins/claude/index.js";
import { codexPlugin } from "./plugins/codex/index.js";
import { cursorPlugin } from "./plugins/cursor/index.js";
import { factoryPlugin } from "./plugins/factory/index.js";
import { geminiTakeoutPlugin } from "./plugins/gemini-takeout/index.js";
import { hermesPlugin } from "./plugins/hermes/index.js";
import { opencodePlugin } from "./plugins/opencode/index.js";
import { piPlugin } from "./plugins/pi/index.js";
import { qwenCodePlugin } from "./plugins/qwen-code/index.js";

/** All available source plugins. */
const PLUGINS: Record<string, SourcePlugin> = {
	pi: piPlugin,
	claude: claudePlugin,
	codex: codexPlugin,
	opencode: opencodePlugin,
	cursor: cursorPlugin,
	factory: factoryPlugin,
	hermes: hermesPlugin,
	"gemini-takeout": geminiTakeoutPlugin,
	"qwen-code": qwenCodePlugin,
};

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	switch (command) {
		case "export":
			await runExport(args.slice(1));
			break;
		case "upload":
			await runUpload(args.slice(1));
			break;
		case "list":
			await runList(args.slice(1));
			break;
		case "help":
		case "--help":
		case "-h":
			printHelp();
			break;
		default:
			console.error(`Unknown command: ${command ?? "(none)"}`);
			printHelp();
			process.exit(1);
	}
}

async function runExport(args: string[]): Promise<void> {
	const source = args[0] ?? "pi";
	const plugin = PLUGINS[source];
	if (!plugin) {
		console.error(`Unknown source: ${source}. Available: ${Object.keys(PLUGINS).join(", ")}`);
		process.exit(1);
	}

	console.log(`Listing sessions from ${source}...`);
	const refs = await plugin.listSessions();
	console.log(`Found ${refs.length} session(s)`);

	if (refs.length === 0) {
		console.log("Nothing to export.");
		return;
	}

	const config = resolveConfig();
	const sessions = [];
	let errors = 0;

	for (const ref of refs) {
		try {
			const session = await plugin.loadSession(ref);
			const { session: sanitized } = sanitize(session, config.privacy);
			sessions.push(sanitized);
		} catch (err) {
			errors++;
			console.error(`  Skipping ${ref}: ${err instanceof Error ? err.message : err}`);
		}
	}

	console.log(`Loaded ${sessions.length} session(s), ${errors} error(s)`);

	if (sessions.length === 0) {
		console.log("No sessions to export.");
		return;
	}

	const anonymized = anonymize(sessions, config.anonymize);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outputDir = config.export.outputDir || join(".pi-private-data", "exports", timestamp);

	const bundle = createBundle(anonymized.sessions, config.export);
	await writeBundle(bundle, outputDir);

	console.log(`Exported to ${outputDir}/`);
	console.log(`  Sessions: ${bundle.metadata.sessionCount}`);
	console.log(`  Messages: ${bundle.metadata.messageCount}`);
	console.log(`  Formats: ${bundle.metadata.formats.join(", ")}`);
	console.log(`  Anonymized IDs: ${anonymized.stats.idsAnonymized}`);
	console.log(`  Stripped paths: ${anonymized.stats.pathsStripped}`);
	console.log(`  Fuzzed timestamps: ${anonymized.stats.timestampsFuzzed}`);
	console.log(`  Stripped strings: ${anonymized.stats.stringsStripped}`);
	console.log(`  Hash: ${bundle.manifestHash.slice(0, 16)}...`);

	if (config.upload) {
		const result = await upload(bundle, config.upload);
		console.log(`Upload: ${result.success ? "success" : "failed"} - ${result.message}`);
		if (result.url) {
			console.log(`  URL: ${result.url}`);
		}
		if (!result.success) {
			process.exit(1);
		}
	}
}

async function runUpload(args: string[]): Promise<void> {
	const bundleDir = args[0];
	if (!bundleDir) {
		console.error(
			"Usage: pi-brain upload <bundle-dir> --target huggingface --repo user/name [--public]",
		);
		console.error("   or: pi-brain upload <bundle-dir> --target http --url https://...");
		process.exit(1);
	}

	const config = parseUploadArgs(args.slice(1));
	const bundle = await readBundle(bundleDir);
	const result = await upload(bundle, config);

	console.log(`Upload: ${result.success ? "success" : "failed"} - ${result.message}`);
	if (result.url) {
		console.log(`URL: ${result.url}`);
	}
	if (!result.success) {
		process.exit(1);
	}
}

async function runList(args: string[]): Promise<void> {
	const source = args[0];
	const plugins = source ? { [source]: PLUGINS[source] } : PLUGINS;

	for (const [name, plugin] of Object.entries(plugins)) {
		if (!plugin) {
			console.error(`Unknown source: ${name}`);
			continue;
		}
		try {
			const refs = await plugin.listSessions();
			console.log(`${name}: ${refs.length} session(s)`);
			for (const ref of refs.slice(0, 5)) {
				console.log(`  ${ref}`);
			}
			if (refs.length > 5) {
				console.log(`  ... and ${refs.length - 5} more`);
			}
		} catch (err) {
			console.log(`${name}: ${err instanceof Error ? err.message : "error"}`);
		}
	}
}

function printHelp(): void {
	console.log(`pi-brain - Privacy-first dataset extraction from AI coding sessions

Usage:
  pi-brain export [source]     Export sessions (default source: pi)
  pi-brain upload <dir> --target huggingface --repo user/name [--public]
  pi-brain upload <dir> --target http --url https://...
  pi-brain list [source]       List available sessions
  pi-brain help                Show this help

Sources: ${Object.keys(PLUGINS).join(", ")}

Environment variables:
  PI_BRAIN_REVIEWER_API_KEY    API key for structured review
  HF_TOKEN                     Hugging Face token for uploads
`);
}

function parseUploadArgs(args: string[]): UploadConfig {
	let target: string | undefined;
	let repo: string | undefined;
	let url: string | undefined;
	let visibility: "private" | "public" = "private";

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--target":
				target = args[++index];
				break;
			case "--repo":
				repo = args[++index];
				break;
			case "--url":
				url = args[++index];
				break;
			case "--public":
				visibility = "public";
				break;
			default:
				console.error(`Unknown upload flag: ${arg}`);
				process.exit(1);
		}
	}

	if (target === "huggingface") {
		if (!repo) {
			console.error("Missing required flag: --repo user/name");
			process.exit(1);
		}
		return {
			type: "huggingface",
			repo,
			visibility,
		};
	}

	if (target === "http") {
		if (!url) {
			console.error("Missing required flag: --url https://...");
			process.exit(1);
		}
		return {
			type: "http",
			url,
		};
	}

	console.error("Missing or unsupported --target. Use 'huggingface' or 'http'.");
	process.exit(1);
}

async function readBundle(bundleDir: string): Promise<ExportBundle> {
	const resolvedDir = resolve(bundleDir);
	const manifestPath = join(resolvedDir, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
		hash: string;
		createdAt: string;
		metadata: ExportBundle["metadata"];
		files: string[];
	};

	const artifacts: ExportArtifact[] = await Promise.all(
		manifest.files.map(async (fileName) => {
			const content = await readFile(join(resolvedDir, fileName), "utf-8");
			return {
				format: fileNameToFormat(fileName),
				fileName,
				content,
			};
		}),
	);

	const computedHash = createHash("sha256")
		.update(artifacts.map((artifact) => artifact.content).join(""))
		.digest("hex");

	if (computedHash !== manifest.hash) {
		throw new Error(
			`Bundle manifest hash mismatch: expected ${manifest.hash}, got ${computedHash}`,
		);
	}

	return {
		artifacts,
		manifestHash: manifest.hash,
		createdAt: manifest.createdAt,
		metadata: manifest.metadata,
	};
}

function fileNameToFormat(fileName: string): ExportFormat {
	switch (fileName) {
		case "sessions.jsonl":
			return "sessions";
		case "sft.jsonl":
			return "sft-jsonl";
		case "chatml.jsonl":
			return "chatml";
		default:
			console.error(`Unsupported artifact in bundle: ${fileName}`);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
