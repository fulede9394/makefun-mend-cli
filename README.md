# mend

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fulede9394/makefun-mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fulede9394/makefun-mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files, in one
of four formats: a unified diff, SEARCH/REPLACE blocks, the V4A patch format,
or text-editor tool calls as JSON. It finds the lines each edit names at the
first of three matching tiers (exact, trailing-whitespace tolerant,
whitespace tolerant) and writes every change or none.

Built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory;
  with no `PATCH`, or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22, standard library only. `runner.ts` is the kit's trial runner, kept
as it is.
