# Expense tracker

Create a single self-contained `index.html` in this folder (inline CSS and JavaScript; no external scripts, stylesheets, fonts or images, and no network requests).

Categories are fixed: `Food`, `Transport`, `Housing`, `Other`.

Required elements, all present in the initial HTML:

- `<input id="exp-desc">` — description of a new expense.
- `<input id="exp-amount">` — amount of a new expense (plain number text).
- `<select id="exp-category">` — exactly four options, values `Food`, `Transport`, `Housing`, `Other`.
- `<input id="exp-date">` — expense date as `YYYY-MM-DD` text.
- `<button id="add-expense">` — adds the expense described by the four fields above.
- `#expense-list` — a `<ul>` or `<ol>` holding one `<li>` per expense.
- `<span id="expense-count">` — exactly `N records` (always plural, e.g. `0 records`, `1 records`).
- `<span id="total-amount">` — the total of ALL records, regardless of the category filter.
- `<select id="category-filter">` — options with values `all`, `Food`, `Transport`, `Housing`, `Other` (value `all` selected initially).
- `#cat-totals` — per-category totals: one line per category that has money, in the category order `Food, Transport, Housing, Other`, each formatted exactly like `Food: ¥12.50`. Categories with no records are not listed.
- `<p id="empty-message">` — shown (non-empty text) when there are no records; hidden (`hidden` attribute, `display: none`, or empty) otherwise.

Behaviour:

1. Clicking `add-expense` appends a new record at the END of the list and clears the description and amount inputs. A record's `<li>` shows the description, the category, the date (as `YYYY-MM-DD`), and the formatted amount.
2. Validation — an add attempt must be ignored (no record, count unchanged) when: the trimmed description is empty; the amount is not a valid positive number (`0`, `-5`, `abc` and empty are all invalid).
3. Money formatting — every displayed amount uses `¥` with thousands separators and exactly two decimals, e.g. `¥8.00`, `¥12.50`, `¥1,234.50`.
4. Rounding — amounts with more than two decimals are rounded half-up to two decimals: entering `12.345` must display `¥12.35` (not `¥12.34`). Totals are computed without floating-point drift.
5. Clicking the element with `class="destroy"` inside an `<li>` deletes that record; the list, count and total update.
6. Changing `category-filter` shows only records of that category (value `all` shows every record in insertion order). `#total-amount` and `#cat-totals` are unaffected by the filter.
7. Records survive a page reload via `localStorage` under the key `expenses`.
