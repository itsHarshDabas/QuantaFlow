#!/usr/bin/env node
import { nodeIo } from "./io.js";
import { main } from "./main.js";

const code = await main(process.argv.slice(2), nodeIo());
// Exit once output is flushed, so a lingering keep-alive socket can't hold the shell.
process.stdout.write("", () => process.exit(code));
