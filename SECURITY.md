# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `1.0.x` | ✅ current |
| `0.7.x` and older | ❌ upgrade to 1.0.x |

Only OpenCode **2.x** servers are supported. v1 servers are rejected by the transport.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately to **yhuan416@foxmail.com** with the subject
`[security] dsh-opencode-client` and include:

- affected version / commit,
- a minimal reproduction (server type, config shape, dsh and OpenCode versions),
- impact and any suggested fix,
- whether you want public credit.

If GitHub private vulnerability reporting is enabled for this repository, you may also use
**Security → Report a vulnerability**. Either channel reaches the maintainer; please do not use
both.

You will get an acknowledgement as soon as practical. This is a volunteer project, so response
times are best effort; there is no bug bounty.

## Scope

In scope:

- credential leakage (OpenCode server password, dsh launch token, auth headers),
- SSRF or arbitrary URL/path access through server configuration, `pathMap` or workspace tools,
- command or argument injection through the shell / file / prompt paths,
- permission or approval bypass in the dsh interaction bridge,
- cross-origin or proxy issues in the embedded OpenCode Web UI,
- secrets or tokens written to logs, screenshots, fixtures or release artifacts.

Out of scope:

- vulnerabilities in OpenCode itself or in `@opencode/client` — report those upstream,
- vulnerabilities in dsh itself — report those to the dsh project,
- a misconfigured server that is intentionally exposed without a password,
- denial of service caused by an unbounded local configuration.

## Handling credentials

The plugin stores the OpenCode server password in the dsh profile configuration and uses it for
HTTP Basic auth. It must never appear in:

- logs or error messages,
- issue bodies, PR descriptions or screenshots,
- test fixtures, examples or committed config files.

`OPENCODE_SERVER_PASSWORD` is the expected environment variable for local live tests. Use a
disposable password for test servers and rotate it if it was ever exposed.
