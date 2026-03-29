/**
 * Quick harness: load real Pi sessions, sanitize, report what gets redacted.
 */
import { readFileSync } from "node:fs";
import { ALL_REDACTION_CATEGORIES } from "../core/configs/defaults.js";
import { detectAll } from "../core/privacy/detectors.js";
import { sanitize } from "../core/privacy/redactor.js";
import { piPlugin } from "../plugins/pi/index.js";

async function main() {
	console.log("=== pi-brain harness: real ~/.pi sessions ===\n");

	const refs = await piPlugin.listSessions();
	console.log(`Found ${refs.length} Pi session files\n`);

	let totalSessions = 0;
	let totalMessages = 0;
	let totalRedactions = 0;
	let errors = 0;
	const categoryTotals: Record<string, number> = {};
	const sampleRedactions: Array<{
		session: string;
		category: string;
		placeholder: string;
		context: string;
	}> = [];

	// Process all sessions
	const batch = refs;

	for (const ref of batch) {
		try {
			const session = await piPlugin.loadSession(ref);
			totalMessages += session.messages.length;

			const { session: sanitized, report } = sanitize(session);
			totalSessions++;
			totalRedactions += report.totalRedactions;

			for (const [cat, count] of Object.entries(report.categoryCounts)) {
				categoryTotals[cat] = (categoryTotals[cat] ?? 0) + count;
			}

			// Collect sample redactions (first 3 per session, max 20 total)
			if (sampleRedactions.length < 20) {
				for (const entry of report.entries.slice(0, 3)) {
					if (sampleRedactions.length >= 20) break;

					// Get context from sanitized text to show what it looks like
					const msgIdx = findMessageWithPlaceholder(sanitized.messages, entry.placeholder);
					let context = "";
					if (msgIdx >= 0) {
						const msg = sanitized.messages[msgIdx].content;
						const pos = msg.indexOf(entry.placeholder);
						if (pos >= 0) {
							const start = Math.max(0, pos - 30);
							const end = Math.min(msg.length, pos + entry.placeholder.length + 30);
							context = `...${msg.slice(start, end)}...`;
						}
					}

					// Shorten the session ref for display
					const shortRef = ref.split("/").slice(-2).join("/");
					sampleRedactions.push({
						session: shortRef,
						category: entry.category,
						placeholder: entry.placeholder,
						context,
					});
				}
			}
		} catch (err) {
			errors++;
		}
	}

	console.log(`--- Results (first ${batch.length} of ${refs.length} sessions) ---\n`);
	console.log(`Sessions loaded:    ${totalSessions}`);
	console.log(`Sessions errored:   ${errors}`);
	console.log(`Total messages:     ${totalMessages}`);
	console.log(`Total redactions:   ${totalRedactions}`);
	console.log();

	console.log("Redactions by category:");
	const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
	for (const [cat, count] of sorted) {
		console.log(`  ${cat.padEnd(20)} ${count}`);
	}
	console.log();

	if (sampleRedactions.length > 0) {
		console.log("Sample redactions (showing sanitized context):");
		for (const s of sampleRedactions) {
			console.log(`  [${s.category}] ${s.placeholder}`);
			if (s.context) {
				console.log(`    ${s.context}`);
			}
		}
	}

	// Show a full before/after for one message from the first successful session
	console.log("\n--- Before/After example (first user message from first session) ---\n");
	try {
		const firstSession = await piPlugin.loadSession(batch[0]);
		const firstUserMsg = firstSession.messages.find((m) => m.role === "user");
		if (firstUserMsg) {
			const { session: sanitized } = sanitize(firstSession);
			const sanitizedFirstUser = sanitized.messages.find((m) => m.role === "user");

			console.log("BEFORE (raw, truncated to 500 chars):");
			console.log(firstUserMsg.content.slice(0, 500));
			console.log("\nAFTER (sanitized, truncated to 500 chars):");
			console.log(sanitizedFirstUser?.content.slice(0, 500) ?? "(no user message)");
		}
	} catch {
		console.log("(could not load first session for before/after)");
	}
}

function findMessageWithPlaceholder(
	messages: ReadonlyArray<{ content: string }>,
	placeholder: string,
): number {
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].content.includes(placeholder)) return i;
	}
	return -1;
}

main().catch(console.error);
