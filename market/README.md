# dshmarket entry

This directory keeps the local source of truth for the plugin's
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) entry.

- `yhuan416__dsh-opencode-client.yml` — copy this file to
  `data/plugins/yhuan416__dsh-opencode-client.yml` in an awesome-dsh-plugin PR.
- The entry file carries no install command: the generated card prefers a **verified npm name**
  (`dsh plugin --profile web add dsh-opencode-client`) and falls back to a git spec. The package is
  on npm since `1.1.4`, so the catalog's npm probe fills `npm` / `version` / `downloads` on its next
  build and the card switches to the npm command.
- Upstream rules this file must keep satisfying (`scripts/check-submission.mjs` and
  `contributing.md`): filename equals the slug of `url`; `name` is `owner/repo`; `category` is one of
  the published values; `description.en` is one line that ends with a period and states what the
  plugin does (no superlatives — a maintainer checks every claim against the code); `description.zh`
  is optional; `icon` is a GitHub-hosted raster (180×180 PNG here, the market renders ~96px). A
  description containing `: ` must be quoted — ours uses the full-width `：` in Chinese, so it does not.
- The icon is `docs/assets/icon-180.png` (180×180 PNG; the market does not accept SVG).
- The market catalog is generated from awesome-dsh-plugin; changing the file here **does not**
  list the plugin. It only becomes visible after the upstream PR is merged and the daily catalog
  refresh runs.
- Do not edit the generated upstream READMEs, and do not open plugin-entry PRs against
  [`dsh-market/dsh-market`](https://github.com/dsh-market/dsh-market).
