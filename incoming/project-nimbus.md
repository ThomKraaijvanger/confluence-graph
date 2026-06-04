---
title: "Project Nimbus — Edge Caching Layer"
type: project
tags: [project, caching, java, kafka, performance]
author: Platform Team
created: 2025-05-20
updated: 2025-05-28
---

# Project Nimbus — Edge Caching Layer

Project Nimbus is a new initiative to add a distributed edge caching layer in front of the core platform services. The goal is to cut read latency for hot product and user data and to absorb traffic spikes before they reach the backend.

## Approach

Nimbus is written in Java with Spring Boot, consistent with the rest of our backend. Cache invalidation is event-driven: services publish change events to Kafka, and Nimbus consumers evict or refresh affected entries. This keeps caches coherent without tight coupling to the source services.

## Status

Currently in design. A proof-of-concept is running in a developer environment. Production rollout is targeted for Q3.

## Team

- Tech lead: Amir Hassan
- Backend: Priya Sharma
- Performance engineering: Yuki Tanaka

Amir is splitting time between this and his existing infrastructure responsibilities, so the timeline is intentionally conservative.
