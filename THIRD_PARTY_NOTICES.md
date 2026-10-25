# Third-party notices

Approval rules, strict PowerShell parsing, and goal lifecycle adaptations introduced in 0.2.0 have additional MIT and Apache-2.0 notices. See [the detailed source notices](LocalCode/source/THIRD_PARTY_NOTICES.md); fixed upstream reference copies and their original LICENSE/NOTICE files are retained under `LocalCode/source/third_party/`. No private desktop artwork is added by this feature.

The MIT license at the repository root covers LocalCode source code and these deployment helpers. It does not relicense third-party dependencies, models, trademarks, or user-imported artwork.

| Component | Source | License / handling |
| --- | --- | --- |
| pi SDK 1.4.0 | [earendil-works/pi](https://github.com/earendil-works/pi) | MIT; installed through npm with locked integrity |
| Electron | [electron/electron](https://github.com/electron/electron) | MIT plus Chromium and bundled component notices; preserve `LICENSE` and `LICENSES.chromium.html` in locally packaged output |
| React / TypeScript / Vite / other npm packages | See `LocalCode/source/package-lock.json` and installed package notices | Each retains its upstream license; no vendored `node_modules` in Git |
| Ollama 0.40.10 | [official release](https://github.com/ollama/ollama/releases/tag/v0.40.10) | MIT and bundled library notices; downloaded locally, not redistributed here |
| Node.js 24.14.0 | [official distribution](https://nodejs.org/dist/v24.14.0/) | Node.js and bundled component licenses included in the portable ZIP |
| Qwen3.5 9B Q4_K_M | [model page and license](https://ollama.com/library/qwen3.5:9b-q4_K_M) | Apache-2.0 on the model page at review; weights downloaded by Ollama, not distributed in Git |

Alternative models have their own terms. Review them before downloading, using commercially or redistributing. Original private desktop character artwork was deliberately excluded because public redistribution permission was not established. The open-source application includes only an optional atlas importer with neutral slot labels. Users must hold appropriate rights to their imported art.
