---
title: "Notification Service — Service Page"
type: service
tags: [service, java, spring-boot, kafka, email, sms, event-driven, project-atlas]
author: Platform Team
created: 2024-04-02
updated: 2025-01-25
---

# Notification Service

The Notification Service consumes events from Kafka and dispatches notifications to users via email, SMS, and push. It is entirely event-driven — it exposes no external REST API.

## Responsibilities

- Listening to order lifecycle events from [[order-service]]
- Rendering notification templates (email HTML, SMS text)
- Dispatching via SendGrid (email) and Twilio (SMS)
- Tracking delivery status and handling retries

## Tech stack

- **Language:** Java 21
- **Framework:** Spring Boot 3.2
- **Messaging:** Apache Kafka (consumer only)
- **Email:** SendGrid API
- **SMS:** Twilio API
- **Deployment:** Kubernetes (`atlas/notification-service`), see [[kubernetes-cluster]]

## Kafka topics consumed

| Topic | Consumer group | Notification triggered |
|---|---|---|
| `orders.placed` | `notification-service` | "Order received" confirmation email |
| `orders.confirmed` | `notification-service` | "Payment confirmed" email + SMS |
| `orders.shipped` | `notification-service` | "Your order is on its way" email with tracking |
| `orders.cancelled` | `notification-service` | "Order cancelled" email |

See [[kafka-topics-overview]] for full schema definitions.

## Template management

Notification templates are stored as Thymeleaf HTML files under `src/main/resources/templates/`. Each template name maps directly to the Kafka event type (e.g. `order-placed.html`).

## Configuration

```
KAFKA_BOOTSTRAP_SERVERS=hermes-prod-kafka:9092
KAFKA_GROUP_ID=notification-service
SENDGRID_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
NOTIFICATION_FROM_EMAIL=noreply@company.com
```

## No REST API

This service intentionally has no inbound REST API. All inputs come via Kafka. For ad-hoc notifications (e.g. system announcements), publish directly to `notifications.adhoc` topic.

## Repository

`github.com/company/notification-service`
