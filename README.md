# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/GeoXTen/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/GeoXTen/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer whose parse(markdown) returns, for every input, exactly the HTML that marked 18.1.3 renders with its default options — only faster. parse.js is a fork of marked (MIT, see LICENSE and NOTICE) restructured for a fixed option set: all grammar regexes are compiled once at module load, the block and inline scanners dispatch on the current character and run only the tokenizers that could match there, masking passes are skipped when their trigger characters are absent, and nothing is cached between calls. main.ts is the harness driver: it reads /input/cases.json, renders each case with parse, and writes /output/html.json.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=428w36pc&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
