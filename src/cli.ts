#!/usr/bin/env node

import parseCommandLineOptions = require('./parseCommandLineOptions');
import subfont = require('./subfont');

const { yargs, help: _help, ...options } = parseCommandLineOptions();

// eslint-disable-next-line no-restricted-syntax
subfont(options, console).catch((err: unknown) => {
  yargs.showHelp();
  if (err instanceof Error && err.name === 'UsageError') {
    console.error(err.message);
  } else if (err instanceof Error) {
    console.error(err.stack || err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
