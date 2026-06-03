---
title: "Java Coding Standards"
type: standard
tags: [java, coding-standards, best-practices, spring-boot]
author: Platform Team
created: 2024-02-10
updated: 2024-12-01
---

# Java Coding Standards

These standards apply to all Java services in [[project-atlas]]. Follow them when contributing to [[user-api]], [[order-service]], [[inventory-service]], [[notification-service]], or [[api-gateway]].

## Java version

All services run Java 21. Use language features freely: records, sealed classes, pattern matching, virtual threads (Project Loom) via `spring.threads.virtual.enabled=true`.

## Project structure

Follow standard Maven layout. Package by feature, not by layer:

```
com.company.<service>/
  order/          # domain + REST controller + service + repository
  payment/
  shared/         # cross-cutting concerns
```

Avoid `com.company.<service>.controller` / `.service` / `.repository` flat structures — they don't scale.

## Formatting

- Use the [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html)
- Line length: 120 characters
- The `google-java-format` Maven plugin is configured in all service POMs — run `mvn fmt:format` before committing

## Exception handling

- Never swallow exceptions silently
- Use `@ControllerAdvice` with `@ExceptionHandler` for REST error responses
- Return RFC 7807 Problem Details (`application/problem+json`)
- Log at ERROR level with full stack trace for unexpected exceptions; WARN for expected business errors

## Logging

- Use SLF4J + Logback (provided by Spring Boot)
- Structured JSON logging in production (configured via `logstash-logback-encoder`)
- Always include `traceId` and `userId` in MDC for request-scoped logs
- Never log passwords, tokens, or PII

## Testing

- Unit tests with JUnit 5 + Mockito
- Integration tests with `@SpringBootTest` + Testcontainers (PostgreSQL, Kafka)
- Minimum 80% line coverage enforced by Jacoco in CI
- See [[spring-boot-conventions]] for test slice conventions (`@WebMvcTest`, `@DataJpaTest`)

## Dependencies

- Manage versions via the Spring Boot BOM — don't override without good reason
- Prefer Spring-provided abstractions over raw clients (e.g. `KafkaTemplate` over raw Kafka producer)
- Keep `pom.xml` tidy: no unused dependencies, no version duplication
