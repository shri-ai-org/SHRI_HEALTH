output "database_endpoint" {
  description = "Hostname for DATABASE_URL and the other role URLs (sslmode=verify-full)."
  value       = aws_db_instance.postgres.address
}

output "database_port" {
  value = aws_db_instance.postgres.port
}

output "database_instance_arn" {
  description = "For restore drills (Anand)."
  value       = aws_db_instance.postgres.arn
}

output "database_ca_cert_identifier" {
  description = "Clients verify the server against this RDS CA (the AWS RDS CA bundle)."
  value       = aws_db_instance.postgres.ca_cert_identifier
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS master password; read it only to run sql/00_extensions.sql and create shri_migrator."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

output "database_kms_key_arn" {
  value = aws_kms_key.database.arn
}

output "backup_replication_arn" {
  description = "Automated-backup replica in the second U.S. region, for cross-region restore drills."
  value       = aws_db_instance_automated_backups_replication.postgres.id
}
