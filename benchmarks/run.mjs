#!/usr/bin/env node
// Tiered comparison benchmark: prepare identical workspaces for each agent,
// optionally run a command-line agent on them, then score every workspace
// deterministically and write a comparison scoresheet. See ../README.md.
//
// Banks are directories under benchmarks/ containing tasks/<id>/task.json.
// Tiers: L1 = five-task smoke, L2 = interview-style, L3 = hard, private = local-tasks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { benchRoot, copyTree, hashTree, listTasks, median } from './lib/common.mjs';

const MANUAL_FIELDS = ['durationSeconds', 'toolCalls', 'userInterventions', 'inputTokens', 'outputTokens', 'costNote', 'processQuality', 'notes'];
const usage = `Usage:
  node run.mjs prepare   --out <dir> --agent <label> [--lang zh|en] [--tasks T1,A1] [--tier L1,L2] [--bank five-task]
  node run.mjs run       --out <dir> --agent <label> --cmd "<command using {promptFile}>" [--timeout-min 30]
  node run.mjs score     --out <dir> [--json]
  node run.mjs aggregate --out <dir>            # medians across repeated runs (labels like localcode-1, localcode-2)
  node run.mjs self-test [--tasks T1,A1] [--tier L2]
  node run.mjs list`;

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string' }, agent: { type: 'string' }, lang: { type: 'string', default: 'zh' }, tasks: { type: 'string' },
  tier: { type: 'string' }, bank: { type: 'string' },
  cmd: { type: 'string' }, 'timeout-min': { type: 'string', default: '30' }, json: { type: 'boolean', default: false },
} });
const fail = message => { console.error(message); process.exit(2); };
const safeLabel = label => { if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) fail('--agent must be a simple label such as localcode or claude-code'); return label; };

export async function selectTasks({ tasks: filter, tier, bank } = {}) {
  let tasks = await listTasks();
  if (filter) {
    const wanted = filter.split(',').map(s => s.trim().toUpperCase());
    tasks = tasks.filter(t => wanted.some(w => t.id.toUpperCase().startsWith(w)));
  }
  if (tier) {
    const tiers = tier.split(',').map(s => s.trim().toUpperCase());
    tasks = tasks.filter(t => tiers.includes(String(t.tier).toUpperCase()));
  }
  if (bank) {
    const banks = bank.split(',').map(s => s.trim());
    tasks = tasks.filter(t => banks.includes(t.bank));
  }
  return tasks;
}

/** Run the task's optional "generate" script inside a freshly prepared workspace. */
async function runHook(dir, script, label) {
  if (!script) return;
  const result = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [path.join(dir, script)], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120_000 }));
  if (result.status !== 0) throw new Error(`${label} hook ${script} failed in ${dir}: ${result.stderr || result.stdout || 'exit ' + result.status}`);
}

export async function prepare(out, agent, { lang = 'zh', tasks: filter, tier, bank } = {}) {
  const root = path.join(path.resolve(out), safeLabel(agent));
  if (await fs.stat(root).then(() => true, () => false)) throw new Error(`${root} already exists; choose a new --out or --agent so earlier results are never overwritten.`);
  const tasks = await selectTasks({ tasks: filter, tier, bank });
  if (!tasks.length) throw new Error('no tasks matched the given filters');
  const baseline = {}; const byBank = new Map();
  for (const task of tasks) {
    const workspace = path.join(root, task.id);
    await copyTree(path.join(task.dir, 'fixture'), workspace);
    baseline[task.id] = await hashTree(workspace);
    await runHook(workspace, task.generate, 'generate');
    baseline[task.id] = await hashTree(workspace);
    const prompt = task.prompt[lang] ?? task.prompt.en;
    await fs.writeFile(path.join(root, `${task.id}.prompt.txt`), prompt + '\n');
    if (!byBank.has(task.bank)) byBank.set(task.bank, { tier: task.tier, items: [] });
    byBank.get(task.bank).items.push(`### ${task.id} — ${task.title}${task.minutes ? `（预估 ${task.minutes} 分钟）` : ''}\n\nWorkspace / 项目文件夹: \`${workspace}\`\n\n${prompt}\n`);
  }
  await fs.writeFile(path.join(root, '_baseline.json'), JSON.stringify({ createdAt: new Date().toISOString(), lang, tasks: tasks.map(t => ({ id: t.id, bank: t.bank, tier: t.tier })), baseline }, null, 2));
  const sections = [...byBank.entries()].map(([name, group]) => `## ${name}（tier ${group.tier}）\n\n${group.items.join('\n')}`);
  await fs.writeFile(path.join(root, 'PROMPTS.md'), `# ${agent}\n\nOpen each folder as its own project/session and send the prompt unchanged. Start every task in a fresh conversation.\n每个任务新开一个会话，把对应文件夹作为项目，原样发送提示词。\n\n${sections.join('\n')}`);
  await fs.writeFile(path.join(root, 'manual.json'), JSON.stringify(Object.fromEntries(tasks.map(t => [t.id, Object.fromEntries(MANUAL_FIELDS.map(f => [f, null]))])), null, 2) + '\n');
  return root;
}

async function runAgent(out, agent, command, timeoutMin) {
  const root = path.join(path.resolve(out), safeLabel(agent));
  const { tasks } = JSON.parse(await fs.readFile(path.join(root, '_baseline.json'), 'utf8'));
  const manual = JSON.parse(await fs.readFile(path.join(root, 'manual.json'), 'utf8'));
  for (const entry of tasks) {
    const id = entry.id ?? entry;
    const promptFile = path.join(root, `${id}.prompt.txt`);
    const expanded = command.replaceAll('{promptFile}', JSON.stringify(promptFile));
    const started = Date.now();
    console.log(`[${id}] ${expanded}`);
    const code = await new Promise(resolve => {
      const child = spawn(expanded, { cwd: path.join(root, id), shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BENCH_PROMPT_FILE: promptFile, BENCH_TASK: id } });
      const log = [];
      child.stdout.on('data', b => log.push(b)); child.stderr.on('data', b => log.push(b));
      const timer = setTimeout(() => child.kill(), Number(timeoutMin) * 60_000);
      child.on('close', async exit => { clearTimeout(timer); await fs.writeFile(path.join(root, `${id}.agent.log`), Buffer.concat(log)); resolve(exit); });
    });
    manual[id].durationSeconds = Math.round((Date.now() - started) / 1000);
    manual[id].notes = [manual[id].notes, `automated run exit code ${code}`].filter(Boolean).join('; ');
  }
  await fs.writeFile(path.join(root, 'manual.json'), JSON.stringify(manual, null, 2) + '\n');
}

export async function scoreAgent(root) {
  const { baseline, tasks: entries } = JSON.parse(await fs.readFile(path.join(root, '_baseline.json'), 'utf8'));
  const manual = JSON.parse(await fs.readFile(path.join(root, 'manual.json'), 'utf8').catch(() => '{}'));
  const all = await listTasks(); const byId = new Map(all.map(t => [t.id, t]));
  const results = [];
  for (const entry of entries) {
    const id = entry.id ?? entry;
    const task = byId.get(id) ?? { id, title: id, protected: [], dir: '' };
    const dir = path.join(root, id);
    const current = await hashTree(dir);
    const { verify } = await import(pathToFileURL(path.join(task.dir, 'verify.mjs')).href);
    const outcome = await verify({ task, dir, baseline: baseline[id], current, fixtureDir: path.join(task.dir, 'fixture') });
    const before = baseline[id];
    const changed = Object.keys({ ...before, ...current }).filter(f => before[f] !== current[f]).sort();
    const points = outcome.checks.reduce((s, c) => s + c.points, 0), weight = outcome.checks.reduce((s, c) => s + c.weight, 0);
    results.push({ task: id, title: task.title, bank: entry.bank, tier: entry.tier, score: outcome.skipped ? null : Math.round((points / weight) * 100), points, weight, skipped: outcome.skipped ?? null, checks: outcome.checks, changedFiles: changed, manual: manual[id] ?? {} });
  }
  return results;
}

const cell = value => (value === null || value === undefined || value === '' ? '—' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
export async function score(out) {
  const base = path.resolve(out);
  const agents = [];
  for (const entry of (await fs.readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (await fs.stat(path.join(base, entry.name, '_baseline.json')).then(() => true, () => false)) agents.push({ agent: entry.name, results: await scoreAgent(path.join(base, entry.name)) });
  }
  const tiers = [...new Set(agents.flatMap(a => a.results.map(r => r.tier ?? 'private')))];
  const taskIds = [...new Set(agents.flatMap(a => a.results.map(r => r.task)))];
  const lines = [`# Comparison scoresheet`, '', `Generated ${new Date().toISOString()} on ${os.platform()} ${os.arch()}, Node.js ${process.version}. Automatic scores are 0–100 per task from deterministic checks; manual columns come from each agent's manual.json.`, '',
    `| Task | tier | ${agents.map(a => a.agent).join(' | ')} |`, `| --- | --- | ${agents.map(() => '---:').join(' | ')} |`];
  for (const tier of tiers) {
    const ids = taskIds.filter(id => agents.some(a => a.results.find(r => r.task === id && (r.tier ?? 'private') === tier)));
    for (const id of ids) lines.push(`| ${id} | ${tier} | ${agents.map(a => { const r = a.results.find(x => x.task === id); return r ? (r.skipped ? 'skipped' : r.score) : '—'; }).join(' | ')} |`);
    lines.push(`| **${tier} subtotal (of ${ids.length * 100})** | | ${agents.map(a => `**${a.results.filter(r => (r.tier ?? 'private') === tier).reduce((s, r) => s + (r.score ?? 0), 0)}**`).join(' | ')} |`);
  }
  lines.push(`| **Total (of ${taskIds.length * 100})** | | ${agents.map(a => `**${a.results.reduce((s, r) => s + (r.score ?? 0), 0)}**`).join(' | ')} |`, '');
  lines.push('## Process (manual / recorded)', '', `| Agent | Task | ${MANUAL_FIELDS.join(' | ')} |`, `| --- | --- | ${MANUAL_FIELDS.map(() => '---').join(' | ')} |`);
  for (const a of agents) for (const r of a.results) lines.push(`| ${a.agent} | ${r.task} | ${MANUAL_FIELDS.map(f => cell(r.manual?.[f])).join(' | ')} |`);
  lines.push('', '## Check details', '');
  for (const a of agents) for (const r of a.results) {
    lines.push(`### ${a.agent} · ${r.task} — ${r.skipped ? `skipped (${r.skipped})` : `${r.score}/100`}`, '', `Changed files: ${r.changedFiles.length ? r.changedFiles.map(f => `\`${f}\``).join(', ') : 'none'}`, '', '| Check | Points | Detail |', '| --- | ---: | --- |');
    for (const c of r.checks) lines.push(`| ${c.pass ? '✅' : '❌'} ${cell(c.name)} | ${c.points}/${c.weight} | ${cell(c.detail)} |`);
    lines.push('');
  }
  const csv = ['agent,task,tier,score,points,weight,skipped,' + MANUAL_FIELDS.join(','), ...agents.flatMap(a => a.results.map(r => [a.agent, r.task, r.tier ?? '', r.score ?? '', r.points, r.weight, r.skipped ? 'yes' : '', ...MANUAL_FIELDS.map(f => r.manual?.[f] ?? '')].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')))];
  await fs.writeFile(path.join(base, 'scoresheet.md'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(base, 'scoresheet.csv'), '\uFEFF' + csv.join('\r\n') + '\r\n');
  await fs.writeFile(path.join(base, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: `${os.platform()}-${os.arch()}`, agents }, null, 2) + '\n');
  return agents;
}

/** Median per task (and per manual metric) across repeat runs labeled <base>-1, <base>-2, … */
export async function aggregate(out) {
  const base = path.resolve(out);
  const groups = new Map();
  for (const entry of (await fs.readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!await fs.stat(path.join(base, entry.name, '_baseline.json')).then(() => true, () => false)) continue;
    const match = /^(.*)-(\d+)$/.exec(entry.name);
    const name = match ? match[1] : entry.name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ label: entry.name, results: await scoreAgent(path.join(base, entry.name)) });
  }
  const lines = ['# Repeat-run medians', '', `Generated ${new Date().toISOString()}. Scores are per-task medians across repeat runs; skipped tasks are excluded. Use these instead of single-run scores for comparisons (see README).`, ''];
  const report = [];
  for (const [name, runs] of groups) {
    if (runs.length < 2) { lines.push(`## ${name} — only one run (${runs[0].label}); repeating the same label with -1, -2, … enables medians.`, ''); continue; }
    const taskIds = [...new Set(runs.flatMap(r => r.results.map(x => x.task)))];
    const tierOf = new Map(runs.flatMap(r => r.results.map(x => [x.task, x.tier ?? 'private'])));
    lines.push(`## ${name} — ${runs.length} runs (${runs.map(r => r.label).join(', ')})`, '', `| Task | tier | median score | runs scored | median duration (s) |`, `| --- | --- | ---: | ---: | ---: |`);
    const summary = { agent: name, runs: runs.length, tasks: {} };
    for (const id of taskIds) {
      const scores = runs.map(r => r.results.find(x => x.task === id)).filter(x => x && !x.skipped).map(x => x.score);
      const durations = runs.map(r => Number(r.results.find(x => x.task === id)?.manual?.durationSeconds)).filter(v => Number.isFinite(v));
      summary.tasks[id] = { tier: tierOf.get(id), medianScore: median(scores), runsScored: scores.length, medianDurationSeconds: median(durations) };
      lines.push(`| ${id} | ${tierOf.get(id)} | ${median(scores) ?? '—'} | ${scores.length}/${runs.length} | ${median(durations) ?? '—'} |`);
    }
    const totals = runs.map(r => r.results.reduce((s, x) => s + (x.score ?? 0), 0));
    summary.medianTotal = median(totals);
    lines.push(`| **Total** | | **${median(totals)}** | | |`, '');
    report.push(summary);
  }
  await fs.writeFile(path.join(base, 'aggregate.md'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(base, 'aggregate.json'), JSON.stringify({ generatedAt: new Date().toISOString(), groups: report }, null, 2) + '\n');
  return report;
}

/** Pristine fixtures must score low and the reference solutions must score 100. */
export async function selfTest(filter = {}) {
  const tasks = await selectTasks(filter);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-bench-self-'));
  try {
    await prepare(out, 'pristine', { lang: 'en', tasks: tasks.map(t => t.id).join(',') });
    const solved = await prepare(out, 'reference', { lang: 'en', tasks: tasks.map(t => t.id).join(',') });
    for (const task of tasks) {
      await copyTree(path.join(task.dir, 'reference'), path.join(solved, task.id));
      await runHook(path.join(solved, task.id), task.referenceRun, 'referenceRun');
    }
    const agents = await score(out);
    const problems = [];
    for (const { agent, results } of agents) for (const r of results) {
      if (r.skipped) continue;
      if (agent === 'reference' && r.score !== 100) problems.push(`${r.task} reference scored ${r.score}: ${r.checks.filter(c => !c.pass).map(c => `${c.name} (${c.detail})`).join('; ')}`);
      if (agent === 'pristine' && r.score > 40) problems.push(`${r.task} unsolved fixture scored ${r.score}`);
    }
    return { agents, problems, skipped: agents.flatMap(a => a.results.filter(r => r.skipped).map(r => `${a.agent}/${r.task}: ${r.skipped}`)) };
  } finally { await fs.rm(out, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command] = positionals;
  try {
    if (command === 'prepare') { if (!values.out || !values.agent) fail(usage); console.log(`Prepared ${await prepare(values.out, values.agent, values)}`); }
    else if (command === 'run') { if (!values.out || !values.cmd) fail(usage); await runAgent(values.out, values.agent, values.cmd, values['timeout-min']); }
    else if (command === 'score') {
      if (!values.out) fail(usage);
      const agents = await score(values.out);
      if (values.json) console.log(JSON.stringify(agents, null, 2));
      else for (const a of agents) console.log(`${a.agent}: ${a.results.map(r => `${r.task}=${r.skipped ? 'skipped' : r.score}`).join('  ')}`);
      console.log(`Wrote ${path.join(path.resolve(values.out), 'scoresheet.md')} and scoresheet.csv`);
    } else if (command === 'aggregate') {
      if (!values.out) fail(usage);
      const groups = await aggregate(values.out);
      for (const g of groups) console.log(`${g.agent} (${g.runs} runs): median total ${g.medianTotal}`);
      console.log(`Wrote ${path.join(path.resolve(values.out), 'aggregate.md')}`);
    } else if (command === 'self-test') {
      const { agents, problems, skipped } = await selfTest(values);
      for (const a of agents) console.log(`${a.agent}: ${a.results.map(r => `${r.task}=${r.skipped ? 'skipped' : r.score}`).join('  ')}`);
      for (const s of skipped) console.log(`SKIPPED ${s}`);
      if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
      console.log('Benchmark self-test: PASS');
    } else if (command === 'list') {
      for (const t of await selectTasks(values)) console.log(`${t.tier}\t${t.id}\t${t.title}${t.minutes ? `\t~${t.minutes} min` : ''}`);
    } else fail(usage);
  } catch (error) { console.error(error.message); process.exit(1); }
}
export { benchRoot };
