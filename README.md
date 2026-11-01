# Apps-on-Demand — prototype

Apps-on-Demand is a multi-tenant platform: tenants buy packages (Apps, Analytics, Bot,
Omnichannel), provision apps (Ordering, Payments, POS, Logistics) from YAML manifests,
customize fields, connect external systems through an Integration Hub, automate with
event-triggered workflows, and use a Claude-based assistant.

This repository holds the **prototype**. Its core rule is bare-minimum infrastructure:
**one Node.js container plus one PostgreSQL database**. Everything that would later be
Kafka, OpenSearch, ClickHouse, Temporal, Keycloak, Svix, Redis or S3 is a table or an
in-process module behind a port, so the code can grow into the full stack later.
External services are only called as API clients.

Synthetic data only. Never commit secrets.

Work lands milestone by milestone through pull requests against `main`.
