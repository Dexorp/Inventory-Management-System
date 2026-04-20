cd ../
wsl bash -c "kubectl get pods -n ims-system"
wsl bash -c "kubectl -n ims-system port-forward svc/ims-provisioner 8080:80"
wsl bash -c "kubectl delete tenant.ims.example.com/acme -n ims-system"
wsl bash -c "kubectl delete ns warehouse-tenant-acme"
wsl bash -c "rm -rf ~/.kube/cache"
cd scripts