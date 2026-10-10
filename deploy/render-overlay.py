"""Renders the Ansible overlay templates with group_vars (+ example vault)
into a temporary kustomize tree, to check them offline (P8 #7):

    python3 deploy/render-overlay.py /tmp/gv-overlay   # needs jinja2 + PyYAML
    kubectl kustomize /tmp/gv-overlay/overlay | python deploy/check-manifests.py
"""
import shutil
import sys
from pathlib import Path

import jinja2
import yaml

root = Path(__file__).resolve().parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/gv-overlay")
ans = root / "ansible"
vars_ = yaml.safe_load((ans / "group_vars/all.yml").read_text(encoding="utf-8"))
vars_.update(yaml.safe_load((ans / "group_vars/vault.example.yml").read_text(encoding="utf-8")))
# realistic values so the check proves the substitution happened
vars_.update(web_domain="play.example.org", api_domain="api.example.org", image_registry="registry.example.org/gv", ticketd_image_tag="1.2.3", web_image_tag="1.2.3")

if out.exists():
    shutil.rmtree(out)
(out / "base").mkdir(parents=True)
for f in (root.parent / "k8s/base").glob("*.yaml"):  # plain copies (no metadata: WSL-mounted drives refuse it)
    (out / "base" / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
(out / "overlay").mkdir(parents=True)
env = jinja2.Environment(loader=jinja2.FileSystemLoader(str(ans / "roles/gamevault/templates")), undefined=jinja2.StrictUndefined, keep_trailing_newline=True)
for name in ("kustomization.yaml", "config-patch.yaml"):
    (out / "overlay" / name).write_text(env.get_template(name + ".j2").render(**vars_), encoding="utf-8")
# the secret and the issuer templates must render too (values never printed)
env.get_template("secret.yaml.j2").render(**vars_)
jinja2.Environment(loader=jinja2.FileSystemLoader(str(ans / "roles/platform/templates")), undefined=jinja2.StrictUndefined).get_template("cluster-issuer.yaml.j2").render(**vars_)
print(f"rendered into {out}")
