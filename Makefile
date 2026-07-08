# Makefile — sample-litellm-bedrock-gateway-on-eks
#
# Thin wrappers over the npm scripts + local-verify shell scripts.
# Run `make help` for the full target list.
#
# SAFETY: `verify-local`, `verify-local-k8s`, `verify-localstack` and `teardown`
# are designed to leave ZERO residue on your machine — every local resource
# (docker compose stacks + volumes, built images, kind/OrbStack clusters,
# localstack container) is torn down on exit, on success OR failure.
# `make deploy` / `make destroy` are the ONLY targets that touch REAL AWS.

# Use bash for recipes so `set -euo pipefail`-style scripts behave predictably.
SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help install build synth test test-unit test-snapshot configure \
        verify-local verify-local-k8s verify-localstack teardown \
        preflight deploy destroy clean

## help: List available targets.
help:
	@echo "sample-litellm-bedrock-gateway-on-eks — make targets"
	@echo ""
	@echo "  Build / test (no cloud, no cost):"
	@echo "    install            npm install"
	@echo "    build              compile TypeScript (tsc)"
	@echo "    synth              cdk synth"
	@echo "    test               run full jest suite"
	@echo "    test-unit          run unit tests only"
	@echo "    test-snapshot      run snapshot tests only"
	@echo "    configure          interactive config generator"
	@echo ""
	@echo "  Local verification (free, auto-teardown, ZERO residue):"
	@echo "    verify-local       free local layers, then tears everything down"
	@echo "    verify-local-k8s   same + local k8s (OrbStack/kind), then tears down"
	@echo "    verify-localstack  localstack-based checks, then tears down"
	@echo "    teardown           nuke ANY lingering local residue (safe to re-run)"
	@echo ""
	@echo "  REAL AWS (costs money — non-prod account only):"
	@echo "    preflight          pre-deploy checks (creds/region/bootstrap/models/quota)"
	@echo "    deploy             preflight, then cdk deploy (confirmation warning first)"
	@echo "    destroy            one-command teardown (idempotent, GuardDuty-safe)"
	@echo ""
	@echo "  Housekeeping:"
	@echo "    clean              rm -rf cdk.out coverage node_modules/.cache"

## install: Install npm dependencies.
install:
	npm install

## build: Compile TypeScript via tsc.
build:
	npm run build

## synth: Synthesize CloudFormation (cdk synth).
synth:
	npm run synth

## test: Run the full jest test suite.
test:
	npm test

## test-unit: Run unit tests only.
test-unit:
	npm run test:unit

## test-snapshot: Run snapshot tests only.
test-snapshot:
	npm run test:snapshot

## configure: Run the interactive configuration generator.
configure:
	npm run configure

## verify-local: Free local layers; auto-teardown leaves ZERO residue.
verify-local:
	bash scripts/verify-local.sh

## verify-local-k8s: Local verify incl. local k8s; auto-teardown leaves ZERO residue.
verify-local-k8s:
	bash scripts/verify-local.sh --k8s

## verify-localstack: LocalStack-based checks; auto-teardown leaves ZERO residue.
verify-localstack:
	bash scripts/verify-localstack.sh

## teardown: Nuke any local residue (docker/images/clusters/localstack).
teardown:
	bash scripts/teardown-local.sh

## preflight: Pre-deploy fail-fast checks (creds/region/bootstrap/models/quota).
preflight:
	bash scripts/preflight.sh

## deploy: Deploy to REAL AWS (runs preflight first; cost + non-prod warning).
deploy: preflight
	@echo "=============================================================="
	@echo " WARNING: 'make deploy' provisions REAL AWS resources."
	@echo " This WILL incur cost (EKS, Aurora Serverless v2, ALB, NAT)."
	@echo " Use a NON-PRODUCTION account. Ctrl-C now to abort."
	@echo "=============================================================="
	@echo "Continuing in 5s..."
	@sleep 5
	npm run deploy

## destroy: Tear down the REAL AWS deployment (one-command, idempotent, GuardDuty-safe).
destroy:
	bash scripts/destroy.sh

## clean: Remove build/test artifacts and caches.
clean:
	rm -rf cdk.out coverage node_modules/.cache
