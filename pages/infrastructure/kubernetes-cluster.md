---
title: "Kubernetes Cluster Setup"
type: infrastructure
tags: [kubernetes, infrastructure, deployment, helm, namespaces]
author: Infrastructure Team
created: 2024-02-01
updated: 2025-02-20
---

# Kubernetes Cluster Setup

All company services run on a managed Kubernetes cluster (GKE). This page covers cluster layout, namespaces, access, and tooling.

## Cluster layout

| Cluster | Purpose |
|---|---|
| `prod` | Production workloads |
| `staging` | Staging and integration testing |
| `dev` | Developer sandbox |

## Namespaces

| Namespace | Contents |
|---|---|
| `atlas` | All [[project-atlas]] services |
| `kafka-prod` / `kafka-staging` / `kafka-dev` | Kafka clusters (managed by [[project-hermes]]) |
| `monitoring` | Prometheus, Grafana, Alertmanager |
| `ingress` | NGINX ingress controller |

## Accessing the cluster

```bash
# Authenticate (requires VPN)
gcloud container clusters get-credentials prod --region europe-west4

# Switch namespace
kubectl config set-context --current --namespace=atlas

# View running pods
kubectl get pods -n atlas
```

## Deploying services

All services are deployed via Helm charts stored in `github.com/company/helm-charts`. See [[deployment-guide]] for the full workflow.

## Resource quotas (atlas namespace)

| Resource | Limit |
|---|---|
| CPU | 40 cores |
| Memory | 80 Gi |
| Pods | 100 |

## Secrets management

Secrets are stored in Google Secret Manager and injected into pods via the GCP Secrets Store CSI driver. Never hardcode secrets in Helm values or Kubernetes manifests.

## Monitoring

All pods export Prometheus metrics on port `8080/actuator/prometheus`. Dashboards are in Grafana — see [[monitoring-and-alerting]].
