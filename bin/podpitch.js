#!/usr/bin/env node
import { run } from '../src/cli.js';

run().catch((error) => {
  console.error(`PodPitch: ${error.message}`);
  process.exitCode = 1;
});
