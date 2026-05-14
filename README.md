# 🦞 OpenClaw — Brightfire Fork

This is [Brightfire's](https://brightfire.net) production fork of [OpenClaw](https://github.com/openclaw/openclaw), rebased on upstream stable releases with the following patches:

- **Cross-Gateway (XGW)** — session routing across gateway boundaries with Ed25519 signing, async callbacks, and fleet peer registry
- **Slack Markdown** — standard Markdown instead of Slack's `mrkdwn` dialect for cross-surface consistency
- **Context estimation fixes** — corrected token estimation for tool results and compaction, cache write TTL costing, and per-message cache cost tracking
- **Context window min cap** — prevents over-aggressive compaction on small context windows
- **Session reset prompt** — custom reset behavior
- **Control UI title** — branded control interface
- **XGW inbound auth** — authentication layer for cross-gateway endpoints

Current base: `v2026.5.7` · Patches tracked in [`BRIGHTFIRE_PATCHES.md`](BRIGHTFIRE_PATCHES.md)
