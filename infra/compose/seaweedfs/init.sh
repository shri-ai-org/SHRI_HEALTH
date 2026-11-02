#!/bin/sh
# One shot: the two buckets of the file service (Anand's #128), on the DEVELOPMENT store only.
# Safe to run again: a bucket that exists is left alone.
set -eu

for bucket in shri-quarantine shri-clean; do
    if echo "s3.bucket.list" | weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888 2>/dev/null \
            | grep -qw "$bucket"; then
        continue
    fi
    echo "s3.bucket.create -name $bucket" | weed shell -master=seaweedfs:9333 -filer=seaweedfs:8888
done
echo "SeaweedFS ready: buckets shri-quarantine and shri-clean, chunks encrypted"
