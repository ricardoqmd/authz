# Security Policy

## Supported versions

Until `1.0.0`, only the latest published `0.x` minor receives fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[security advisory](https://github.com/ricardoqmd/authz/security/advisories/new) form
rather than opening a public issue.

Include what you can reproduce, the affected version and the impact you believe it has.
You will get an acknowledgement within a few days.

## Scope

This library computes what a user interface may render. It is **advisory by design**: the
enforcement point is the application's backend, which re-decides every action. A finding
that requires the backend to skip its own check is out of scope — but a finding where this
library **fails open**, leaks a decision across authorization contexts, or lets a client
assert its own subject or role is exactly in scope, and is treated as a defect of the first
order.
