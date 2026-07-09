# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you
notify AWS Security via our
[vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/)
or directly via email to aws-security@amazon.com.

**Please do not create a public GitHub issue for security vulnerabilities.**

## Scope and Intent

This repository contains **sample code** intended to demonstrate how to deploy
LiteLLM as a model gateway in front of Amazon Bedrock on Amazon EKS. It is meant
for learning and as a starting point — not as a drop-in production system.

Before deploying any part of this sample into your own environment, review it
against your organization's security requirements. In particular:

- **Network exposure** — the sample defaults to an internal (private) load
  balancer. Exposing the gateway to the public internet requires an ACM
  certificate (HTTPS), and the code intentionally rejects `0.0.0.0/0` ingress
  rules. Keep these guardrails in place unless you fully understand the impact.
- **Secrets** — the LiteLLM master key and database credentials are sourced from
  AWS Secrets Manager / Kubernetes Secrets via environment variables. Never
  hardcode secrets, and rotate any credentials used during testing.
- **IAM** — the sample uses least-privilege roles (Bedrock invoke scoped to
  specific model/inference-profile ARNs; `sts:AssumeRole` scoped to the tenant
  role). Review and tighten these for your account before use.
- **Data** — the sample stores no customer data, PII, or PHI. If you extend it
  to do so, apply the appropriate controls.

See the [README](README.md) Security section for the full guardrail list.
