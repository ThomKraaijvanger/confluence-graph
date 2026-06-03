---
title: "Order Service — Service Page"
type: service
tags: [service, java, spring-boot, kafka, postgresql, event-driven, project-atlas]
author: Platform Team
created: 2024-03-10
updated: 2025-02-01
---

# Order Service

The Order Service manages the full lifecycle of customer orders within [[project-atlas]]: placement, payment confirmation, fulfilment, and cancellation.

## Responsibilities

- Accepting new orders via REST API
- Coordinating fulfilment by publishing Kafka events consumed by [[inventory-service]] and [[notification-service]]
- Tracking order state machine (PENDING → CONFIRMED → SHIPPED → DELIVERED / CANCELLED)
- Exposing order history to the [[api-gateway]]

## Tech stack

- **Language:** Java 21
- **Framework:** Spring Boot 3.2
- **Database:** PostgreSQL 15 (schema: `orders`)
- **Messaging:** Apache Kafka (producer)
- **Deployment:** Kubernetes (`atlas/order-service`), see [[kubernetes-cluster]]

## API

Base path: `/api/v1/orders`

| Method | Path | Description |
|---|---|---|
| POST | `/` | Place a new order |
| GET | `/{id}` | Get order by ID |
| GET | `/` | List orders for current user |
| POST | `/{id}/cancel` | Cancel an order |

## Kafka topics produced

| Topic | Key | Value schema | Description |
|---|---|---|---|
| `orders.placed` | `orderId` | `OrderPlacedEvent` | Fired when a new order is accepted |
| `orders.confirmed` | `orderId` | `OrderConfirmedEvent` | Fired after payment is confirmed |
| `orders.cancelled` | `orderId` | `OrderCancelledEvent` | Fired on cancellation |
| `orders.shipped` | `orderId` | `OrderShippedEvent` | Fired by fulfilment webhook |

All schemas are registered in the Hermes schema registry — see [[kafka-topics-overview]].

## Configuration

```
DB_URL=jdbc:postgresql://postgres:5432/orders
KAFKA_BOOTSTRAP_SERVERS=hermes-prod-kafka:9092
KAFKA_SCHEMA_REGISTRY_URL=http://schema-registry:8081
```

## Dependencies

- [[user-api]] — validates user identity on order placement
- [[inventory-service]] — stock reservation via Kafka
- [[kafka-topics-overview]] — topic schema definitions

## Repository

`github.com/company/order-service`
