# Plans against a mock AWS provider (no account or credentials), so CI can check the controls stay:
# an encrypted disk, IMDSv2, HTTPS from anywhere and SSH from one address only.
# Run: tofu init -backend=false && tofu test

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-00000000000000001" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-00000000000000001"] }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-00000000000000001" }
  }
}

variables {
  admin_cidr     = "203.0.113.7/32"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyForTestsOnly000000000000000000 test"
}

run "disk_encrypted_and_imdsv2" {
  command = plan

  assert {
    condition     = aws_instance.test_server.root_block_device[0].encrypted
    error_message = "The root disk must be encrypted."
  }

  assert {
    condition     = aws_instance.test_server.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required."
  }

  assert {
    condition     = aws_instance.test_server.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "Containers must not reach the instance metadata."
  }
}

run "only_https_and_one_ssh_address" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.https.from_port == 443 && aws_vpc_security_group_ingress_rule.https.to_port == 443
    error_message = "Port 443 only for the public."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.ssh.cidr_ipv4 == "203.0.113.7/32" && aws_vpc_security_group_ingress_rule.ssh.from_port == 22
    error_message = "SSH only from admin_cidr."
  }
}

run "ssh_from_everywhere_is_refused" {
  command = plan

  variables {
    admin_cidr = "0.0.0.0/0"
  }

  expect_failures = [var.admin_cidr]
}
