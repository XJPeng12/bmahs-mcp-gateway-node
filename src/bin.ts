#!/usr/bin/env node
import { cli_main } from "./cli.js";

cli_main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: Error) => {
    console.error(`bmahs-mcp-node: ${e.message}`);
    process.exitCode = 2;
  });
