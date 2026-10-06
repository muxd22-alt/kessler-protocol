from huggingface_hub import hf_hub_download

def download():
    model_path = hf_hub_download(
        repo_id="Mapika/decider-2b-GGUF",
        filename="decider-2b-q4_k_m.gguf",
        cache_dir="./models"
    )
    print(f"Downloaded model to {model_path}")

if __name__ == "__main__":
    download()
