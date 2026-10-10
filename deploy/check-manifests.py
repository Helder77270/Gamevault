"""Offline sanity checks for the rendered Kubernetes manifests (P8 #7).

No cluster and no schema validator needed: render, then check what breaks
in production when forgotten.

    kubectl kustomize k8s/base | python deploy/check-manifests.py
"""
import sys

import yaml

docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
errors: list[str] = []
by_kind: dict[str, list[dict]] = {}
for d in docs:
    by_kind.setdefault(d["kind"], []).append(d)

services = {s["metadata"]["name"]: s for s in by_kind.get("Service", [])}
workloads = by_kind.get("Deployment", []) + by_kind.get("StatefulSet", [])


def labels_match(selector: dict, labels: dict) -> bool:
    return all(labels.get(k) == v for k, v in selector.items())


for w in workloads:
    name = f'{w["kind"]}/{w["metadata"]["name"]}'
    spec = w["spec"]
    tpl = spec["template"]
    if not labels_match(spec["selector"]["matchLabels"], tpl["metadata"]["labels"]):
        errors.append(f"{name}: selector does not match the pod labels")
    pod_sc = tpl["spec"].get("securityContext", {})
    if not pod_sc.get("runAsNonRoot"):
        errors.append(f"{name}: pod must run as non-root")
    if pod_sc.get("seccompProfile", {}).get("type") != "RuntimeDefault":
        errors.append(f"{name}: seccompProfile RuntimeDefault missing (PSA restricted)")
    mounts_needed = set()
    for c in tpl["spec"]["containers"]:
        cn = f"{name}/{c['name']}"
        for probe in ("livenessProbe", "readinessProbe", "startupProbe"):
            if probe not in c:
                errors.append(f"{cn}: {probe} missing")
        res = c.get("resources", {})
        if "requests" not in res or "limits" not in res:
            errors.append(f"{cn}: resources requests/limits missing")
        sc = c.get("securityContext", {})
        if sc.get("allowPrivilegeEscalation") is not False:
            errors.append(f"{cn}: allowPrivilegeEscalation must be false")
        if "ALL" not in sc.get("capabilities", {}).get("drop", []):
            errors.append(f"{cn}: capabilities must drop ALL")
        if ":" not in c["image"] or c["image"].endswith(":latest"):
            errors.append(f"{cn}: pin the image tag")
        ports = {p["name"]: p["containerPort"] for p in c.get("ports", [])}
        for probe in ("livenessProbe", "readinessProbe", "startupProbe"):
            port = c.get(probe, {}).get("httpGet", {}).get("port")
            if isinstance(port, str) and port not in ports:
                errors.append(f"{cn}: {probe} uses unknown port name {port}")
        for m in c.get("volumeMounts", []):
            mounts_needed.add(m["name"])
    declared = {v["name"] for v in tpl["spec"].get("volumes", [])}
    declared |= {t["metadata"]["name"] for t in spec.get("volumeClaimTemplates", [])}
    for m in sorted(mounts_needed - declared):
        errors.append(f"{name}: volumeMount {m} has no volume")
    # every Service pointing here must reach a named container port
    for s in services.values():
        if labels_match(s["spec"]["selector"], tpl["metadata"]["labels"]):
            names = {p["name"] for c in tpl["spec"]["containers"] for p in c.get("ports", [])}
            for p in s["spec"]["ports"]:
                if isinstance(p["targetPort"], str) and p["targetPort"] not in names:
                    errors.append(f"Service/{s['metadata']['name']}: targetPort {p['targetPort']} not in {name}")

for s in services.values():
    if not any(labels_match(s["spec"]["selector"], w["spec"]["template"]["metadata"]["labels"]) for w in workloads):
        errors.append(f"Service/{s['metadata']['name']}: selects no workload")

for ing in by_kind.get("Ingress", []):
    iname = f'Ingress/{ing["metadata"]["name"]}'
    tls_hosts = {h for t in ing["spec"].get("tls", []) for h in t["hosts"]}
    for rule in ing["spec"]["rules"]:
        if rule["host"] not in tls_hosts:
            errors.append(f"{iname}: host {rule['host']} served without TLS")
        for p in rule["http"]["paths"]:
            svc = p["backend"]["service"]
            target = services.get(svc["name"])
            if not target:
                errors.append(f"{iname}: backend service {svc['name']} does not exist")
                continue
            port = svc["port"].get("name") or svc["port"].get("number")
            known = {sp.get("name") for sp in target["spec"]["ports"]} | {sp["port"] for sp in target["spec"]["ports"]}
            if port not in known:
                errors.append(f"{iname}: service {svc['name']} has no port {port}")

for hpa in by_kind.get("HorizontalPodAutoscaler", []):
    ref = hpa["spec"]["scaleTargetRef"]
    if not any(w["kind"] == ref["kind"] and w["metadata"]["name"] == ref["name"] for w in workloads):
        errors.append(f"HPA/{hpa['metadata']['name']}: target {ref['kind']}/{ref['name']} missing")
    if hpa["spec"]["minReplicas"] < 2:
        errors.append(f"HPA/{hpa['metadata']['name']}: minReplicas < 2 (no redundancy)")

kinds = ", ".join(f"{len(v)} {k}" for k, v in sorted(by_kind.items()))
if errors:
    print(f"✗ {len(errors)} problem(s) in {len(docs)} objects ({kinds})")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print(f"✓ {len(docs)} objects OK ({kinds})")
