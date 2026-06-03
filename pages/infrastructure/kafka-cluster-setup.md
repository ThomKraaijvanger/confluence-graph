---
title: "Kafka Cluster Setup"
type: infrastructure
tags: [kafka, infrastructure, kubernetes, strimzi, project-hermes]
author: Infrastructure Team
created: 2024-06-01
updated: 2025-01-30
---

# Kafka Cluster Setup

Kafka clusters for [[project-hermes]] run on [[kubernetes-cluster]] via the **Strimzi** operator. This page covers how the clusters are configured and operated.

## Operator

We use Strimzi 0.39 to manage Kafka as a Kubernetes-native resource. The operator is installed cluster-wide and watches all namespaces.

## Cluster configuration

Each cluster is defined as a `Kafka` custom resource. Key settings:

```yaml
spec:
  kafka:
    replicas: 3
    storage:
      type: persistent-claim
      size: 500Gi
      class: premium-rwo
    config:
      default.replication.factor: 3
      min.insync.replicas: 2
      log.retention.hours: 168   # 7 days default
  zookeeper:
    replicas: 3
```

## Topic management

Topics are created via `KafkaTopic` custom resources, not manually via CLI. All topic definitions live in `github.com/company/hermes-config`. See [[kafka-topics-overview]] for the current topic inventory.

## Schema registry

Confluent Schema Registry runs as a separate deployment in each Kafka namespace. Avro schemas are registered per topic on first producer startup (auto-registration is enabled in dev/staging, disabled in prod — schemas must be registered explicitly in prod).

## Monitoring

Kafka JMX metrics are scraped by Prometheus and visualised in Grafana. Key metrics to watch:

- Consumer lag per consumer group (alert at > 10k messages)
- Under-replicated partitions (alert at > 0)
- DLQ depth per consumer group

See [[monitoring-and-alerting]] for dashboard links and alert runbooks.

## Upgrading Kafka

1. Upgrade Strimzi operator first (follow Strimzi upgrade guide).
2. Update the `Kafka` CR with the new `kafka.version`.
3. Strimzi performs a rolling restart — no downtime if `min.insync.replicas: 2` is respected.
