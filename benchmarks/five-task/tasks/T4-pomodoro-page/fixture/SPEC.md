# Pomodoro timer page

Create a single self-contained `index.html` in this folder (inline CSS and JavaScript; no external scripts, stylesheets, fonts or images, and no network requests).

Required behaviour:

1. The page title is `Pomodoro`.
2. An element with `id="time"` shows the remaining time as `MM:SS`, starting at `25:00`.
3. A button with `id="start"` starts counting down once per second. Clicking it again while running must not speed up the countdown.
4. A button with `id="pause"` stops the countdown; `start` resumes from the paused value.
5. A button with `id="reset"` stops the countdown and shows `25:00` again.
6. When the countdown reaches `00:00` it stops there and an element with `id="status"` shows `Break time!`.
7. The layout is readable on a 360 px wide screen and buttons have visible labels.
