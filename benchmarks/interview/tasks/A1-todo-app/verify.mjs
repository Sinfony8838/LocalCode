import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck } from '../../../lib/common.mjs';
import { probeNote, runProbe } from '../../../lib/dom-probe.mjs';

// The scenario drives every behaviour in SPEC.md and reports observables.
const SCENARIO = `
const page = loadPage();
const r = {};
r.missingIds = ['new-todo', 'add-todo', 'todo-list', 'todo-count', 'filter-all', 'filter-active', 'filter-completed', 'clear-completed', 'toggle-all'].filter(id => !page.has(id));
r.hasAllIds = r.missingIds.length === 0;

// seeded load from localStorage under the key 'todos'
page.storage.setItem('todos', JSON.stringify([{ title: 'seeded', done: false }]));
const p2 = page.reload();
r.seedRendered = p2.qsa('#todo-list li').some(li => li.textContent.trim().includes('seeded'));
p2.storage.removeItem('todos');
const p3 = p2.reload();

// from here on every helper reads the live page p3
const lis = () => p3.qsa('#todo-list li');
const text = li => li.textContent.trim();
const doneOf = li => li.classList.contains('done');
const clearHidden = () => { try { const el = p3.el('clear-completed'); return el.hidden === true || el.hidden === '' || el.style.display === 'none'; } catch { return true; } };

r.selectedInitial = JSON.stringify(['filter-all', 'filter-active', 'filter-completed'].filter(id => { try { return p3.el(id).classList.contains('selected'); } catch { return false; } }));

// add: trimmed, appended, input cleared, empty ignored, Enter works
await p3.type('new-todo', '  alpha  ');
await p3.click('add-todo');
r.inputCleared = p3.el('new-todo').value === '';
await p3.type('new-todo', 'beta');
await p3.click('add-todo');
await p3.type('new-todo', '   ');
await p3.click('add-todo');
await p3.type('new-todo', 'gamma');
await p3.pressKey('Enter', 'new-todo');
r.addOk = lis().length === 3;
const order = lis().map(text).join('|');
const at = s => order.indexOf(s);
r.orderOk = at('alpha') !== -1 && at('beta') !== -1 && at('gamma') !== -1 && at('alpha') < at('beta') && at('beta') < at('gamma');
r.count3 = p3.text('todo-count');
const li0 = lis()[0];
r.hasToggleAndDestroy = !!li0.querySelector('.toggle') && !!li0.querySelector('.destroy');

// toggle flips done + counter (re-query after each render)
await p3.click(lis()[0].querySelector('.toggle'));
r.doneClass = doneOf(lis()[0]);
r.count2 = p3.text('todo-count');
await p3.click(lis()[0].querySelector('.toggle'));
r.undoneClass = !doneOf(lis()[0]);
r.count3b = p3.text('todo-count');

// destroy removes that item
await p3.click(lis()[1].querySelector('.destroy'));
r.destroyOk = lis().length === 2 && !p3.el('todo-list').textContent.includes('beta');

// filters
await p3.click('filter-active');
r.activeView = lis().length === 2;
await p3.click('filter-completed');
r.completedEmpty = lis().length === 0;
r.selectedExclusive = p3.el('filter-completed').classList.contains('selected') && !p3.el('filter-all').classList.contains('selected') && !p3.el('filter-active').classList.contains('selected');
await p3.click('filter-all');
r.allView = lis().length === 2;
await p3.click(lis()[1].querySelector('.toggle'));
await p3.click('filter-active');
r.activeFiltered = lis().length === 1 && text(lis()[0]).includes('alpha');
await p3.click('filter-completed');
r.completedFiltered = lis().length === 1 && text(lis()[0]).includes('gamma');

// clear completed + hidden when none
await p3.click('filter-all');
r.countBeforeClear = p3.text('todo-count');
await p3.click('clear-completed');
r.clearOk = lis().length === 1 && text(lis()[0]).includes('alpha');
r.countSingle = p3.text('todo-count');
r.clearHiddenWhenNone = clearHidden();

// toggle-all
await p3.type('new-todo', 'delta');
await p3.click('add-todo');
await p3.check('toggle-all', true);
r.allDone = lis().length === 2 && lis().every(doneOf);
r.countZero = p3.text('todo-count');
await p3.check('toggle-all', false);
r.noneDone = lis().every(li => !doneOf(li));

// edit: double-click opens prefilled input; Enter commits trimmed; Escape cancels
await p3.dblclick(lis()[0]);
let editInput = lis()[0].querySelector('input.edit');
r.editOpened = !!editInput && editInput.value.includes('alpha');
if (editInput) {
  await p3.setValue(editInput, '  alpha2  ');
  await p3.pressKey('Enter', editInput);
}
r.editCommitted = !!lis()[0] && text(lis()[0]).includes('alpha2') && !lis()[0].querySelector('input.edit');
await p3.dblclick(lis()[0]);
editInput = lis()[0].querySelector('input.edit');
r.editCancelOpened = !!editInput;
if (editInput) {
  await p3.setValue(editInput, 'zzz');
  await p3.pressKey('Escape', editInput);
}
r.editCancelled = !!lis()[0] && text(lis()[0]).includes('alpha2') && !lis()[0].querySelector('input.edit');

// titles are escaped text, not HTML
await p3.type('new-todo', '<b>bold</b><img src=x onerror="window.__pwned=1">');
await p3.click('add-todo');
r.xssNoElements = p3.count('#todo-list img') === 0 && p3.count('#todo-list b') === 0;
r.xssLiteral = lis().some(li => text(li).includes('<b>bold</b>'));
r.noPwned = p3.window.__pwned === undefined;

// persistence: done state + titles survive reload
await p3.click(lis()[0].querySelector('.toggle'));
const beforeReload = lis().length;
const p4 = p3.reload();
r.persistCount = p4.qsa('#todo-list li').length === beforeReload;
const first = p4.qsa('#todo-list li')[0];
r.persistDone = !!first && doneOf(first);
r.persistText = p4.qsa('#todo-list li').some(li => text(li).includes('alpha2'));
r.persistCountText = p4.text('todo-count');
return r;
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return { checks: [...checks, check('index.html exists', 90, false, 'index.html not found')] };

  const r = await runProbe(SCENARIO, html);
  const note = probeNote(r);
  const ok = (name, weight, key, extra = '') => checks.push(check(name, weight, !note && r[key] === true, note || r[key] === true ? extra : `got ${JSON.stringify(r[key])} ${extra}`.trim()));

  checks.push(check('required element ids present', 4, !note && r.hasAllIds === true, note || `missing: ${JSON.stringify(r.missingIds)}`));
  ok('adds trimmed non-empty items and clears the input', 10, 'addOk');
  ok('new items append in insertion order', 4, 'orderOk');
  ok('each item has toggle and destroy controls', 4, 'hasToggleAndDestroy');
  checks.push(check('toggle flips done class and updates the counter', 8, !note && r.doneClass === true && r.undoneClass === true && r.count2 === '2 items left' && r.count3b === '3 items left', note || `count2=${JSON.stringify(r.count2)}, count3b=${JSON.stringify(r.count3b)}`));
  ok('destroy removes the item', 5, 'destroyOk');
  checks.push(check('counter uses exact item/items wording', 6, !note && r.count3 === '3 items left' && r.countSingle === '1 item left' && r.countZero === '0 items left', note || `count3=${JSON.stringify(r.count3)}, single=${JSON.stringify(r.countSingle)}, zero=${JSON.stringify(r.countZero)}`));
  checks.push(check('filters show the right subsets', 9, !note && r.activeView === true && r.completedEmpty === true && r.allView === true && r.activeFiltered === true && r.completedFiltered === true, note || `active=${r.activeView}, completedEmpty=${r.completedEmpty}, all=${r.allView}, activeF=${r.activeFiltered}, completedF=${r.completedFiltered}`));
  checks.push(check('exactly one filter button selected, all initially', 4, !note && r.selectedInitial === JSON.stringify(['filter-all']) && r.selectedExclusive === true, note || `initial=${r.selectedInitial}, exclusive=${r.selectedExclusive}`));
  checks.push(check('clear-completed removes done items and hides when none', 7, !note && r.clearOk === true && r.clearHiddenWhenNone === true, note || `clear=${r.clearOk}, hidden=${r.clearHiddenWhenNone}`));
  ok('toggle-all completes and uncompletes every item', 6, 'allDone', `noneDone=${r.noneDone}`);
  ok('double-click opens a prefilled edit input', 4, 'editOpened');
  checks.push(check('Enter commits the edited title, Escape cancels', 7, !note && r.editCommitted === true && r.editCancelled === true, note || `commit=${r.editCommitted}, cancel=${r.editCancelled}`));
  checks.push(check('titles are escaped text, not HTML', 6, !note && r.xssNoElements === true && r.xssLiteral === true && r.noPwned === true, note || `noElements=${r.xssNoElements}, literal=${r.xssLiteral}`));
  checks.push(check('items and done state survive a reload (localStorage key todos)', 6, !note && r.seedRendered === true && r.persistCount === true && r.persistDone === true && r.persistText === true, note || `seed=${r.seedRendered}, count=${r.persistCount}, done=${r.persistDone}, text=${r.persistText}`));
  return { checks };
}
