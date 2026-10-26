"""Download Muse Glimmer weights to a Modal volume once, so later jobs start fast.

Before running:
  1. Confirm the exact Hugging Face repo ID on the Muse Glimmer model card and set GLIMMER_HF_REPO.
  2. If the repo is gated, accept its license on Hugging Face and create a Modal secret:
       modal secret create huggingface HF_TOKEN=<your token>
Run:
  GLIMMER_HF_REPO=<org/repo> modal run infra/modal_glimmer.py
"""
import os

import modal

app = modal.App("bugcensus-glimmer-download")
volume = modal.Volume.from_name("glimmer-weights", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.11").pip_install("huggingface_hub[hf_transfer]>=0.24")

REPO = os.environ.get("GLIMMER_HF_REPO", "")


@app.function(image=image, volumes={"/weights": volume}, timeout=6 * 3600,
              secrets=[modal.Secret.from_name("huggingface")],
              env={"HF_HUB_ENABLE_HF_TRANSFER": "1"})
def download(repo_id: str):
    from huggingface_hub import snapshot_download

    path = snapshot_download(repo_id=repo_id, local_dir=f"/weights/{repo_id.split('/')[-1]}")
    volume.commit()
    return path


@app.local_entrypoint()
def main():
    if not REPO:
        raise SystemExit("Set GLIMMER_HF_REPO to the model's Hugging Face repo ID (see the model card).")
    print("downloaded to", download.remote(REPO))
