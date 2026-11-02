# OpenBao for the test server (infra/deploy): file storage in the `openbao` volume, sealed at every
# start until deploy.sh unseals it. Reached only over the internal compose network (never
# published), so the listener is plain HTTP inside it.
storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

# Containers can't lock memory without IPC_LOCK; swap is off on the test host (README).
disable_mlock = true
ui            = false
