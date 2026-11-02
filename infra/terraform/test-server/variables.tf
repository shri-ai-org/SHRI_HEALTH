variable "region" {
  description = "AWS region of the test server."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = startswith(var.region, "us-")
    error_message = "Use a us-* region."
  }
}

variable "admin_cidr" {
  description = "The one address allowed to reach SSH (port 22), as a /32, e.g. 203.0.113.7/32."
  type        = string

  validation {
    condition     = can(cidrhost(var.admin_cidr, 0)) && endswith(var.admin_cidr, "/32")
    error_message = "admin_cidr must be one IPv4 address as a /32."
  }

  validation {
    condition     = var.admin_cidr != "0.0.0.0/32"
    error_message = "admin_cidr must be a real address."
  }
}

variable "ssh_public_key" {
  description = "The administrator's SSH public key (ed25519). The private key never leaves their machine."
  type        = string

  validation {
    condition     = startswith(var.ssh_public_key, "ssh-ed25519 ")
    error_message = "Use an ed25519 public key (ssh-ed25519 ...)."
  }
}

variable "instance_type" {
  description = "The whole compose stack (PostgreSQL, Keycloak, OpenBao, ClamAV, the API) on one host: 8 GB of memory at least."
  type        = string
  default     = "t3.large"
}

variable "root_volume_gb" {
  description = "Encrypted root disk: images, the database and the file store volumes."
  type        = number
  default     = 60

  validation {
    condition     = var.root_volume_gb >= 40 && var.root_volume_gb <= 200
    error_message = "root_volume_gb must be between 40 and 200."
  }
}

variable "vpc_id" {
  description = "VPC for the instance; empty uses the account's default VPC."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "A public subnet of that VPC; empty uses the default VPC's first subnet."
  type        = string
  default     = ""
}
