---
title: "API Gateway — Service Page"
type: service
tags: [service, java, spring-boot, spring-cloud-gateway, kubernetes, authentication, routing, project-atlas]
author: Platform Team
created: 2024-03-01
updated: 2025-02-10
---

# API Gateway

The API Gateway is the single entry point for all external traffic into [[project-atlas]]. It handles JWT authentication, request routing, rate limiting, and CORS.

## Responsibilities

- Validating JWTs issued by [[user-api]] on every inbound request
- Routing requests to the correct downstream service
- Rate limiting per user and per IP
- CORS headers for frontend clients
- Request/response logging for audit

## Tech stack

- **Language:** Java 21
- **Framework:** Spring Cloud Gateway (reactive, built on Spring WebFlux)
- **Auth:** JWT validation via Spring Security
- **Deployment:** Kubernetes (`atlas/api-gateway`), see [[kubernetes-cluster]]

## Routing table

| Path prefix | Downstream service | Auth required |
|---|---|---|
| `/api/v1/users/**` | [[user-api]] | No (login/register), Yes (rest) |
| `/api/v1/orders/**` | [[order-service]] | Yes |
| `/api/v1/inventory/**` | [[inventory-service]] | Yes (writes: admin) |

## Rate limiting

Default limits (Redis-backed):
- Authenticated users: 500 requests/minute
- Unauthenticated: 30 requests/minute

## Configuration

```
JWT_SECRET=...
RATE_LIMIT_REDIS_URL=redis://redis:6379
ROUTE_USER_API=http://user-api:8080
ROUTE_ORDER_SERVICE=http://order-service:8080
ROUTE_INVENTORY_SERVICE=http://inventory-service:8080
```

## Repository

`github.com/company/api-gateway`
