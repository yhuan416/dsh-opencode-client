## Summary

<!-- What changed and why? One concern per PR. -->

## Track

- [ ] observe (board / insights / attention / cost)
- [ ] delegate (tools / provider / delegation)
- [ ] core / transport / compatibility
- [ ] docs / repository metadata

## Verification

- [ ] `npm run check` passes (131 tests)
- [ ] Live e2e run when a runtime path changed — result:
- [ ] `npm run manifest` passes for version/changelog changes
- [ ] UI change attached as a screenshot (redacted if needed)

## Compatibility / SemVer

- [ ] No public surface change
- [ ] Tool, route, config or UI-visible change; docs updated
- [ ] Breaking change; described in CHANGELOG and COMPATIBILITY

## Checklist

- [ ] CHANGELOG.md updated for user-visible changes
- [ ] README.md / README.zh.md or `docs/` updated when behavior changed
- [ ] No passwords, tokens, private hostnames or personal data in the diff/screenshots
- [ ] Commits are rebased and history is linear (squash merge)
