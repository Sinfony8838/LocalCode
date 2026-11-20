#!/usr/bin/env node
// logpulse CLI entry — see docs/CI-GUIDE.md for the exit-code contract.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildReport, confirmOverwrite } from '../src/report/core.mjs';

const EXIT = { ok: 0, nonInteractive: 2, declined: 3, usage: 64 };

function usage() {
  process.stderr.write('usage: logpulse <stats|rotate|report> [options]\n');
  process.exit(EXIT.usage);
}

function readArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') flags.dir = argv[++i];
    else if (arg === '--keep') flags.keep = Number(argv[++i]);
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--force') flags.force = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

async function stats(file) {
  if (!file || !existsSync(file)) {
    process.stderr.write(`stats: file not found: ${file ?? ''}\n`);
    process.exit(EXIT.usage);
  }
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(line => line.trim().length).length;
  const bytes = statSync(file).size;
  process.stdout.write(`${JSON.stringify({ file, lines, bytes })}\n`);
}

function rotate({ dir, keep }) {
  if (!dir || !Number.isInteger(keep) || keep < 0) {
    process.stderr.write('rotate requires --dir and integer --keep\n');
    process.exit(EXIT.usage);
  }
  const logs = readdirSync(dir).filter(name => name.endsWith('.log')).sort();
  const deleteCount = Math.max(0, logs.length - keep);
  const deleted = logs.slice(0, deleteCount);
  const kept = logs.slice(deleteCount);
  for (const name of deleted) unlinkSync(path.join(dir, name));
  process.stdout.write(`${JSON.stringify({ deleted, kept })}\n`);
}

async function report({ out, force }) {
  if (!out) {
    process.stderr.write('report requires --out <file>\n');
    process.exit(EXIT.usage);
  }
  if (existsSync(out) && !force) {
    const confirmed = await confirmOverwrite(out);
    if (!confirmed) process.exit(EXIT.declined);
  }
  const summary = await buildReport('logs');
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ wrote: path.resolve(out), files: summary.files })}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();
const { flags, positional } = readArgs(rest);
if (command === 'stats') await stats(positional[0]);
else if (command === 'rotate') rotate(flags);
else if (command === 'report') await report(flags);
else usage();
