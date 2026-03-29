import type { SourcePlugin } from "../core/index.js";
/**
 * Harness: load real sessions from ALL sources, sanitize, report results.
 */
import { sanitize } from "../core/privacy/redactor.js";
import { claudePlugin } from "../plugins/claude/index.js";
import { codexPlugin } from "../plugins/codex/index.js";
import { factoryPlugin } from "../plugins/factory/index.js";
import { opencodePlugin } from "../plugins/opencode/index.js";
import { piPlugin } from "../plugins/pi/index.js";

const PLUGINS: Record<string, SourcePlugin> = {
	pi: piPlugin,
	claude: claudePlugin,
	codex: codexPlugin,
	opencode: opencodePlugin,
	factory: factoryPlugin,
};

async function main() {
	console.log("=== pi-brain harness: ALL sources ===\n");

	const grandTotals = {
		sessions: 0,
		errors: 0,
		messages: 0,
		redactions: 0,
	};
	const grandCategories: Record<string, number> = {};

	for (const [name, plugin] of Object.entries(PLUGINS)) {
		console.log(`\n--- ${name.toUpperCase()} ---`);

		let refs: string[];
		try {
			refs = await plugin.listSessions();
		} catch (err) {
			console.log(`  listSessions failed: ${err instanceof Error ? err.message : err}`);
			continue;
		}

		console.log(`  Found ${refs.length} session file(s)`);
		if (refs.length === 0) continue;

		let loaded = 0;
		let errored = 0;
		let totalMessages = 0;
		let totalRedactions = 0;
		const categories: Record<string, number> = {};

		for (const ref of refs) {
			try {
				const session = await plugin.loadSession(ref);
				totalMessages += session.messages.length;

				const { report } = sanitize(session);
				loaded++;
				totalRedactions += report.totalRedactions;

				for (const [cat, count] of Object.entries(report.categoryCounts)) {
					categories[cat] = (categories[cat] ?? 0) + count;
					grandCategories[cat] = (grandCategories[cat] ?? 0) + count;
				}
			} catch {
				errored++;
			}
		}

		grandTotals.sessions += loaded;
		grandTotals.errors += errored;
		grandTotals.messages += totalMessages;
		grandTotals.redactions += totalRedactions;

		console.log(`  Loaded: ${loaded}  Errored: ${errored}`);
		console.log(`  Messages: ${totalMessages}  Redactions: ${totalRedactions}`);
		if (Object.keys(categories).length > 0) {
			const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1]);
			for (const [cat, count] of sorted) {
				console.log(`    ${cat.padEnd(20)} ${count}`);
			}
		}
	}

	console.log("\n\n=== GRAND TOTAL ===");
	console.log(`Sessions: ${grandTotals.sessions}`);
	console.log(`Errors:   ${grandTotals.errors}`);
	console.log(`Messages: ${grandTotals.messages}`);
	console.log(`Redactions: ${grandTotals.redactions}`);
	console.log("\nBy category:");
	const sorted = Object.entries(grandCategories).sort((a, b) => b[1] - a[1]);
	for (const [cat, count] of sorted) {
		console.log(`  ${cat.padEnd(20)} ${count}`);
	}
}

main().catch(console.error);
