# One customer-managed key per region for the database: storage, automated backups, the RDS-managed
# master password, Performance Insights and the database's CloudWatch logs. Keys rotate yearly and
# cannot be deleted for 30 days after scheduling, so a mistaken destroy can still be cancelled.

data "aws_iam_policy_document" "database_key" {
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts the PostgreSQL log groups with this key, and only those log groups.
  statement {
    sid       = "CloudWatchLogsForDatabaseLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/rds/instance/${local.name}-postgres/*"]
    }
  }
}

resource "aws_kms_key" "database" {
  description             = "${local.name}: PostgreSQL storage, backups, master secret and logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.database_key.json
}

resource "aws_kms_alias" "database" {
  name          = "alias/${local.name}-database"
  target_key_id = aws_kms_key.database.key_id
}

# KMS keys never leave their region, so the backup copies need their own key there.
resource "aws_kms_key" "database_backup" {
  provider = aws.backup

  description             = "${local.name}: PostgreSQL backup copies in the second U.S. region"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "database_backup" {
  provider = aws.backup

  name          = "alias/${local.name}-database-backup"
  target_key_id = aws_kms_key.database_backup.key_id
}
