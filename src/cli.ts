#!/usr/bin/env node

import parseCommandLineOptions = require('./parseCommandLineOptions');
import subfont = require('./subfont');

const { yargs, help: _help, ...options } = parseCommandLineOptions();

subfont(options, console).catch((err: Error) => {
  yargs.showHelp();
  if (err.name === 'UsageError') {
    console.error(err.message);
  } else {
    console.error(err.stack || err);
  }
  process.exitCode = 1;
});
