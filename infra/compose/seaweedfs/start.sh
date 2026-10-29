#!/bin/sh
# Starts SeaweedFS for local development (compose): one server with its S3 API, the API's own
# access key only, and every stored chunk encrypted (-filer.encryptVolumeData,
# -s3.encryptVolumeData), the quarantine bucket included.
#
# Needs FILE_STORE_ACCESS_KEY_ID and FILE_STORE_SECRET_ACCESS_KEY. The key may only read, write,
# list and delete in the two buckets (seaweedfs/init.sh creates them); it is no admin.
set -eu

: "${FILE_STORE_ACCESS_KEY_ID:?}" "${FILE_STORE_SECRET_ACCESS_KEY:?}"
CONFIG=/tmp/s3.json

umask 077
cat > "$CONFIG" <<JSON
{"identities": [{"name": "shri-api",
  "credentials": [{"accessKey": "$FILE_STORE_ACCESS_KEY_ID", "secretKey": "$FILE_STORE_SECRET_ACCESS_KEY"}],
  "actions": ["Read:shri-clean", "Write:shri-clean", "List:shri-clean",
              "Read:shri-quarantine", "Write:shri-quarantine", "List:shri-quarantine"]}]}
JSON
chown seaweed:seaweed "$CONFIG"
unset FILE_STORE_SECRET_ACCESS_KEY

# The image's entrypoint drops to the seaweed user and adds -dir=/data.
exec /entrypoint.sh server -ip=seaweedfs -ip.bind=0.0.0.0 -volume.max=0 \
    -filer -filer.encryptVolumeData \
    -s3 -s3.port=8333 -s3.config="$CONFIG" -s3.encryptVolumeData \
    -s3.allowedOrigins="${FILE_STORE_ALLOWED_ORIGIN:-https://localhost:8443}"
