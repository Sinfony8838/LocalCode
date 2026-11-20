// scripts/asker.cjs — interactive confirm helper (protected contract).
// Prints exactly one line ('y' or 'n') then exits. Waits for one stdin line;
// answers 'n' after at most 10 seconds even when stdin never speaks.
const WATCHDOG_MS = 10_000;

function answer(line) {
  const text = String(line ?? '').trim().toLowerCase();
  process.stdout.write(text.startsWith('y') ? 'y\n' : 'n\n');
  process.exit(0);
}

const timer = setTimeout(() => answer('n'), WATCHDOG_MS);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const newline = buffer.indexOf('\n');
  if (newline !== -1) {
    clearTimeout(timer);
    answer(buffer.slice(0, newline));
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) { clearTimeout(timer); answer(buffer); }
});
