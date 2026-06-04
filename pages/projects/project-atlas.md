---
title: "Project Atlas — Core Platform"
type: project
tags: [project, microservices, platform, java, spring-boot, kubernetes]
author: Platform Team
created: 2024-03-01
updated: 2025-01-10
---

# Project Atlas — Core Platform

Project Atlas is our internal microservices platform. It provides the foundational services for user management, order processing, inventory, and notifications. All customer-facing products are built on top of Atlas.

## Services

| Service | Purpose | Tech |
|---|---|---|
| [[user-api]] | User accounts and authentication | Spring Boot, PostgreSQL |
| [[order-service]] | Order lifecycle management | Spring Boot, Kafka, PostgreSQL |
| [[inventory-service]] | Stock levels and product catalogue | Spring Boot, PostgreSQL |
| [[notification-service]] | Email/SMS/push notifications | Spring Boot, Kafka |
| [[api-gateway]] | Single entry point, auth, routing | Spring Cloud Gateway |

## Infrastructure

All Atlas services run on [[kubernetes-cluster]] in the `atlas` namespace. Kafka is the backbone for async communication between services — see [[kafka-topics-overview]] for the full topic list. Platform infrastructure for Atlas — clusters, namespaces and the Kafka backbone — is owned by our infrastructure lead, **Amir Hassan**.

## Getting started

New engineers should read [[java-coding-standards]] and [[spring-boot-conventions]] before contributing. Deployment is handled via the [[deployment-guide]].

## Team

- Platform lead: Jan de Vries
- Backend: Priya Sharma, Lucas Müller, Sofia Andersen
- Infrastructure lead: Amir Hassan
