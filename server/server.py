"""
ClawCore Model Server
Serves embedding, reranking, NER, and document parsing via sentence-transformers + Docling.
Reads model config from config.json (written by installer).

Endpoints:
  POST /v1/embeddings  — OpenAI-compatible embedding endpoint
  POST /rerank         — Cross-encoder reranking
  POST /ner            — Named entity extraction (spaCy)
  POST /parse          — Document parsing via Docling (PDF, DOCX, PPTX, XLSX, HTML)
  GET  /health         — Health check
  POST /shutdown       — Graceful shutdown (localhost only)
"""

import os
import json
import torch
import logging
import traceback
from pathlib import Path
from flask import Flask, request, jsonify
from sentence_transformers import CrossEncoder, SentenceTransformer

try:
    import spacy
    _spacy_available = True
except ImportError:
    _spacy_available = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Load config from config.json or environment variables
config_path = Path(__file__).parent / "config.json"
if not config_path.exists():
    config_path = Path(__file__).parent.parent / "config.json"
if config_path.exists():
    with open(config_path) as f:
        config = json.load(f)
    EMBED_MODEL_ID = config.get("embed_model", "BAAI/bge-large-en-v1.5")
    RERANK_MODEL_ID = config.get("rerank_model", "BAAI/bge-reranker-large")
    TRUST_REMOTE = bool(config.get("trust_remote_code", False))
    DOCLING_DEVICE = config.get("docling_device", "cpu")  # "cpu", "gpu", or "off"
else:
    EMBED_MODEL_ID = os.environ.get("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    RERANK_MODEL_ID = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-large")
    TRUST_REMOTE = os.environ.get("TRUST_REMOTE_CODE", "0") == "1"
    DOCLING_DEVICE = os.environ.get("DOCLING_DEVICE", "cpu")

PORT = int(os.environ.get("MODEL_SERVER_PORT", "8012"))

# Path blocklist for /parse — mirrors Node.js ingest validation
_BLOCKED_PATH_FRAGMENTS = [".env", "credentials", "secrets", ".git/config", "id_rsa", ".ssh/"]

def _is_path_blocked(file_path: str) -> bool:
    lower = file_path.lower().replace("\\", "/")
    return any(b in lower for b in _BLOCKED_PATH_FRAGMENTS)

app = Flask(__name__)
embed_model = None
rerank_model = None
ner_model = None


def load_models():
    global embed_model, rerank_model, ner_model

    # Claim VRAM upfront so Windows desktop apps can't steal it after model load.
    # Default 0.90 = claim 90% of total VRAM. Override with VRAM_FRACTION env var.
    try:
        if torch.cuda.is_available():
            fraction = float(os.environ.get("VRAM_FRACTION", "0.90"))
            torch.cuda.set_per_process_memory_fraction(fraction, 0)
            total_mb = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
            logger.info(f"VRAM pool: claiming {fraction*100:.0f}% of {total_mb} MB ({int(total_mb * fraction)} MB)")
    except Exception as e:
        logger.warning(f"VRAM reservation failed (non-fatal): {e}")

    kwargs = {"trust_remote_code": True} if TRUST_REMOTE else {}

    logger.info(f"Loading embedding model: {EMBED_MODEL_ID} ...")
    embed_model = SentenceTransformer(EMBED_MODEL_ID, **kwargs)
    logger.info(f"Embedding model loaded. Dimension: {embed_model.get_sentence_embedding_dimension()}")

    logger.info(f"Loading rerank model: {RERANK_MODEL_ID} ...")
    rerank_model = CrossEncoder(RERANK_MODEL_ID, **kwargs)
    logger.info("Rerank model loaded and ready.")

    # Enable float16 inference on CUDA for ~30% speedup, 50% less VRAM
    try:
        if torch.cuda.is_available():
            embed_model.half()
            logger.info("Embedding model using float16 (CUDA)")
    except Exception as e:
        logger.warning(f"Could not enable float16 for embedding model: {e}")

    try:
        if torch.cuda.is_available():
            rerank_model.model.half()
            logger.info("Rerank model using float16 (CUDA)")
    except Exception as e:
        logger.warning(f"Could not enable float16 for reranker: {e}")

    # Warmup: run a dummy inference to trigger CUDA kernel compilation / JIT.
    # First real request would otherwise be 2-5x slower.
    logger.info("Warming up models...")
    try:
        embed_model.encode(["warmup"], normalize_embeddings=True, show_progress_bar=False)
        rerank_model.predict([("warmup query", "warmup document")])
        logger.info("Model warmup complete.")
    except Exception as e:
        logger.warning(f"Warmup failed (non-fatal): {e}")

    # Detect Docling API version at startup so parse requests don't fail later
    global _docling_create_converter
    try:
        from docling.document_converter import DocumentConverter as _DC
        import inspect
        sig = inspect.signature(_DC.__init__)
        params = list(sig.parameters.keys())
        if "pipeline_options" in params:
            def _create_v1(device):
                from docling.datamodel.pipeline_options import PipelineOptions
                opts = PipelineOptions()
                if device == "cpu":
                    opts.accelerator_options.device = "cpu"
                return _DC(pipeline_options=opts)
            _docling_create_converter = _create_v1
            logger.info("Docling available (v1 API, will load on-demand per parse request).")
        else:
            _docling_create_converter = lambda device: _DC()
            logger.info("Docling available (v2+ API, will load on-demand per parse request).")
    except ImportError:
        _docling_create_converter = None
        logger.warning("Docling not installed. /parse endpoint will be unavailable.")

    # Load spaCy NER model (optional)
    ner_model = None
    if _spacy_available:
        try:
            ner_model = spacy.load("en_core_web_sm")
            logger.info("NER model loaded: en_core_web_sm")
        except OSError:
            logger.warning("spaCy model en_core_web_sm not installed — NER endpoint disabled")
            logger.warning("Install with: python -m spacy download en_core_web_sm")


@app.route("/v1/embeddings", methods=["POST"])
def embeddings():
    data = request.json
    input_text = data.get("input", [])
    if isinstance(input_text, str):
        input_text = [input_text]

    if not input_text:
        return jsonify({"error": "input required"}), 400

    # Encode with OOM recovery: clear CUDA cache and retry with progressively
    # smaller batches. No CPU fallback — large models get mixed-device errors.
    vectors = None
    batch_sizes = [64, 16, 4, 1]
    for i, bs in enumerate(batch_sizes):
        try:
            vectors = embed_model.encode(
                input_text,
                normalize_embeddings=True,
                batch_size=bs,
                show_progress_bar=False,
            )
            break
        except RuntimeError as e:
            err_str = str(e).lower()
            if "out of memory" in err_str or "cuda" in err_str:
                torch.cuda.empty_cache()
                if i < len(batch_sizes) - 1:
                    logger.warning(f"CUDA OOM — clearing cache, retrying with batch_size={batch_sizes[i+1]}")
                else:
                    logger.error("CUDA OOM at batch_size=1 — GPU is fully exhausted")
                    return jsonify({"error": "GPU out of memory. Close other applications to free VRAM."}), 503
            else:
                raise

    if vectors is None:
        return jsonify({"error": "Embedding failed after retries"}), 503

    response_data = []
    for i, vec in enumerate(vectors):
        response_data.append({
            "object": "embedding",
            "embedding": vec.tolist(),
            "index": i,
        })

    return jsonify({
        "object": "list",
        "data": response_data,
        "model": EMBED_MODEL_ID,
        "usage": {
            "prompt_tokens": sum(len(t.split()) for t in input_text),
            "total_tokens": sum(len(t.split()) for t in input_text),
        },
    })


@app.route("/rerank", methods=["POST"])
def rerank():
    data = request.json
    query = data.get("query", "")
    documents = data.get("documents", [])
    top_k = data.get("top_k", len(documents))

    if not query or not documents:
        return jsonify({"error": "query and documents required"}), 400

    # Truncate inputs for efficiency — cross-encoders plateau after ~512 tokens
    q_truncated = ' '.join(query.split()[:200])
    pairs = [(q_truncated, ' '.join(doc.split()[:512])) for doc in documents]
    scores = None
    for bs in [64, 16, 4, 1]:
        try:
            scores = rerank_model.predict(pairs, batch_size=bs, show_progress_bar=False).tolist()
            break
        except RuntimeError as e:
            err_str = str(e).lower()
            if "out of memory" in err_str or "cuda" in err_str:
                torch.cuda.empty_cache()
                if bs > 1:
                    logger.warning(f"CUDA OOM on rerank — clearing cache, retrying batch_size={bs//4 or 1}")
                else:
                    return jsonify({"error": "GPU out of memory during reranking"}), 503
            else:
                raise

    if scores is None:
        return jsonify({"error": "Reranking failed"}), 503

    results = sorted(
        [{"index": i, "score": s, "text": documents[i]} for i, s in enumerate(scores)],
        key=lambda x: x["score"],
        reverse=True,
    )[:top_k]

    return jsonify({"results": results})


@app.route("/ner", methods=["POST"])
def extract_entities():
    """Extract named entities using spaCy NER model."""
    if ner_model is None:
        return jsonify({"error": "NER model not available", "hint": "pip install spacy && python -m spacy download en_core_web_sm"}), 503

    data = request.get_json(force=True)
    texts = data.get("texts", [])
    if not texts:
        return jsonify({"error": "Missing 'texts' array"}), 400

    # Process texts (cap at 50 per request, cap text length at 10000 chars)
    results = []
    for text in texts[:50]:
        text = text[:10000] if isinstance(text, str) else ""
        doc = ner_model(text)
        entities = []
        seen = set()
        for ent in doc.ents:
            key = (ent.text.lower().strip(), ent.label_)
            if key in seen:
                continue
            seen.add(key)
            entities.append({
                "text": ent.text.strip(),
                "label": ent.label_,
                "start": ent.start_char,
                "end": ent.end_char,
                "context": text[max(0, ent.start_char - 50):ent.end_char + 50].strip(),
            })
        results.append({"entities": entities})

    return jsonify({"results": results})


@app.route("/parse", methods=["POST"])
def parse_document():
    """
    Parse a document using Docling.
    Layout-aware parsing for PDF, DOCX, PPTX, XLSX, HTML, images.
    Loads Docling on-demand and releases GPU memory after parsing.

    Body: { "path": "/path/to/document.pdf" }
    Response: { "markdown": "...", "metadata": { "title": "...", ... } }
    """
    if DOCLING_DEVICE == "off":
        return jsonify({"error": "Docling is disabled (set docling_device to 'cpu' or 'gpu' in config)"}), 503

    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        return jsonify({"error": "Docling not installed. Run: pip install docling"}), 503

    data = request.json
    file_path = data.get("path", "")

    if not file_path:
        return jsonify({"error": "path required"}), 400

    if _is_path_blocked(file_path):
        return jsonify({"error": "Blocked path: contains sensitive file pattern"}), 403

    if not os.path.isfile(file_path):
        return jsonify({"error": f"File not found: {file_path}"}), 404

    try:
        device = DOCLING_DEVICE if DOCLING_DEVICE in ("cpu", "gpu") else "cpu"
        logger.info(f"Parsing document ({device}): {file_path}")

        if _docling_create_converter is None:
            return jsonify({"error": "Docling not installed or API not detected at startup"}), 503
        converter = _docling_create_converter(device)
        result = converter.convert(file_path)
        doc = result.document

        markdown = doc.export_to_markdown()

        metadata = {
            "title": None,
            "author": None,
            "date": None,
            "language": None,
            "page_count": None,
        }

        if hasattr(doc, 'name') and doc.name:
            metadata["title"] = doc.name

        if hasattr(doc, 'origin') and doc.origin:
            origin = doc.origin
            if hasattr(origin, 'filename'):
                if not metadata["title"]:
                    metadata["title"] = origin.filename

        if hasattr(result, 'pages') and result.pages:
            metadata["page_count"] = len(result.pages)

        if markdown:
            metadata["language"] = detect_language(markdown[:2000])

        logger.info(f"Parsed: {file_path} -> {len(markdown)} chars")

        del converter, result, doc
        _cleanup_gpu()

        return jsonify({
            "markdown": markdown,
            "metadata": metadata,
        })

    except Exception as e:
        logger.error(f"Parse failed: {file_path}: {e}")
        logger.error(traceback.format_exc())
        _cleanup_gpu()
        return jsonify({"error": f"Parse failed: {str(e)}"}), 500


def _cleanup_gpu():
    """Release cached GPU memory after Docling parsing."""
    try:
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def detect_language(text):
    """Simple language detection based on character ranges."""
    if not text:
        return "unknown"

    latin = cjk = arabic = cyrillic = hangul = devanagari = 0
    for c in text:
        o = ord(c)
        if o <= 0x007F:
            latin += 1
        elif 0x4E00 <= o <= 0x9FFF:
            cjk += 1
        elif 0x0600 <= o <= 0x06FF:
            arabic += 1
        elif 0x0400 <= o <= 0x04FF:
            cyrillic += 1
        elif 0xAC00 <= o <= 0xD7AF:
            hangul += 1
        elif 0x0900 <= o <= 0x097F:
            devanagari += 1

    total = max(len(text), 1)
    scores = {
        "en": latin / total,
        "zh": cjk / total,
        "ar": arabic / total,
        "ru": cyrillic / total,
        "ko": hangul / total,
        "hi": devanagari / total,
    }

    best = max(scores, key=scores.get)
    if scores[best] < 0.1:
        return "unknown"
    return best


def _is_docling_available():
    try:
        import docling
        return True
    except ImportError:
        return False


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "models": {
            "embed": {"id": EMBED_MODEL_ID, "ready": embed_model is not None},
            "rerank": {"id": RERANK_MODEL_ID, "ready": rerank_model is not None},
            "docling": {"ready": _is_docling_available() and DOCLING_DEVICE != "off", "device": DOCLING_DEVICE},
            "ner": {"ready": ner_model is not None, "model": "en_core_web_sm" if ner_model else None},
        },
    })


@app.route("/shutdown", methods=["POST"])
def shutdown():
    """Graceful shutdown — only from localhost."""
    if request.remote_addr not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        return jsonify({"error": "Forbidden"}), 403
    import threading
    def _exit():
        import time; time.sleep(0.2)
        os._exit(0)
    threading.Thread(target=_exit, daemon=True).start()
    return jsonify({"status": "shutting down"})


if __name__ == "__main__":
    load_models()
    host = os.environ.get("MODEL_SERVER_HOST", "127.0.0.1")
    logger.info(f"ClawCore Model Server starting on {host}:{PORT}")

    # Use Waitress (production WSGI server) if available, else fall back to Flask dev server
    try:
        from waitress import serve
        logger.info("Using Waitress WSGI server")
        serve(app, host=host, port=PORT, threads=4)
    except ImportError:
        logger.warning("Waitress not installed — using Flask dev server (pip install waitress)")
        app.run(host=host, port=PORT, threaded=True)
