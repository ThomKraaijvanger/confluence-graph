---
title: "Inventory Service — Service Page"
type: service
tags: [service, java, spring-boot, kafka, postgresql, event-driven, project-atlas]
author: Platform Team
created: 2024-03-12
updated: 2025-01-18
---

# Inventory Service

The Inventory Service manages product stock levels and the product catalogue for [[project-atlas]]. It reacts to order events and keeps stock counts consistent across the platform.

## Responsibilities

- Maintaining the product catalogue (names, descriptions, prices)
- Stock level tracking per product and warehouse
- Reserving and releasing stock in response to Kafka events from [[order-service]]
- Exposing product and stock data via REST API

## Tech stack

- **Language:** Java 21
- **Framework:** Spring Boot 3.2
- **Database:** PostgreSQL 15 (schema: `inventory`)
- **Messaging:** Apache Kafka (consumer)
- **Deployment:** Kubernetes (`atlas/inventory-service`), see [[kubernetes-cluster]]

## API

Base path: `/api/v1/inventory`

| Method | Path | Description |
|---|---|---|
| GET | `/products` | List all products |
| GET | `/products/{id}` | Get product details and stock level |
| PUT | `/products/{id}/stock` | Adjust stock (admin only) |

## Kafka topics consumed

| Topic | Consumer group | Action |
|---|---|---|
| `orders.placed` | `inventory-service` | Reserve stock for the order |
| `orders.cancelled` | `inventory-service` | Release reserved stock |
| `orders.shipped` | `inventory-service` | Deduct stock permanently |

See [[kafka-topics-overview]] for schema definitions. All events originate from [[order-service]].

## Configuration

```
DB_URL=jdbc:postgresql://postgres:5432/inventory
KAFKA_BOOTSTRAP_SERVERS=hermes-prod-kafka:9092
KAFKA_SCHEMA_REGISTRY_URL=http://schema-registry:8081
KAFKA_GROUP_ID=inventory-service
```

## Repository

`github.com/company/inventory-service`
