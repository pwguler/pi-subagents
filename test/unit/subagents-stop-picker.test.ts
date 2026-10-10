import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { createEventBus } from "../support/helpers.ts";

function writeRunningRun(runId: string): void {
	const asyncDir = path.join(ASYNC_DIR, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId, mode: "single", state: "running", sessionId: "session", pid: process.pid, cwd: os.tmpdir(),
		startedAt: 100, lastUpdate: Date.now(), steps: [{ agent: "worker", status: "running", startedAt: 100 }],
	}));
	updateActiveRunIndex(asyncDir, "running");
}

// Opens the /subagents-stop picker, records its rows, and presses Enter twice (select the first row, confirm).
async function stopFromPicker(runIds: string[]): Promise<{ rows: string[]; confirm: string[]; requested: unknown[] }> {
	for (const runId of runIds) writeRunningRun(runId);
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const requested: unknown[] = [];
	const events = createEventBus();
	events.on("subagent:slash:request", (data) => {
		const { requestId, params } = data as { requestId: string; params: unknown };
		requested.push(params);
		events.emit("subagent:slash:started", { requestId });
		events.emit("subagent:slash:response", { requestId, result: { content: [{ type: "text", text: "stopped" }], details: { mode: "management", results: [] } }, isError: false });
	});
	const pi = { events, on() { return () => {}; }, registerTool() {}, registerCommand: (name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, spec), registerShortcut() {}, sendMessage() {} };
	const state = { ...createChildSafeState(), baseCwd: process.cwd(), currentSessionId: "session" };
	const disposer = registerSlashCommands(pi as never, state);
	let rows: string[] = [];
	let confirm: string[] = [];
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const ui = {
		notify() {}, setStatus() {}, setToolsExpanded() {}, onTerminalInput: () => () => {},
		custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => { handleInput(data: string): void; render(width: number): string[] }) =>
			new Promise((resolve) => {
				const selector = factory({ requestRender() {} }, theme, undefined, resolve);
				rows = selector.render(120);
				selector.handleInput("\r");
				confirm = selector.render(120);
				selector.handleInput("\r");
			}),
	};
	try {
		await commands.get("subagents-stop")!.handler("", {
			cwd: process.cwd(), hasUI: true, mode: "tui", ui,
			sessionManager: { getSessionId: () => "session", getSessionFile: () => null },
		});
	} finally {
		disposer.dispose();
		for (const runId of runIds) {
			updateActiveRunIndex(path.join(ASYNC_DIR, runId), "complete");
			fs.rmSync(path.join(ASYNC_DIR, runId), { recursive: true, force: true });
		}
	}
	return { rows, confirm, requested };
}

it("/subagents-stop offers a first Stop all row for two or more async runs and stops each of them", async () => {
	const { rows, confirm, requested } = await stopFromPicker(["stop-all-a", "stop-all-b"]);
	assert.ok(rows.some((row) => row.startsWith("› stop all 2 current-session async runs")), rows.join("\n"));
	assert.ok(confirm.includes("Confirm: stop all 2 async runs?"), confirm.join("\n"));
	assert.deepEqual(
		(requested as Array<{ id: string }>).map((params) => params.id).sort(),
		["stop-all-a", "stop-all-b"],
	);
	assert.ok((requested as Array<{ action: string }>).every((params) => params.action === "stop"));
});

it("/subagents-stop shows no Stop all row for a single async run", async () => {
	const { rows, requested } = await stopFromPicker(["stop-one"]);
	assert.ok(!rows.some((row) => row.includes("stop all")), rows.join("\n"));
	assert.deepEqual(requested, [{ action: "stop", id: "stop-one" }]);
});
