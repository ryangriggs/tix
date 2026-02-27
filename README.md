# tix
Trouble ticket system built with Claude Code
See .env.example for configuration options.

Email transports supported:
- mailgun
- smtp (direct)
- Google mail API

Incoming message transports:
- mailgun API endpoint
- direct SMTP (listener)

To set up auto-versioning:
One-time setup note: The git config command is already done, but if you clone the repo fresh on another machine, run: git config core.hooksPath .githooks && chmod +x .githooks/pre-commit