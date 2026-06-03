---
title: "Deployment Guide"
type: infrastructure
tags: [deployment, kubernetes, helm, ci-cd, github-actions, project-atlas]
author: Infrastructure Team
created: 2024-03-15
updated: 2025-02-12
---

# Deployment Guide

This guide covers how to deploy services in [[project-atlas]] to the [[kubernetes-cluster]].

## Overview

All services use the same pipeline:

```
git push → GitHub Actions → Docker build → push to GCR → Helm upgrade
```

## CI/CD pipeline

Each service repo contains a `.github/workflows/deploy.yml` that:

1. Runs tests (`mvn test`)
2. Builds a Docker image (`eclipse-temurin:21-jre` base)
3. Pushes to GCR (`europe-west4-docker.pkg.dev/company/atlas/<service>:<sha>`)
4. Runs `helm upgrade --install` against the target cluster

Merging to `main` deploys to **staging** automatically. Deploying to **production** requires a manual approval step in GitHub Actions.

## Helm charts

Charts live in `github.com/company/helm-charts/charts/<service-name>/`. The values files per environment are in `values/prod.yaml` and `values/staging.yaml`.

To deploy manually:

```bash
helm upgrade --install <service-name> ./charts/<service-name> \
  -f values/prod.yaml \
  --set image.tag=<git-sha> \
  --namespace atlas
```

## Rolling deployments

All services use `RollingUpdate` with `maxUnavailable: 0` and `maxSurge: 1`. This means zero-downtime deploys for any Spring Boot service that exposes a `/actuator/health` readiness probe.

## Rollback

```bash
helm rollback <service-name> --namespace atlas
```

This reverts to the previous Helm release. Check [[monitoring-and-alerting]] dashboards after rolling back to confirm recovery.

## Environment variables and secrets

- Non-sensitive config: Helm values (`values/prod.yaml`)
- Secrets: Google Secret Manager, mounted via CSI driver

Never put secrets in `values/prod.yaml` or commit them to git.

## Smoke testing after deploy

Each service has a `/actuator/health` endpoint. After deploy, verify:

```bash
kubectl rollout status deployment/<service-name> -n atlas
curl https://api.company.com/api/v1/<service>/actuator/health
```
