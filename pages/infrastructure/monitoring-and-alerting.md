---
title: "Monitoring and Alerting"
type: infrastructure
tags: [monitoring, prometheus, grafana, alerting, kubernetes, kafka, observability]
author: Infrastructure Team
created: 2024-04-01
updated: 2025-02-05
---

# Monitoring and Alerting

All services in [[project-atlas]] and infrastructure managed by [[project-hermes]] export Prometheus metrics. This page covers the observability stack and how to access dashboards and alerts.

## Stack

| Tool | Purpose | URL |
|---|---|---|
| Prometheus | Metrics collection and alerting rules | `http://prometheus.internal` |
| Grafana | Dashboards | `http://grafana.internal` |
| Alertmanager | Alert routing (PagerDuty, Slack) | `http://alertmanager.internal` |

All tools require VPN + SSO login.

## Service dashboards

Every [[project-atlas]] service has a Grafana dashboard with:

- Request rate, error rate, latency (RED metrics)
- JVM heap, GC, thread pool utilisation
- Database connection pool (HikariCP)
- Kafka consumer lag (for services that consume)

Dashboard names follow the pattern `Atlas / <service-name>`.

## Kafka dashboards (Hermes)

- **Hermes / Cluster Overview** — broker health, under-replicated partitions, leader election rate
- **Hermes / Consumer Lag** — per consumer group, per topic
- **Hermes / DLQ Depth** — dead-letter queue depth per consumer group

## Spring Boot metric setup

All Atlas services include `spring-boot-actuator` with the Prometheus endpoint enabled:

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  metrics:
    export:
      prometheus:
        enabled: true
```

Prometheus scrapes all pods with the annotation `prometheus.io/scrape: "true"` on port `8080`.

## Alerting rules

Key alerts (firing page via PagerDuty on-call):

| Alert | Condition | Severity |
|---|---|---|
| `ServiceErrorRateHigh` | Error rate > 5% for 5 min | Page |
| `ServiceLatencyHigh` | p99 latency > 2s for 10 min | Page |
| `KafkaConsumerLagHigh` | Consumer lag > 10k for 5 min | Page |
| `KafkaDLQNonEmpty` | DLQ depth > 0 | Warning (Slack) |
| `KubernetesNodeNotReady` | Node not ready > 5 min | Page |

## On-call

On-call rotation is managed in PagerDuty. For escalations, contact the team lead listed on [[project-atlas]] or [[project-hermes]].
