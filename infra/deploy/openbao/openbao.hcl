# OpenBao for the test server (infra/deploy): integrated storage (one raft node) in the `openbao`
# volume, sealed at every start until deploy.sh unseals it. Reached only over the internal compose
# network (never published), so the listener is plain HTTP inside it.
storage "raft" {
  path    = "/openbao/file"
  node_id = "shri-1"
}

api_addr     = "http://openbao:8200"
cluster_addr = "http://openbao:8201"

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

# Containers can't lock memory without IPC_LOCK; swap is off on the test host (README).
disable_mlock = true
ui            = false
