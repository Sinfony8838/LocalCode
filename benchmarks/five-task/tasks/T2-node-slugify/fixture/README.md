# slug-bench

`slugify(title, { maxLength = 60, fallback = 'untitled' } = {})` turns a title into a URL slug.

| Input | Output |
| --- | --- |
| `Hello, World!` | `hello-world` |
| `  Crème Brûlée -- Recipe  ` | `creme-brulee-recipe` |
| `C++ & Rust: 2026 edition` | `c-rust-2026-edition` |
| `你好` | `untitled` |
| `slugify('one two three four', { maxLength: 12 })` | `one-two` |

When truncation cannot land on a hyphen boundary (a single long word), cut at `maxLength` exactly. Run the tests with `npm test` (Node.js 20 or newer).
