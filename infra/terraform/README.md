# Production database: Amazon RDS for PostgreSQL 18 (ADR-0012, D30)

Owner: Thulasi (OpenTofu). Run everything here with **OpenTofu** (`tofu`, MPL-2.0), not Terraform, whose BUSL licence D75 blocks; the files and folder keep their usual names. Anand owns the parameter group's tuning, the extensions and the restore drills.

## What it creates

| Resource | Why |
|---|---|
| `aws_db_instance.postgres` | PostgreSQL 18, latest minor release (D24); **Multi-AZ**; gp3 storage with autoscaling; **not publicly accessible**; deletion protection and a final snapshot |
| `aws_kms_key.database` | Customer-managed key, rotated yearly: storage, automated backups, the master secret, Performance Insights and the PostgreSQL log groups |
| `aws_db_parameter_group.postgres18` | **TLS only** (`rds.force_ssl`, TLS 1.2+), **SCRAM only**, UTC, and **no statements or bind values in server logs**, so no patient data reaches CloudWatch |
| `aws_db_instance_automated_backups_replication.postgres` | Automated backups and transaction logs **replicated to a second U.S. region**, with its own KMS key there, so point-in-time recovery also works in that region |
| `aws_security_group.database` | PostgreSQL port only, only from the services' security groups (API, FHIR facade, integration worker, migrations) |
| `aws_cloudwatch_log_group.postgres` | PostgreSQL and upgrade logs, encrypted with our key and expired after `log_retention_days` |
| `aws_iam_role.rds_monitoring` | Enhanced monitoring (operating-system metrics only) |

**Not here yet:** the VPC and the services. Pass `vpc_id`, `db_subnet_ids` (private subnets in two or more availability zones) and `app_security_group_ids` in.

## Secrets

- **The master password is generated and rotated by RDS in Secrets Manager** (`manage_master_user_password`), encrypted with our key. It never appears in OpenTofu state, the repository or a terminal.
- The master role (`shri_rds_admin`) is used for two things only, during the first run: `sql/00_extensions.sql` and creating `shri_migrator`.
- The service roles (D23: `shri_migrator`, `shri_app`, `shri_fhir_reader`, `shri_integration`, `shri_reporting` and `shri_maintenance`) and their passwords are created by the master role and stored in OpenBao. They are never in OpenTofu.

## First run (once per environment)

1. **State bucket.** Create an S3 bucket for state with versioning, default encryption (SSE-KMS) and Block Public Access on. Then:

   ```bash
   tofu init -backend-config="bucket=<state bucket>" -backend-config="key=database/<environment>.tfstate" -backend-config="region=us-east-1"
   ```

2. **Values.** Put `environment`, `vpc_id`, `db_subnet_ids` and `app_security_group_ids` in `<environment>.tfvars`, outside the repository (`*.tfvars` is git-ignored). Then:

   ```bash
   tofu plan -var-file=<environment>.tfvars -out=<environment>.tfplan
   ```

   A second person reviews the plan before `tofu apply <environment>.tfplan`.
3. **Database with the builtin C.UTF-8 collation (D33).** RDS can't create its initial database with that collation, so OpenTofu sets no `db_name`. As the master role, over TLS:

   ```sql
   CREATE DATABASE shri TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
   ```

   Then, connected to `shri`, take away what PostgreSQL gives every role by default, exactly as the development image does (`infra/compose/postgres/initdb/10-service-roles.sh`):

   ```sql
   REVOKE ALL ON DATABASE shri FROM PUBLIC;  -- no CONNECT or TEMP for roles that aren't granted it
   REVOKE ALL ON SCHEMA public FROM PUBLIC;  -- no CREATE in public
   ```

   **Why `TEMP` matters:** most rule functions in `public` run with the caller's `search_path`, and temporary tables are searched first. A role allowed to create temporary tables could shadow a clinical table inside a trigger (review of #45). The service roles get `CONNECT` only, in step 4.

4. **Roles, extensions and migrations (Anand, ADR-0012), in this order:**
   - create the six roles as `10-service-roles.sh` does (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`; every role but `shri_migrator` also `NOINHERIT`), with passwords from OpenBao, and make `shri_migrator` the owner of `shri` and of schema `public`;
   - `GRANT CONNECT ON DATABASE shri` to the six roles, and nothing else at database level. `shri_maintenance` gets only what the migrations grant it: `USAGE` on `admin` and `EXECUTE` on the purge functions, never table access;
   - run `backend/app/db/sql/00_extensions.sql` as the master role (it expects the roles to exist);
   - confirm `SELECT extversion FROM pg_extension WHERE extname = 'vector'` matches development and CI (D31), and that `SHOW data_checksums` is `on`;
   - run the migrations as `shri_migrator` (`MIGRATION_DATABASE_URL`), never as the master role.

Clients connect with `sslmode=verify-full` and the [AWS RDS CA bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) for `rds-ca-rsa2048-g1` (output `database_ca_cert_identifier`).

## Restore drills (Anand, every quarter)

1. Restore to a new instance at a point in time:
   - in the primary region from the instance's automated backups;
   - every second drill, in the backup region from the replicated backups (output `backup_replication_arn`).
2. Time it, from the start of the restore until the database accepts connections.
3. Run the audit-chain check (`shri_audit_verify`) on the restored copy.
4. **Portability check (the RDS licence exception, D75):** take a standard `pg_dump` of the restored copy and restore
   it into a self-managed PostgreSQL 18, the development image in `infra/compose/postgres`. Run the migrations' `alembic check`
   and `shri_audit_verify` there too. This proves the data isn't tied to RDS. Part of every quarterly drill (D30's cadence).
5. Record the result and delete the drill instance and the self-managed copy.

The drill instance is never connected to the application.

## Checks

`tofu fmt`, `tofu validate` and `tofu test` (`tests/rds.tftest.hcl`) run in CI (`.github/workflows/terraform.yml`). The tests plan against a mock AWS provider, so they need no account, and they fail if a control above is switched off:
- Multi-AZ, encryption and key rotation;
- not publicly accessible, and only the services' security groups may connect;
- deletion protection and the final snapshot;
- the RDS-managed master secret;
- backups and their copy in the second region;
- TLS, SCRAM and log settings;
- U.S.-only regions, and two subnets for Multi-AZ.

Locally, with the versions pinned in `versions.tf`:

```bash
tofu init -backend=false && tofu fmt -check -recursive && tofu validate && tofu test
```
