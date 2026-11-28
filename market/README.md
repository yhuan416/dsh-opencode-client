# dshmarket entry

This directory keeps the local source of truth for the plugin's
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) entry.

- `yhuan416__dsh-opencode-client.yml` — copy this file to
  `data/plugins/yhuan416__dsh-opencode-client.yml` in an awesome-dsh-plugin PR.
- The entry file carries no install command: the generated card prefers a **verified npm name**
  (`dsh plugin --profile web add dsh-opencode-client`) and falls back to a git spec. Publishing the
  package to npm is what lets the catalog's npm probe fill `npm` / `version` / `downloads`; until
  then the card keeps the `github:` command and those fields stay `null`.
- The icon is `docs/assets/icon-180.png` (180×180 PNG; the market does not accept SVG).
- The market catalog is generated from awesome-dsh-plugin; changing the file here **does not**
  list the plugin. It only becomes visible after the upstream PR is merged and the daily catalog
  refresh runs.
- Do not edit the generated upstream READMEs, and do not open plugin-entry PRs against
  [`dsh-market/dsh-market`](https://github.com/dsh-market/dsh-market).
