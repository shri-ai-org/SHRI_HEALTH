locals {
  name = "shri-test-server"
}

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
}

data "aws_subnets" "default" {
  count = var.subnet_id == "" ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

locals {
  subnet_id = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.default[0].ids)[0]
}

# Ubuntu 24.04 LTS from Canonical's own account, the newest build at plan time.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "test_server" {
  name        = local.name
  description = "Shri Health test server: HTTPS from anywhere, SSH from one address"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.test_server.id
  description       = "HTTPS (Nginx; every other port stays on the host)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.test_server.id
  description       = "SSH from the administrator's address only"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.admin_cidr
}

# Out: HTTPS and HTTP (package and image downloads, ClamAV signatures) and DNS.
resource "aws_vpc_security_group_egress_rule" "out" {
  for_each = { https = ["tcp", 443], http = ["tcp", 80], dns_udp = ["udp", 53], dns_tcp = ["tcp", 53] }

  security_group_id = aws_security_group.test_server.id
  description       = "Outbound ${each.key}"
  ip_protocol       = each.value[0]
  from_port         = each.value[1]
  to_port           = each.value[1]
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_key_pair" "admin" {
  key_name   = local.name
  public_key = var.ssh_public_key
}

resource "aws_instance" "test_server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.test_server.id]
  key_name               = aws_key_pair.admin.key_name

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2 only, and containers can't reach it (hop limit 1).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  monitoring              = false
  disable_api_termination = true

  tags = {
    Name = local.name
  }

  lifecycle {
    ignore_changes = [ami] # a newer Ubuntu build doesn't replace the server
  }
}
