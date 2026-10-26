# ADR-0012: Host the database on Amazon RDS for PostgreSQL 18

Status: **Accepted** · 2026-10-23 · Decided by the team; recorded by Vimal (drafted with Claude Code)
Answers: Open Decisions for the MVP v1.0, Q24 (owners Thulasi, with Anand). Recorded as DECISIONS.md D30.
Builds on: [ADR-0011](0011-single-postgresql-retire-hapi.md) (one PostgreSQL 18 database, three schemas, one role per service).

## Context

ADR-0011 puts all our data in one PostgreSQL 18 database. Someone has to run it: backups, point-in-time recovery, encryption, failover, minor-version patching and restore drills. Technical Architecture v1.1 assumed a self-managed server backed up with pgBackRest. The team is four people, and none of them is a full-time database operator.

## Decision

**Amazon RDS for PostgreSQL 18.**

- **Multi-AZ**, so a standby in a second availability zone takes over automatically.
- **Encrypted at rest** (AWS KMS), with TLS for every connection (`sslmode=verify-full`).
- **Automated backups with point-in-time recovery.**
- **Snapshot copies to a second U.S. region.**
- **Restore drills every quarter:** restore to a new instance, time it, and run the audit-chain check (`shri_audit_verify`) on the restored copy.
- **pgBackRest is not used.**
- **Version:** the latest 18.x minor release (D24). Move to PostgreSQL 19 only after it has had a couple of minor releases.
- **Extensions:** only those RDS supports. pgvector is the version RDS ships for PostgreSQL 18, pinned identically in development and CI (D31). Keyword search uses PostgreSQL's built-in full-text search (D32).
- **Collation:** C.UTF-8 (D33).

Thulasi provisions it with Terraform (`infra/terraform/`). Anand owns the parameter group, extensions and restore drills.

## Options considered

| Option | Summary | Outcome |
|---|---|---|
| **Amazon RDS for PostgreSQL, Multi-AZ** | Managed backups, encryption and automatic failover | **Chosen** |
| Self-managed PostgreSQL on EC2 with pgBackRest | Full control of extensions and versions; we run backups, failover and patching ourselves | Rejected: more operating work for a small team |

## Consequences

**Better:**

- Backups, point-in-time recovery, failover and minor-version patching are run by the provider.
- One less key to manage: backups are encrypted with the RDS KMS key.

**Costs:**

- **Extensions and versions follow RDS.** We can only use what RDS ships, so we upgrade pgvector when RDS does (D31).
- **Superuser actions differ.** RDS has no true superuser, so `sql/00_extensions.sql` must run as the RDS master role, and the five service roles (D23) are created by `shri_migrator` within RDS's limits (confirmed by Anand during adoption).
- **Development and CI must match RDS:** a PostgreSQL 18 image with the RDS pgvector version and C.UTF-8 collation (Thulasi, with Anand).
- **Restore drills stay our job.** RDS restores, but proving that a restore works, how long it takes, and that the audit chain verifies is ours, every quarter.

**Superseded:**

- pgBackRest in Technical Architecture v1.1 (§1, §2.1, §6, §9, §12.2) and in the Implementation Plan's operations table.

## Licence exception (added 2026-10-26)

The licence policy (DECISIONS.md D75) allows proprietary components only as recorded exceptions. Amazon RDS is one, recorded in the licence exceptions register with three conditions:

- **Standard PostgreSQL features only:** no Aurora, and no AWS-specific extensions such as `aws_s3` or `aws_lambda`.
- **A portable backup, proven regularly** by restoring a standard PostgreSQL dump into a self-managed PostgreSQL.
- **Reviewed yearly.**

The decision above is unchanged. The conditions keep the self-managed option considered above open.

## References

DECISIONS.md D23, D24, D28, D30, D31, D32, D33; ADR-0011; Open Decisions v1.0 Q24 and Q25; Technical Architecture v1.1 ADR-03.
