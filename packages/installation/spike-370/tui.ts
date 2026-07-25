/** SPIKE #370 — throwaway TUI shell over setup-flow.ts. Drive it by hand; the reducer is the keeper. */
import { initialState, reduce, hasWorkInFlight, type SetupAction, type SetupState } from "./setup-flow.ts";

const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const RED = "\x1b[31m";

let state: SetupState = initialState;
let log: string[] = [];

const dispatch = (action: SetupAction, note?: string): void => {
  const before = state.revision;
  state = reduce(state, action);
  if (note !== undefined) log.unshift(`${note}${state.revision === before ? `${D} (no revision change)${R}` : ""}`);
  log = log.slice(0, 6);
  render();
};

const colour = (kind: string): string =>
  kind === "paired" || kind === "complete" ? G : kind === "failed" ? RED : kind === "idle" ? D : Y;

const line = (label: string, value: string, kind: string): string =>
  `  ${B}${label.padEnd(10)}${R} ${colour(kind)}${value}${R}`;

const describePairing = (s: SetupState): string => {
  const p = s.pairing;
  switch (p.kind) {
    case "awaiting_scan":
      return `awaiting_scan  ${D}qr=${p.qr} rotations=${p.rotations} expires_in=${Math.max(0, p.expiresAt - s.now)}ms${R}`;
    case "paired":
      return `paired  ${D}${p.jid}${R}`;
    case "failed":
      return `failed  ${D}${p.reason}${R}`;
    default:
      return p.kind;
  }
};

const describeDevice = (s: SetupState): string => {
  const d = s.device;
  switch (d.kind) {
    case "awaiting_authorization":
      return `awaiting_authorization  ${D}code=${d.userCode} at ${d.verificationUri} expires_in=${Math.max(0, d.expiresAt - s.now)}ms${R}`;
    case "failed":
      return `failed  ${D}${d.reason}${R}`;
    default:
      return d.kind;
  }
};

const render = (): void => {
  console.clear();
  process.stdout.write(`${B}SPIKE #370 — browser-driven setup flow${R}\n`);
  process.stdout.write(`${D}Can a page connect late, or close and reopen mid-pair, and still see the truth?${R}\n\n`);

  process.stdout.write(`${B}STATE${R}\n`);
  process.stdout.write(line("pairing", describePairing(state), state.pairing.kind) + "\n");
  process.stdout.write(line("device", describeDevice(state), state.device.kind) + "\n");
  process.stdout.write(
    `  ${B}${"observers".padEnd(10)}${R} ${state.observers}${state.observers === 0 && hasWorkInFlight(state) ? `  ${Y}← nobody watching, work still in flight${R}` : ""}\n`,
  );
  process.stdout.write(`  ${B}${"revision".padEnd(10)}${R} ${D}${state.revision}   now=${state.now}ms${R}\n\n`);

  process.stdout.write(`${B}WHAT A PAGE CONNECTING RIGHT NOW WOULD RECEIVE${R}\n`);
  process.stdout.write(`${D}${JSON.stringify({ pairing: state.pairing, device: state.device, revision: state.revision })}${R}\n\n`);

  if (log.length > 0) {
    process.stdout.write(`${B}RECENT${R}\n`);
    for (const l of log) process.stdout.write(`  ${D}·${R} ${l}\n`);
    process.stdout.write("\n");
  }

  process.stdout.write(
    `${B}[p]${R}${D} start pairing${R}  ${B}[q]${R}${D} qr issued/rotate${R}  ${B}[s]${R}${D} scanned→paired${R}  ${B}[x]${R}${D} pair fail${R}\n` +
      `${B}[d]${R}${D} device code${R}  ${B}[a]${R}${D} authorized${R}\n` +
      `${B}[c]${R}${D} page connects${R}  ${B}[k]${R}${D} page closes${R}  ${B}[t]${R}${D} tick 10s${R}  ${B}[Q]${R}${D} quit${R}\n`,
  );
};

const keys: Record<string, () => void> = {
  p: () => dispatch({ type: "start_pairing" }, "server began pairing"),
  q: () => dispatch({ type: "qr_issued", qr: `2@${Math.floor(state.now / 7) + 100}`, ttlMs: 20_000 }, "client rotated the QR"),
  s: () => dispatch({ type: "paired", jid: "44700900000@s.whatsapp.net" }, "phone scanned — paired"),
  x: () => dispatch({ type: "pair_failed", reason: "stream replaced" }, "pairing failed"),
  d: () =>
    dispatch(
      { type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://chatgpt.com/device", ttlMs: 60_000 },
      "device code issued",
    ),
  a: () => dispatch({ type: "device_authorized" }, "ChatGPT authorized"),
  c: () => dispatch({ type: "observer_attached" }, "a page connected"),
  k: () => dispatch({ type: "observer_detached" }, "a page closed"),
  t: () => dispatch({ type: "tick", ms: 10_000 }, "10s passed"),
};

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  if (key === "Q" || key === "") {
    process.stdout.write("\n");
    process.exit(0);
  }
  keys[key]?.();
});

render();
