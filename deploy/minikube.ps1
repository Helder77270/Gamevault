# Local Kubernetes test of the whole GameVault stack (minikube, Docker driver).
#   powershell -ExecutionPolicy Bypass -File deploy\minikube.ps1          # build + deploy
#   powershell -ExecutionPolicy Bypass -File deploy\minikube.ps1 -NoBuild # images already built
# Needs: Docker Desktop (cgroups v2 — see docs/infra.md), minikube, kubectl.
# Secrets are random TEST values generated here; nothing real is used.
param([switch]$NoBuild)
$ErrorActionPreference = "Stop"
$mk = "C:\Program Files\Kubernetes\Minikube\minikube.exe"
$root = Split-Path -Parent $PSScriptRoot

if (-not $NoBuild) {
  docker build -f "$root\ticketd\Dockerfile" -t gamevault/ticketd:dev $root
  docker build -f "$root\web\Dockerfile" --build-arg NEXT_PUBLIC_TICKETD_URL=https://api.gamevault.local -t gamevault/web:dev $root
}

& $mk status *> $null
if ($LASTEXITCODE -ne 0) { & $mk start --driver=docker --cpus=4 --memory=6144 --kubernetes-version=v1.31.0 }
& $mk addons enable ingress
& $mk addons enable metrics-server

# `minikube image load` needs wmic (gone from Windows 11): copy the images
# from Docker Desktop to minikube's own Docker daemon instead.
$envLines = & $mk docker-env --shell powershell
$dhost = ($envLines | Select-String 'DOCKER_HOST = "([^"]+)"').Matches[0].Groups[1].Value
$cert = ($envLines | Select-String 'DOCKER_CERT_PATH = "([^"]+)"').Matches[0].Groups[1].Value
foreach ($img in "gamevault/ticketd:dev", "gamevault/web:dev") {
  $tar = Join-Path $env:TEMP "gv-img.tar"
  docker save $img -o $tar
  docker --host $dhost --tlsverify --tlscacert "$cert\ca.pem" --tlscert "$cert\cert.pem" --tlskey "$cert\key.pem" load -i $tar
  Remove-Item $tar
}

# same rate-limit answer as production (Ansible sets it on ingress-nginx)
kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge -p '{\"data\":{\"limit-req-status-code\":\"429\",\"limit-conn-status-code\":\"429\"}}'

kubectl apply -f "$root\k8s\base\namespace.yaml"
$hex = { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
kubectl -n gamevault create secret generic gamevault-secrets `
  --from-literal=TICKET_SIGNER_PRIVKEY="0x$(& $hex)" `
  --from-literal=ATTEST_SIGNER_PRIVKEY="0x$(& $hex)" `
  --from-literal=KEYSTORE_MASTER_KEY="$(& $hex)" `
  --from-literal=PINATA_JWT=test-not-a-real-jwt `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k "$root\k8s\overlays\minikube"
kubectl -n gamevault rollout status statefulset/ticketd --timeout=180s
kubectl -n gamevault rollout status deployment/web --timeout=180s
kubectl -n gamevault get pods

Write-Host ""
Write-Host "Try it:  kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443"
Write-Host "         curl.exe -k -H 'Host: api.gamevault.local' https://127.0.0.1:18443/health"
