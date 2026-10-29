# Todo list app

Create a single self-contained `index.html` in this folder (inline CSS and JavaScript; no external scripts, stylesheets, fonts or images, and no network requests).

Required elements, all present in the initial HTML:

- `<input id="new-todo">` — text input for a new item's title.
- `<button id="add-todo">` — adds the item typed in `new-todo`.
- `#todo-list` — a `<ul>` or `<ol>` holding one `<li>` per item.
- `<span id="todo-count">` — the number of incomplete items: exactly `1 item left` (singular) or `N items left`.
- `<button id="filter-all">`, `<button id="filter-active">`, `<button id="filter-completed">` — filter the list.
- `<button id="clear-completed">` — deletes every completed item.
- `<input id="toggle-all">` (type `checkbox`) — completes/uncompletes every item.

Behaviour:

1. Clicking `add-todo`, or pressing Enter (keydown) in `new-todo`, appends a new item at the END of the list with the trimmed input value. Empty or whitespace-only input adds nothing. The input is cleared after a successful add.
2. Each `<li>` contains a toggle element with `class="toggle"` (may be a checkbox), a delete element with `class="destroy"`, and the title as visible text. Clicking `toggle` itself flips that item between done and not done (do not rely on label-click forwarding); clicking `destroy` removes the item. A done item's `<li>` has `done` in its class list.
3. `#todo-count` always reflects the incomplete count.
4. Exactly one of the three filter buttons has the class `selected` at any time; `filter-all` is selected initially. `filter-active` shows only unfinished items, `filter-completed` only finished ones, `filter-all` shows all items in insertion order.
5. `clear-completed` removes all completed items. When there are none, the button must not be visible (use the `hidden` attribute, `display: none`, or remove it from the DOM).
6. Checking `toggle-all` marks every item done; unchecking it marks every item not done.
7. Double-clicking an item's `<li>` starts editing: the `<li>` then contains an `<input class="edit">` prefilled with the item's title. Enter (keydown) commits the trimmed new title (a trimmed-empty value commits nothing), Escape cancels and leaves the title unchanged. After either key the `<li>` contains no `.edit` input.
8. Titles render as text, never as HTML: adding the title `<b>bold</b><img src=x onerror="alert(1)">` must display those literal characters and must not create `b` or `img` elements inside `#todo-list`.
9. Items, including their done state, survive a page reload via `localStorage` under the key `todos`.
