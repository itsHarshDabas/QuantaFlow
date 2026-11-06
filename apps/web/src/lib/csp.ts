import { config } from "zod";

// The daemon's CSP forbids eval. Without this, zod probes `new Function` on first parse,
// the browser blocks it and logs a CSP error on every page load. zod then falls back to
// the same jitless parser this selects up front.
config({ jitless: true });
