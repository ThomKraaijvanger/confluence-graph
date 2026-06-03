---
title: "User API — Service Page"
type: service
tags: [service, java, spring-boot, postgresql, rest-api, authentication, project-atlas]
author: Platform Team
created: 2024-03-05
updated: 2025-01-20
---

# User API

The User API is the authoritative source for user identities, authentication, and authorization within [[project-atlas]].

## Responsibilities

- User registration, login, and profile management
- JWT issuance and validation
- Role and permission management
- OAuth2 / OIDC integration (Google, Microsoft)

## Tech stack

- **Language:** Java 21
- **Framework:** Spring Boot 3.2
- **Database:** PostgreSQL 15 (schema: `users`)
- **Auth:** Spring Security + JWT
- **Deployment:** Kubernetes (`atlas/user-api`), see [[kubernetes-cluster]]

## API

Base path: `/api/v1/users`

| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create a new user account |
| POST | `/login` | Authenticate and receive a JWT |
| GET | `/me` | Get current user profile |
| PUT | `/me` | Update profile |
| GET | `/{id}` | Get user by ID (admin only) |

All endpoints require a valid JWT except `/register` and `/login`. Tokens are validated by the [[api-gateway]] before requests reach this service.

## Configuration

Key environment variables (injected via Kubernetes secrets):

```
DB_URL=jdbc:postgresql://postgres:5432/users
DB_USERNAME=...
DB_PASSWORD=...
JWT_SECRET=...
JWT_EXPIRY_HOURS=24
```

## Events published

The User API does not publish Kafka events currently. User lifecycle events are planned for a future iteration.

## Repository

`github.com/company/user-api`

## Runbook

See [[deployment-guide]] for deploy steps. For incidents, check [[monitoring-and-alerting]].
