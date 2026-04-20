docker login
cd ../operator-api
docker build -t joforrester/ims-operator:latest .
docker push joforrester/ims-operator:latest
cd ../provisioner-api
docker build -t joforrester/provisioner-api:latest .
docker push joforrester/provisioner-api:latest

clear
cd ..
wsl ls
wsl bash -c "cd deploy/helm/charts/provisioning-api && kubectl apply -f ."
wsl bash -c "kubectl rollout restart deployment ims-provisioner -n ims-system"
wsl bash -c "kubectl rollout restart deployment ims-operator -n ims-system"
cd scripts