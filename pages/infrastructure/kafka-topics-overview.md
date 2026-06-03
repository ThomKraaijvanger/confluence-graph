---
title: "Kafka Topics Overview"
type: infrastructure
tags: [kafka, messaging, topics, event-driven, project-hermes, project-atlas]
author: Infrastructure Team
created: 2024-06-05
updated: 2025-02-18
---

# Kafka Topics Overview

This page is the single source of truth for all Kafka topics in use across [[project-atlas]] and [[project-hermes]].

## Naming convention

```
<domain>.<event-type>
```

Examples: `orders.placed`, `orders.shipped`, `inventory.stock-updated`

All schemas are registered in the Strimzi schema registry at `http://schema-registry.kafka-prod:8081`.

## Topic inventory

### Orders domain (`orders.*`)

Produced by [[order-service]].

| Topic | Producers | Consumers | Retention |
|---|---|---|---|
| `orders.placed` | order-service | inventory-service, notification-service | 7 days |
| `orders.confirmed` | order-service | notification-service | 7 days |
| `orders.shipped` | order-service | inventory-service, notification-service | 7 days |
| `orders.cancelled` | order-service | inventory-service, notification-service | 7 days |

### Inventory domain (`inventory.*`)

Produced by [[inventory-service]].

| Topic | Producers | Consumers | Retention |
|---|---|---|---|
| `inventory.stock-updated` | inventory-service | _(none yet)_ | 3 days |
| `inventory.out-of-stock` | inventory-service | notification-service | 3 days |

### Notifications domain (`notifications.*`)

| Topic | Producers | Consumers | Retention |
|---|---|---|---|
| `notifications.adhoc` | any service | notification-service | 1 day |

## Consumer groups

| Consumer group | Service | Topics subscribed |
|---|---|---|
| `inventory-service` | [[inventory-service]] | `orders.*` |
| `notification-service` | [[notification-service]] | `orders.*`, `inventory.out-of-stock`, `notifications.adhoc` |

## Dead-letter queues

Each consumer group has a corresponding DLQ topic: `<consumer-group>.dlq`. Messages land here after 3 failed processing attempts. Monitor DLQ depth via [[monitoring-and-alerting]].

## Adding a new topic

1. Raise a PR to `github.com/company/hermes-config` adding the topic definition.
2. Register the Avro schema in the schema registry.
3. Get approval from the [[project-hermes]] team.
4. Update this page.
