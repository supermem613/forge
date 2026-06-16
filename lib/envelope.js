// lib/envelope.js — uniform agentic-first JSON envelope for forge and modules.
//
// Contract: every non-interactive forge command writes exactly one JSON
// envelope to stdout. Progress, diagnostics, banners, and human narration go to
// stderr. There is no --json flag. Machine-readable JSON on stdout is the only
// output contract, so a fresh agent can run any command and parse stdout.
//
//   success: { "ok": true,  "command": <name>, "data": {...} }
//   failure: { "ok": false, "command": <name>, "error": <message>, "code": <code>, "hint": <fix|null> }
//
// `schema` and `doctor` keep their own documented top-level shapes (the schema
// catalog, and the { ok, checks } health-check shape). They start with `ok`
// already and are exempt from the generic data envelope.

// Carries a remediation hint and an error code from a command to the central
// error emitter so the failure envelope can tell an agent how to recover.
export class ForgeError extends Error {
  constructor(message, { code = 'ERROR', hint = null } = {}) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.hint = hint;
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// General success/result envelope. `ok` lets validation-style commands report a
// failing result (ok:false) without throwing, while still exiting non-zero.
export function envelope(command, data = {}, ok = true) {
  write({ ok, command, data });
}

export function emit(command, data = {}) {
  write({ ok: true, command, data });
}

export function emitError(command, error, hint = null) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ForgeError ? error.code : 'ERROR';
  const resolvedHint = hint ?? (error instanceof ForgeError ? error.hint : null);
  write({ ok: false, command, error: message, code, hint: resolvedHint ?? null });
}
