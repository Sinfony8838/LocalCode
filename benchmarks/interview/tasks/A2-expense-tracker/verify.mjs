import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck } from '../../../lib/common.mjs';
import { probeNote, runProbe } from '../../../lib/dom-probe.mjs';

const SCENARIO = `
const page = loadPage();
const r = {};
r.missingIds = ['exp-desc', 'exp-amount', 'exp-category', 'exp-date', 'add-expense', 'expense-list', 'expense-count', 'total-amount', 'category-filter', 'cat-totals', 'empty-message'].filter(id => !page.has(id));
r.hasAllIds = r.missingIds.length === 0;

const lis = () => page.qsa('#expense-list li');
const listText = () => lis().map(li => li.textContent).join('|');
const liOf = desc => lis().find(li => li.textContent.includes(desc)) || null;

// empty state
const emptyEl = page.el('empty-message');
r.emptyShown = emptyEl.hidden !== true && emptyEl.hidden !== '' && emptyEl.style.display !== 'none' && emptyEl.textContent.trim() !== '';
r.total0 = page.text('total-amount');
r.count0 = page.text('expense-count');

// validation: empty desc, zero, negative, non-numeric
await page.type('exp-desc', '   ');
await page.type('exp-amount', '10');
await page.click('add-expense');
r.rejEmptyDesc = lis().length === 0;
await page.clear('exp-desc');
await page.type('exp-desc', 'Lunch');
await page.clear('exp-amount');
await page.type('exp-amount', '0');
await page.click('add-expense');
r.rejZero = lis().length === 0;
await page.clear('exp-amount');
await page.type('exp-amount', '-5');
await page.click('add-expense');
r.rejNegative = lis().length === 0;
await page.clear('exp-amount');
await page.type('exp-amount', 'abc');
await page.click('add-expense');
r.rejNaN = lis().length === 0;

// adds
const addExpense = async (desc, amount, category, date) => {
  await page.clear('exp-desc');
  await page.type('exp-desc', desc);
  await page.clear('exp-amount');
  await page.type('exp-amount', amount);
  await page.setValue('exp-category', category);
  await page.setValue('exp-date', date);
  await page.click('add-expense');
};
await addExpense('Lunch', '12.5', 'Food', '2026-01-15');
await addExpense('Bus', '3.75', 'Transport', '2026-01-16');
await addExpense('Rent', '1234.5', 'Housing', '2026-01-31');
await addExpense('Coffee', '8', 'Food', '2026-02-02');
await addExpense('Snack', '12.345', 'Food', '2026-02-03');
r.addOk = lis().length === 5;
r.inputsCleared = page.el('exp-desc').value === '' && page.el('exp-amount').value === '';
const order = listText();
const at = s => order.indexOf(s);
r.orderOk = at('Lunch') !== -1 && at('Lunch') < at('Bus') && at('Bus') < at('Rent') && at('Rent') < at('Coffee') && at('Coffee') < at('Snack');
r.count5 = page.text('expense-count');
const lunchLi = liOf('Lunch');
r.fmtLunch = !!lunchLi && lunchLi.textContent.includes('¥12.50');
r.dateShown = !!lunchLi && lunchLi.textContent.includes('2026-01-15');
const rentLi = liOf('Rent');
r.fmtRent = !!rentLi && rentLi.textContent.includes('¥1,234.50');
const coffeeLi = liOf('Coffee');
r.fmtCoffee = !!coffeeLi && coffeeLi.textContent.includes('¥8.00');
const snackLi = liOf('Snack');
r.rounded = !!snackLi && snackLi.textContent.includes('¥12.35') && !snackLi.textContent.includes('¥12.34');
r.total = page.text('total-amount');
r.catTotalsText = page.el('cat-totals').textContent;
r.catTotals = r.catTotalsText.includes('Food: ¥32.85') && r.catTotalsText.includes('Transport: ¥3.75') && r.catTotalsText.includes('Housing: ¥1,234.50') && !r.catTotalsText.includes('Other:');

// delete
const busLi = liOf('Bus');
if (busLi) await page.click(busLi.querySelector('.destroy'));
r.deleteOk = lis().length === 4 && !listText().includes('Bus');
r.totalAfterDelete = page.text('total-amount');
r.count4 = page.text('expense-count');

// category filter
await page.setValue('category-filter', 'Food');
r.filterFood = lis().length === 3 && listText().includes('Lunch') && !listText().includes('Bus') && !listText().includes('Rent');
r.totalUnfiltered = page.text('total-amount');
await page.setValue('category-filter', 'Housing');
r.filterHousing = lis().length === 1 && listText().includes('Rent');
await page.setValue('category-filter', 'all');
r.filterAll = lis().length === 4;

// persistence
const p2 = page.reload();
r.persistCount = p2.qsa('#expense-list li').length === 4;
r.persistTotal = p2.text('total-amount');
r.persistRounded = p2.qsa('#expense-list li').some(li => li.textContent.includes('¥12.35'));
return r;
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return { checks: [...checks, check('index.html exists', 90, false, 'index.html not found')] };

  const r = await runProbe(SCENARIO, html);
  const note = probeNote(r);
  const ok = (name, weight, pass, extra = '') => checks.push(check(name, weight, !note && pass === true, note || (pass === true ? extra : `got ${JSON.stringify(pass)} ${extra}`.trim())));

  checks.push(check('required element ids present', 4, !note && r.hasAllIds === true, note || `missing: ${JSON.stringify(r.missingIds)}`));
  checks.push(check('empty state shows a message with zero totals', 6, !note && r.emptyShown === true && r.total0 === '¥0.00' && r.count0 === '0 records', note || `shown=${r.emptyShown}, total=${JSON.stringify(r.total0)}, count=${JSON.stringify(r.count0)}`));
  checks.push(check('rejects empty description, zero, negative and non-numeric amounts', 10, !note && r.rejEmptyDesc === true && r.rejZero === true && r.rejNegative === true && r.rejNaN === true, note || `empty=${r.rejEmptyDesc}, zero=${r.rejZero}, neg=${r.rejNegative}, nan=${r.rejNaN}`));
  checks.push(check('adds records in order and clears the inputs', 9, !note && r.addOk === true && r.inputsCleared === true && r.orderOk === true, note || `add=${r.addOk}, cleared=${r.inputsCleared}, order=${r.orderOk}`));
  checks.push(check('each record shows description, category, date and amount', 6, !note && r.dateShown === true && r.fmtLunch === true, note || `date=${r.dateShown}, amount=${r.fmtLunch}`));
  checks.push(check('money format: thousands separator and two decimals', 8, !note && r.fmtRent === true && r.fmtCoffee === true, note || `rent=${r.fmtRent}, coffee=${r.fmtCoffee}`));
  checks.push(check('rounds half-up to two decimals (12.345 → ¥12.35)', 6, !note && r.rounded === true, note || `got ${r.rounded}`));
  checks.push(check('counter uses exact "N records" wording', 3, !note && r.count5 === '5 records' && r.count4 === '4 records', note || `count5=${JSON.stringify(r.count5)}, count4=${JSON.stringify(r.count4)}`));
  checks.push(check('total sums every record exactly', 10, !note && r.total === '¥1,271.10' && r.totalAfterDelete === '¥1,267.35' && r.totalUnfiltered === '¥1,267.35', note || `total=${JSON.stringify(r.total)}, afterDelete=${JSON.stringify(r.totalAfterDelete)}, unfiltered=${JSON.stringify(r.totalUnfiltered)}`));
  checks.push(check('destroy deletes the record and updates everything', 6, !note && r.deleteOk === true, note || `got ${r.deleteOk}`));
  checks.push(check('category filter narrows the list without touching totals', 8, !note && r.filterFood === true && r.filterHousing === true && r.filterAll === true, note || `food=${r.filterFood}, housing=${r.filterHousing}, all=${r.filterAll}`));
  checks.push(check('per-category totals are exact and ordered', 10, !note && r.catTotals === true, note || `${JSON.stringify(r.catTotalsText).slice(0, 200)}`));
  checks.push(check('records survive a reload (localStorage key expenses)', 10, !note && r.persistCount === true && r.persistTotal === '¥1,267.35' && r.persistRounded === true, note || `count=${r.persistCount}, total=${JSON.stringify(r.persistTotal)}, rounded=${r.persistRounded}`));
  return { checks };
}
