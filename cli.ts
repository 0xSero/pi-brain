#!/usr/bin/env node
/**
 * @file cli.ts
 *
 * Standalone CLI for pi-brain. Provides dataset-export, dataset-upload,
 * and dataset-config commands without requiring Pi to be installed.
 * When used as a Pi extension, these commands are also available as
 * /dataset-export, /dataset-upload, /dataset-config.
 */

import { join } from "node:path";

import {
	type CanonicalSession,
	type SourcePlugin,
	createBundle,
	resolveConfig,
	sanitize,
	writeBundle,
} from "./core/index.js";

import { claudePlugin } from "./plugins/claude/index.js";
import { codexPlugin } from "./plugins/codex/index.js";
import { cursorPlugin } from "./plugins/cursor/index.js";
import { factoryPlugin } from "./plugins/factory/index.js";
import { opencodePlugin } from "./plugins/opencode/index.js";
import { piPlugin } from "./plugins/pi/index.js";

/** All available source plugins. */
const PLUGINS: Record<string, SourcePlugin> = {
	pi: piPlugin,
	claude: claudePlugin,
	codex: codexPlugin,
	opencode: opencodePlugin,
	cursor: cursorPlugin,
	factory: factoryPlugin,
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
	const sessions: CanonicalSession[] = [];
	let errors = 0;

	for (const ref of refs) {
		try {
			const session = await plugin.loadSession(ref);
			const { session: sanitized } = sanitize(session, config.privacy);
			sessions.push(sanitized as unknown as CanonicalSession);
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

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outputDir = config.export.outputDir || join(".pi-private-data", "exports", timestamp);

	const bundle = createBundle(sessions as any, config.export);
	await writeBundle(bundle, outputDir);

	console.log(`Exported to ${outputDir}/`);
	console.log(`  Sessions: ${bundle.metadata.sessionCount}`);
	console.log(`  Messages: ${bundle.metadata.messageCount}`);
	console.log(`  Formats: ${bundle.metadata.formats.join(", ")}`);
	console.log(`  Hash: ${bundle.manifestHash.slice(0, 16)}...`);
}

async function runUpload(args: string[]): Promise<void> {
	const bundleDir = args[0];
	if (!bundleDir) {
		console.error("Usage: pi-brain upload <bundle-dir> [--target huggingface --repo user/name]");
		process.exit(1);
	}

	// For now, just explain what would happen
	console.log(`Upload from ${bundleDir} — configure target with --target and --repo flags.`);
	console.log("Upload support requires config. See docs/design.md for details.");
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
  pi-brain upload <dir>        Upload an exported bundle
  pi-brain list [source]       List available sessions
  pi-brain help                Show this help

Sources: ${Object.keys(PLUGINS).join(", ")}

Environment variables:
  PI_BRAIN_REVIEWER_API_KEY    API key for structured review
  HF_TOKEN                     Hugging Face token for uploads
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
