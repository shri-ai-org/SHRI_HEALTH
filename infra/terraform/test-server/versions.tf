# The test server (infra/deploy): one EC2 instance, its own OpenTofu root and state, apart from the
# production database in infra/terraform. Run with OpenTofu (MPL-2.0; D75). PLAN ONLY until the
# team decides to create it (README).
terraform {
  required_version = "= 1.13.1" # OpenTofu

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.1"
    }
  }

  # The same encrypted, versioned S3 state bucket as infra/terraform, under its own key; bucket and
  # key are given at init time (README), so no account details live in the repository.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project            = "shri-health"
      Environment        = "test-server"
      ManagedBy          = "opentofu"
      Owner              = "thulasi"
      DataClassification = "synthetic-only" # never patient data (D12)
    }
  }
}
