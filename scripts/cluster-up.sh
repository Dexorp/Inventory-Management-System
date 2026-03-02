#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="ims-dev"
export KUBECONFIG="$(pwd)/.kube/kind.config"

mkdir -p "$(dirname "$KUBECONFIG")"

echo "Creating kind cluster..."
kind create cluster --name "$CLUSTER_NAME" --config kind/kind-config.yaml --kubeconfig "$KUBECONFIG"

kubectl config use-context "kind-$CLUSTER_NAME"

echo "Installing ingress-nginx..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace

echo "Creating ims namespace..."
kubectl create namespace ims --dry-run=client -o yaml | kubectl apply -f -

echo "Installing Redis (dev) in cluster..."
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install redis bitnami/redis \
  -n ims \
  --set auth.enabled=false

echo "Cluster is up."
echo ""
echo "TIP: Access ingress locally via port-forward:"
echo "  kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8080:80"
