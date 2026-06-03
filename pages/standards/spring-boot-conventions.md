---
title: "Spring Boot Conventions"
type: standard
tags: [spring-boot, java, conventions, testing, configuration, project-atlas]
author: Platform Team
created: 2024-02-15
updated: 2025-01-05
---

# Spring Boot Conventions

Internal conventions for all Spring Boot services in [[project-atlas]]. Read alongside [[java-coding-standards]].

## Spring Boot version

All services use **Spring Boot 3.2.x**. Do not upgrade independently — coordinate with the Platform Team so all services move together.

## Configuration

Use `application.yml`, not `application.properties`. Use Spring profiles for environment-specific config:

- `application.yml` — defaults and shared config
- `application-local.yml` — local dev overrides (gitignored)
- Environment variables override YAML in deployed environments

Bind config to typed `@ConfigurationProperties` classes — avoid injecting raw `@Value` strings for anything more than a single property.

## Actuator endpoints

All services must expose:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true    # liveness + readiness for Kubernetes
```

Kubernetes uses `/actuator/health/liveness` and `/actuator/health/readiness`.

## Database access

Use **Spring Data JPA** with Hibernate. For complex queries, use JPQL or native SQL via `@Query` — avoid Criteria API unless necessary.

Run migrations with **Flyway**. Migration scripts live in `src/main/resources/db/migration/`. Always test migrations on a copy of production data before deploying.

## Kafka (Spring Kafka)

For producers, inject `KafkaTemplate<String, SpecificRecord>` and send with `kafkaTemplate.send(topic, key, value)`.

For consumers, use `@KafkaListener` with a `@KafkaListenerErrorHandler` configured to send failures to the DLQ after 3 retries:

```java
@KafkaListener(topics = "orders.placed", groupId = "inventory-service")
public void handleOrderPlaced(OrderPlacedEvent event) { ... }
```

See [[kafka-topics-overview]] for topic names and schemas.

## Testing conventions

| Test type | Annotation | What it loads |
|---|---|---|
| Unit | `@ExtendWith(MockitoExtension.class)` | Nothing — pure unit |
| Web layer | `@WebMvcTest` | Controllers + security only |
| Persistence | `@DataJpaTest` | JPA + Flyway migrations |
| Kafka | `@SpringBootTest` + Testcontainers | Full context + real Kafka |
| Full integration | `@SpringBootTest` + Testcontainers | Full context |

Use `@Testcontainers` with `@Container` fields for PostgreSQL and Kafka in integration tests — never rely on an external database in CI.

## Security

All services except [[notification-service]] participate in the JWT security chain. Add `spring-boot-starter-security` and validate tokens via the shared `security-commons` library (`com.company:security-commons:1.x`). Do not implement JWT validation from scratch.

The [[api-gateway]] handles external JWT validation; services behind it validate JWTs on internal calls only.
