---
title: "Project Hermes — Messaging Infrastructure"
type: project
tags: [project, kafka, messaging, infrastructure, kubernetes]
author: Infrastructure Team
created: 2024-06-01
updated: 2025-02-15
---

# Project Hermes — Messaging Infrastructure

Project Hermes owns the company's Kafka infrastructure. It provides managed Kafka topics, consumer group monitoring, schema registry, and the internal tooling around event-driven communication.

## Scope

- Kafka cluster setup and operations (see [[kafka-cluster-setup]])
- Topic provisioning and naming conventions (see [[kafka-topics-overview]])
- Schema registry and Avro schema governance
- Consumer lag alerting (see [[monitoring-and-alerting]])
- Dead-letter queue (DLQ) standards

## Kafka Clusters

| Cluster | Namespace | Purpose |
|---|---|---|
| `hermes-prod` | `kafka-prod` | All production workloads |
| `hermes-staging` | `kafka-staging` | Staging and integration testing |
| `hermes-dev` | `kafka-dev` | Local developer testing |

All clusters run on [[kubernetes-cluster]] via the Strimzi operator.

## Consumers and producers in Atlas

The [[order-service]] produces events on `orders.*` topics. The [[notification-service]] and [[inventory-service]] consume from these. See [[kafka-topics-overview]] for the full map.

## Team

- Infra lead: Amir Hassan
- Kafka engineer: Yuki Tanaka
