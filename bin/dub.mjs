#!/usr/bin/env node
import { main } from '../dist/cli.js';
try { await main(); }
catch (error) { console.error(`dub: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
