locals {
  name = "shri-${var.environment}"

  tags = {
    Project     = "shri-health"
    Environment = var.environment
    ManagedBy   = "opentofu"
    Owner       = "thulasi"
  }
}

provider "aws" {
  region = var.primary_region

  default_tags {
    tags = local.tags
  }
}

# The second U.S. region that receives the backup copies (ADR-0012).
provider "aws" {
  alias  = "backup"
  region = var.backup_region

  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}
