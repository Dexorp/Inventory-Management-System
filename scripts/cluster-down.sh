#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="ims-dev"
export KUBECONFIG="$(pwd)/.kube/kind.config"

echo "Deleting kind cluster..."
kind delete cluster --name "$CLUSTER_NAME"
echo "Done."
