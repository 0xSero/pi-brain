import { beforeEach, describe, expect, it } from "vitest";

import registerPiCommands from "../../plugins/pi/index.js";

type Notification = { level: "error" | "info" | "warning"; message: string };

function createPiApi() {
	const commands = new Map<
		string,
		{
			description: string;
			getArgumentCompletions: (prefix: string) => { value: string; label: string }[] | null;
			handler: (args: string, ctx: any) => Promise<void>;
		}
	>();

	registerPiCommands({
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
	} as any);

	return { commands };
}

function createUiContext(notifications: Notification[]) {
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const statusCalls: Array<{ key: string; text?: string }> = [];
	const widgetCalls: Array<{ key: string; content?: string[]; placement?: string }> = [];
	const selectResults = ["Current session"];
	return {
		waitForIdle: async () => Promise.resolve(),
		hasUI: true,
		sessionManager: {
			getSessionFile: () => undefined,
		},
		ui: {
			select: async (title: string, options: string[]) => {
				selectCalls.push({ title, options });
				return selectResults.shift();
			},
			confirm: async (title: string, message: string) => {
				confirmCalls.push({ title, message });
				return false;
			},
			setStatus: (key: string, text: string | undefined) => {
				statusCalls.push({ key, text });
			},
			setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => {
				widgetCalls.push({ key, content, placement: options?.placement });
			},
			notify: (message: string, level: "error" | "info" | "warning" = "info") => {
				notifications.push({ level, message });
			},
		},
		confirmCalls,
		statusCalls,
		selectResults,
		selectCalls,
		widgetCalls,
	};
}

describe("Pi extension commands", () => {
	let commands: ReturnType<typeof createPiApi>["commands"];

	beforeEach(() => {
		({ commands } = createPiApi());
	});

	it("registers only the simplified slash commands", () => {
		expect([...commands.keys()].sort()).toEqual(["export", "export-local", "export-public"]);
	});

	it("routes /export through the TUI pickers", async () => {
		const notifications: Notification[] = [];
		const ctx = createUiContext(notifications);
		ctx.selectResults.splice(0, ctx.selectResults.length, "Export locally", "Current session");
		const command = commands.get("export");
		if (!command) {
			throw new Error("export command not registered");
		}

		await command.handler("--format=bad", ctx);

		expect(ctx.selectCalls).toHaveLength(2);
		expect(ctx.selectCalls[0].title).toBe("Export action");
		expect(ctx.selectCalls[1].title).toBe("Export scope");
		expect(notifications[0].message).toContain("Unsupported format");
		expect(ctx.statusCalls.at(-1)?.key).toBe("pi-brain-export");
		expect(ctx.widgetCalls.at(-1)?.content?.[0]).toContain("Unsupported format");
	});

	it("rejects invalid export-local formats", async () => {
		const notifications: Notification[] = [];
		const ctx = createUiContext(notifications);
		const command = commands.get("export-local");
		if (!command) {
			throw new Error("export-local command not registered");
		}

		await command.handler("--format=bad", ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("Unsupported format");
		expect(ctx.selectCalls).toHaveLength(1);
		expect(ctx.statusCalls.at(-1)?.key).toBe("pi-brain-export");
		expect(ctx.widgetCalls.at(-1)?.key).toBe("pi-brain-export");
	});

	it("rejects invalid export-public formats before publishing", async () => {
		const notifications: Notification[] = [];
		const ctx = createUiContext(notifications);
		const command = commands.get("export-public");
		if (!command) {
			throw new Error("export-public command not registered");
		}

		await command.handler("--repo 0xSero/test --format=bad", ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("Unsupported format");
		expect(ctx.selectCalls).toHaveLength(1);
		expect(ctx.statusCalls.at(-1)?.key).toBe("pi-brain-export");
		expect(ctx.widgetCalls.at(-1)?.key).toBe("pi-brain-export");
	});

	it("skips the TUI picker when scope is explicit", async () => {
		const notifications: Notification[] = [];
		const ctx = createUiContext(notifications);
		const command = commands.get("export-local");
		if (!command) {
			throw new Error("export-local command not registered");
		}

		await command.handler("--all --format=bad", ctx);

		expect(ctx.selectCalls).toHaveLength(0);
		expect(notifications[0].message).toContain("Unsupported format");
	});

	it("offers export-local completions", () => {
		const command = commands.get("export-local");
		if (!command) {
			throw new Error("export-local command not registered");
		}

		const completions = command.getArgumentCompletions("--form");
		expect(Array.isArray(completions)).toBe(true);
		expect(completions?.some((item) => item.value === "--format")).toBe(true);
	});

	it("offers scope completions for export-local", () => {
		const command = commands.get("export-local");
		if (!command) {
			throw new Error("export-local command not registered");
		}

		const completions = command.getArgumentCompletions("--a");
		expect(Array.isArray(completions)).toBe(true);
		expect(completions?.some((item) => item.value === "--all")).toBe(true);
	});

	it("offers export-public completions", () => {
		const command = commands.get("export-public");
		if (!command) {
			throw new Error("export-public command not registered");
		}

		const completions = command.getArgumentCompletions("--pr");
		expect(Array.isArray(completions)).toBe(true);
		expect(completions?.some((item) => item.value === "--private")).toBe(true);
	});

	it("offers scope completions for export-public", () => {
		const command = commands.get("export-public");
		if (!command) {
			throw new Error("export-public command not registered");
		}

		const completions = command.getArgumentCompletions("--cu");
		expect(Array.isArray(completions)).toBe(true);
		expect(completions?.some((item) => item.value === "--current")).toBe(true);
	});
});
