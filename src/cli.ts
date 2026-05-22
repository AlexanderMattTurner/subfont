#!/usr/bin/env node

import parseCommandLineOptions = require('./parseCommandLineOptions');
import subfont = require('./subfont');

const { yargs, help: _help, ...options } = parseCommandLineOptions();

type ErrorWithCustomOutput = Error & { customOutput?: string };

subfont(options, console).catch((err: ErrorWithCustomOutput) => {
  yargs.showHelp();
  if (err.name === 'UsageError') {
    console.error(err.message);
  } else {
    console.error(err.customOutput || err.stack || err);
  }
  process.exitCode = 1;
});
