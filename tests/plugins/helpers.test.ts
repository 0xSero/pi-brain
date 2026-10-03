import { describe, expect, it } from "vitest";

import { sessionIdFromPath } from "../../plugins/helpers.js";

describe("sessionIdFromPath", () => {
	it("uses the last two path components", () => {
		expect(sessionIdFromPath("/var/sessions/chat.jsonl")).toBe("sessions/chat");
		expect(sessionIdFromPath("C:\\Users\\a\\sessions\\chat.jsonl")).toBe("sessions/chat");
	});
});
