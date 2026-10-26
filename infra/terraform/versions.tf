# Pinned like every other dependency: releases at least 7 days old, upgraded through a reviewed PR.
# Provider hashes are in .terraform.lock.hcl; CI initializes with -lockfile=readonly.
terraform {
  required_version = "= 1.16.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.1"
    }
  }

  # State is kept in an encrypted, versioned S3 bucket with S3-native locking. The bucket and key
  # are given at init time (README "First run"), so no account details live in the repository.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}
