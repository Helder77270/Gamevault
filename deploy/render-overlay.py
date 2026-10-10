"""Renders the Ansible overlay templates with group_vars (+ example vault)
into a temporary kustomize tree, to check them offline (P8 #7):

    python3 deploy/render-overlay.py /tmp/gv-overlay [managed]   # needs jinja2 + PyYAML
    kubectl kustomize /tmp/gv-overlay/overlay | python deploy/check-manifests.py

`managed` renders the managed-Postgres variant (no in-cluster database).
"""
import shutil
import sys
from pathlib import Path

import jinja2
import yaml

root = Path(__file__).resolve().parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/gv-overlay")
managed = len(sys.argv) > 2 and sys.argv[2] == "managed"
ans = root / "ansible"
vars_ = yaml.safe_load((ans / "group_vars/all.yml").read_text(encoding="utf-8"))
vars_.update(yaml.safe_load((ans / "group_vars/vault.example.yml").read_text(encoding="utf-8")))
# realistic values so the check proves the substitution happened
vars_.update(web_domain="play.example.org", api_domain="api.example.org", image_registry="registry.example.org/gv", ticketd_image_tag="1.2.3", web_image_tag="1.2.3")
# all.yml derives this from the vault with Jinja; resolve it here
vars_["external_database_url"] = "postgres://u:p@db.example.org:5432/gamevault?sslmode=require" if managed else ""

if out.exists():
    shutil.rmtree(out)
for sub in ("base", "components/postgres"):
    (out / sub).mkdir(parents=True)
    for f in (root.parent / "k8s" / sub).glob("*.yaml"):  # plain copies (no metadata: WSL-mounted drives refuse it)
        (out / sub / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
(out / "overlay").mkdir(parents=True)
env = jinja2.Environment(loader=jinja2.FileSystemLoader(str(ans / "roles/gamevault/templates")), undefined=jinja2.StrictUndefined, keep_trailing_newline=True)
for name in ("kustomization.yaml", "config-patch.yaml"):
    (out / "overlay" / name).write_text(env.get_template(name + ".j2").render(**vars_), encoding="utf-8")
# the secret and the issuer templates must render too (values never printed)
secret = env.get_template("secret.yaml.j2").render(**vars_)
assert ("DATABASE_URL" in secret) == managed, "DATABASE_URL in the Secret only for a managed Postgres"
jinja2.Environment(loader=jinja2.FileSystemLoader(str(ans / "roles/platform/templates")), undefined=jinja2.StrictUndefined).get_template("cluster-issuer.yaml.j2").render(**vars_)
print(f"rendered into {out} ({'managed Postgres' if managed else 'in-cluster Postgres'})")
