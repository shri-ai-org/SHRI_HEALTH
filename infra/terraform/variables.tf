variable "environment" {
  description = "staging or production. Production holds patient data; staging uses synthetic data only (D12)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "primary_region" {
  description = "AWS region of the database."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = startswith(var.primary_region, "us-")
    error_message = "Patient data stays in the United States: use a us-* region."
  }
}

variable "backup_region" {
  description = "Second U.S. region that receives the backup copies (ADR-0012)."
  type        = string
  default     = "us-west-2"

  validation {
    condition     = startswith(var.backup_region, "us-")
    error_message = "Backup copies stay in the United States: use a us-* region."
  }

  validation {
    condition     = var.backup_region != var.primary_region
    error_message = "The backup region must differ from the primary region."
  }
}

variable "vpc_id" {
  description = "VPC the database runs in."
  type        = string
}

variable "db_subnet_ids" {
  description = "Private subnets in at least two availability zones (Multi-AZ). Never public subnets."
  type        = list(string)

  validation {
    condition     = length(var.db_subnet_ids) >= 2
    error_message = "Multi-AZ needs subnets in at least two availability zones."
  }
}

variable "app_security_group_ids" {
  description = "Security groups of the services allowed to reach PostgreSQL (API, FHIR facade, integration worker, migrations)."
  type        = list(string)

  validation {
    condition     = length(var.app_security_group_ids) >= 1
    error_message = "Name at least one security group that may connect."
  }
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.m7g.large"
}

variable "allocated_storage_gb" {
  description = "Initial storage in GB (gp3)."
  type        = number
  default     = 100
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling in GB."
  type        = number
  default     = 1000
}

variable "backup_retention_days" {
  description = "Days of automated backups and point-in-time recovery, in both regions. RDS allows up to 35."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Keep 7 to 35 days of automated backups."
  }
}

variable "backup_window" {
  description = "Daily backup window, UTC (hh24:mi-hh24:mi). Default: night in U.S. time zones."
  type        = string
  default     = "07:00-08:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window, UTC (ddd:hh24:mi-ddd:hh24:mi); minor versions are applied here. Must not overlap the backup window."
  type        = string
  default     = "sun:08:30-sun:09:30"
}

variable "log_retention_days" {
  description = "Days to keep PostgreSQL server logs in CloudWatch. These are operational logs, not the audit trail, which lives in audit.audit_event."
  type        = number
  default     = 90
}
