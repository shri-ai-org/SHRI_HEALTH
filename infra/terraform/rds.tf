# Amazon RDS for PostgreSQL 18 (ADR-0012, D30): Multi-AZ, encrypted with our KMS key, TLS only,
# automated backups with point-in-time recovery, and those backups replicated to a second U.S. region.
# Anand owns the parameter group's tuning, the extensions and the restore drills; the settings below
# are the security and correctness baseline that must not be removed.

locals {
  db_identifier = "${local.name}-postgres"
}

# ---- Network: private subnets only, reachable only from our services --------------------------

resource "aws_db_subnet_group" "database" {
  name        = "${local.name}-database"
  description = "Private subnets for ${local.db_identifier}"
  subnet_ids  = var.db_subnet_ids
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL: only our services connect; the database starts no connections"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_services" {
  for_each = toset(var.app_security_group_ids)

  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from ${each.value}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ---- Parameters ----------------------------------------------------------------------------

resource "aws_db_parameter_group" "postgres18" {
  name        = "${local.name}-postgres18"
  family      = "postgres18"
  description = "${local.db_identifier}: security baseline (Thulasi) and tuning (Anand)"

  # TLS for every connection; clients use sslmode=verify-full with the RDS CA bundle (ADR-0012).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  # SCRAM only, as in development and CI.
  parameter {
    name  = "password_encryption"
    value = "scram-sha-256"
  }

  parameter {
    name  = "timezone"
    value = "UTC"
  }

  # No patient data in server logs: statements and their bind values are never logged, even on error.
  parameter {
    name  = "log_statement"
    value = "none"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }

  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }

  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---- Logs: created here so they are encrypted with our key and expire -------------------------

resource "aws_cloudwatch_log_group" "postgres" {
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.db_identifier}/${each.value}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.database.arn
}

# ---- Enhanced monitoring (operating-system metrics, no data) ---------------------------------

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---- The database ----------------------------------------------------------------------------

resource "aws_db_instance" "postgres" {
  identifier = local.db_identifier

  # The latest 18.x minor release (D24): a major-version prefix with automatic minor upgrades in the
  # maintenance window. Moving to 19 is a reviewed change to this line, never automatic.
  engine                      = "postgres"
  engine_version              = "18"
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  instance_class        = var.instance_class
  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.database.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  port                   = 5432
  network_type           = "IPV4"
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # The RDS master role runs only sql/00_extensions.sql and creates shri_migrator (ADR-0012). Its
  # password is generated and rotated by RDS in Secrets Manager, encrypted with our key, so it never
  # appears in OpenTofu state, the repository or a terminal.
  username                      = "shri_rds_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.database.arn

  # No db_name: the application database is created once with the builtin C.UTF-8 collation (D33),
  # which RDS's own initial database cannot have. See README "First run".

  parameter_group_name = aws_db_parameter_group.postgres18.name

  backup_retention_period  = var.backup_retention_days
  backup_window            = var.backup_window
  maintenance_window       = var.maintenance_window
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.db_identifier}-final"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.database.arn
  performance_insights_retention_period = 7

  # Changes wait for the maintenance window unless someone applies them deliberately.
  apply_immediately = false

  depends_on = [aws_cloudwatch_log_group.postgres, aws_iam_role_policy_attachment.rds_monitoring]
}

# ---- Backups in the second U.S. region (ADR-0012) -------------------------------------------

# Replicates the automated backups and transaction logs, so the database can be restored to any point
# in the retention period in the second region too, not only from a daily snapshot.
resource "aws_db_instance_automated_backups_replication" "postgres" {
  provider = aws.backup

  source_db_instance_arn = aws_db_instance.postgres.arn
  kms_key_id             = aws_kms_key.database_backup.arn
  retention_period       = var.backup_retention_days
}
