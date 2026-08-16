#!/usr/bin/env node
const { main } = require('../lib/cli');

main().then((status) => {
  process.exitCode = status;
}).catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
