import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDir } from "./fixtures.ts";

export const REX_SESSION = "session:11111111-1111-4111-8111-111111111111";
export const REX_PARENT = "block:22222222-2222-4222-8222-222222222222";
export const REX_CHILD = "block:33333333-3333-4333-8333-333333333333";
/** The fake numbers each later block it creates; a second child never reuses the first block. */
export const REX_SECOND_CHILD = "block:33333333-3333-4333-8333-000000000001";
export const REX_WINDOW = "window:44444444-4444-4444-8444-444444444444";

/** Fake CLI is the only executable on PATH. No test can contact a live mux. */
export function useFakeRex() {
	const dir = createTestDir();
	const log = join(dir, "commands.jsonl");
	const state = join(dir, "state.json");
	writeFileSync(log, "");
	writeFileSync(state, "{}");
	const script = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const json = value => console.log(JSON.stringify(value));
const created = (window, rect) => {
 state.created ??= [];
 const block = state.created.length ? 'block:33333333-3333-4333-8333-' + String(state.created.length).padStart(12, '0') : ${JSON.stringify(REX_CHILD)};
 state.created.push(block);
 state.windows = { ...state.windows, [block]: window };
 state.rects = { ...state.rects, [block]: rect };
 fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
 return block;
};
// Layout is simulated like Rex: rects are fractions of one shared client viewport.
const windowOf = block => state.windows?.[block] ?? ${JSON.stringify(REX_WINDOW)};
const rectOf = block => state.rects?.[block] ?? [0, 0, 1, 1];
const viewport = state.viewport ?? { columns: 200, rows: 50 };
if (args[0] !== '--autostart=false') process.exit(90);
if (args[1] === 'session' && args[2] === 'inspect') {
 if (args[3] !== ${JSON.stringify(REX_SESSION)}) process.exit(3);
 const blocks = [${JSON.stringify(REX_PARENT)}, ...(state.created ?? [])].filter(b => !(state.parentGone && b === ${JSON.stringify(REX_PARENT)}));
 const node = block_id => ({ block_id, rect: rectOf(block_id) });
 const layout = ids => ids.reduceRight((after, id) => after ? { split: { before: node(id), after } } : node(id), null);
 json({ session_id: ${JSON.stringify(REX_SESSION)}, windows: [...new Set(blocks.map(windowOf))].map(window_id =>
  ({ window_id, layers: [{ kind: 'tiled', layout: layout(blocks.filter(b => windowOf(b) === window_id)) }] })) });
 process.exit(0);
}
if (args[args.indexOf('-s') + 1] !== ${JSON.stringify(REX_SESSION)}) process.exit(90);
const op = args[1];
if (op === 'block' && args[2] === 'inspect') {
 if (state.lookupFail || (state.parentGone && args[3] === ${JSON.stringify(REX_PARENT)})) process.exit(3);
 if (state.malformed) { console.log('not-json'); process.exit(0); }
 json({session_id:state.wrongSession ? 'other' : ${JSON.stringify(REX_SESSION)}, block:{block_id:state.wrongBlock ? 'other' : args[3], window_id:state.windows?.[args[3]] ?? ${JSON.stringify(REX_WINDOW)},label:state.label ?? 'Manual title'}});
} else if (op === 'block' && args[2] === 'call' && args[5] === 'size') {
 if (state.sizeFail) process.exit(3);
 const [, , width, height] = rectOf(args[4]);
 // A block no client has displayed reports Rex's default size and no desired client size.
 json(state.unseen ? { columns: 80, rows: 24, desired: [] } : { columns: Math.floor(viewport.columns * width),
  rows: Math.floor(viewport.rows * height), desired: [{ client_id: 'client:fake' }] });
} else if (op === 'split') {
 if (state.splitFail) process.exit(3);
 const anchor = args[args.indexOf('-b')+1];
 const ratio = args.indexOf('--ratio');
 const share = ratio < 0 ? 0.5 : Number(args[ratio + 1]) / 100;
 const [x, y, w, h] = rectOf(anchor);
 const [kept, added] = args[args.indexOf('--split') + 1] === 'below'
  ? [[x, y, w, h * (1 - share)], [x, y + h * (1 - share), w, h * share]]
  : [[x, y, w * (1 - share), h], [x + w * (1 - share), y, w * share, h]];
 let block = ${JSON.stringify(REX_PARENT)};
 if (!state.parentAsChild) { state.rects = { ...state.rects, [anchor]: kept }; block = created(windowOf(anchor), added); }
 json({session_id:${JSON.stringify(REX_SESSION)},anchor_id:state.badAnchor ? 'other' : anchor,block_ids:[block]});
} else if (op === 'window' && args[2] === 'new') {
 if (state.windowFail) process.exit(3);
 const window = 'window:44444444-4444-4444-8444-' + String((state.created ?? []).length + 1).padStart(12, '0');
 json({window_id:window,block_ids:[created(window, [0, 0, 1, 1])]});
} else if (op === 'capture') {
 if (state.captureFail) process.exit(3);
 setTimeout(() => console.log(state.screen ?? 'line one\\nline two'), state.captureDelay ?? 0);
} else if (op === 'wait') {
 fs.writeFileSync(${JSON.stringify(join(dir, "wait.pid"))}, String(process.pid));
 if (state.waitSidecar) fs.writeFileSync(state.waitSidecar, JSON.stringify({type:'done',outputTokens:9}));
 if (state.waitHang) { if (state.ignoreTerm) process.on('SIGTERM',()=>{});setInterval(()=>{}, 1000); }
 else if (state.waitError) { console.error('server disconnected'); process.exit(1); }
 else if (state.waitMalformed) { console.log('broken json'); process.exit(0); }
 else if (state.waitPayload) {json(state.waitPayload);process.exit(state.waitCode ?? 0);}
 else {json({exit_code:state.exitCode || 0});process.exit((state.exitCode || 0) % 256);}
} else if (op === 'send' || op === 'send-key' || (op === 'block' && ['rename','close'].includes(args[2]))) {
 if (state.controlFail) process.exit(3);
 if (args[2] === 'rename') {state.label=args.at(-1);fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));}
} else process.exit(91);
`;
	const exe = join(dir, "rex");
	writeFileSync(exe, script);chmodSync(exe, 0o700);
	for (const key of Object.keys(process.env)) {
		if (/^(HERDR|CMUX|TMUX|WEZTERM|ZELLIJ|REX)/.test(key)) delete process.env[key];
	}
	process.env.REX_SESSION = REX_SESSION;
	process.env.REX_BLOCK = REX_PARENT;
	for (const key of ["PI_SUBAGENT_MUX", "PI_SUBAGENT_REX_PLACEMENT", "PI_SUBAGENT_REX_MIN_COLUMNS", "PI_SUBAGENT_REX_MIN_ROWS"]) {
		delete process.env[key];
	}
	process.env.PATH = dir;
	return { dir, state, calls: (): string[][] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
		setState: (value: Record<string, unknown>) => writeFileSync(state, JSON.stringify(value)),
		/** Merges into the current state, keeping the blocks and windows the fake has created. */
		updateState: (patch: (current: Record<string, Record<string, unknown> | undefined>) => Record<string, unknown>) => {
			const current = JSON.parse(readFileSync(state, "utf8"));
			writeFileSync(state, JSON.stringify({ ...current, ...patch(current) }));
		} };
}
