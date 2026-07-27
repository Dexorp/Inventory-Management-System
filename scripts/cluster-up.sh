#!/usr/bin/env bash
set -euo pipefail

cd ../

CLUSTER_NAME="ims-dev"
ROOT_DIR="$(pwd)"
KUBECONFIG_PATH="$ROOT_DIR/.kube/kind.config"
KIND_CLUSTER_CONFIG="$ROOT_DIR/.kube/kind-cluster.yaml"

export KUBECONFIG="$KUBECONFIG_PATH"

mkdir -p "$(dirname "$KUBECONFIG_PATH")"

echo "Creating kind cluster..."
kind create cluster \
  --name "$CLUSTER_NAME" \
 # --config "$KIND_CLUSTER_CONFIG" \
 # --kubeconfig "$KUBECONFIG_PATH"

kubectl config use-context "kind-$CLUSTER_NAME"

echo "Installing ingress-nginx..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

echo "Installing metrics-server..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deploy metrics-server --type='json' -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"},
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-preferred-address-types=InternalIP,Hostname,ExternalIP"}
]'




echo "Creating ims-system namespace and resources..."
cd "$ROOT_DIR/deploy/helm/charts"
kubectl apply -f ims-system.yaml

echo "Installing Redis in ims-system namespace..."
helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install redis bitnami/redis \
  --namespace ims-system \
  --set auth.enabled=false



echo "Installing Redis in ims-system namespace..."
helm upgrade --install redis bitnami/redis \
  --namespace ims-system \
  --set auth.enabled=false

echo "Applying provisioning API manifests..."
cd "$ROOT_DIR/deploy/helm/charts/ims-system"
kubectl apply -f .
echo "Cluster is up."
echo "KUBECONFIG=$KUBECONFIG_PATH"
kind export kubeconfig --name ims-dev # Run this command if network error persists(kubectl)
kubectl get nodes
kubectl get pods -n ims-system