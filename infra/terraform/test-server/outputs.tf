output "public_ip" {
  description = "Point the test server's DNS name here (SHRI_HOSTNAME in the deploy settings)."
  value       = aws_instance.test_server.public_ip
}

output "instance_id" {
  description = "The instance, for the console and SSM."
  value       = aws_instance.test_server.id
}
