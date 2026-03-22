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
import math
import json
import time
import torch
import logging
import traceback
from pathlib import Path
from flask import Flask, request, jsonify
from sentence_transformers import CrossEncoder, SentenceTransformer
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

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
    try:
        with open(config_path) as f:
            config = json.load(f)
        # Use explicit None check (not `or`) to preserve empty strings and falsy values
        _val = config.get("embed_model")
        EMBED_MODEL_ID = _val if _val is not None else "BAAI/bge-large-en-v1.5"
        _val = config.get("rerank_model")
        RERANK_MODEL_ID = _val if _val is not None else "BAAI/bge-reranker-large"
        _val = config.get("docling_device")
        DOCLING_DEVICE = _val if _val is not None else "cpu"
        TRUST_REMOTE = bool(config.get("trust_remote_code", False))
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning(f"config.json is malformed ({e}), falling back to environment variables")
        EMBED_MODEL_ID = os.environ.get("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
        RERANK_MODEL_ID = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-large")
        TRUST_REMOTE = os.environ.get("TRUST_REMOTE_CODE", "0") == "1"
        DOCLING_DEVICE = os.environ.get("DOCLING_DEVICE", "cpu")
else:
    EMBED_MODEL_ID = os.environ.get("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
    RERANK_MODEL_ID = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-large")
    TRUST_REMOTE = os.environ.get("TRUST_REMOTE_CODE", "0") == "1"
    DOCLING_DEVICE = os.environ.get("DOCLING_DEVICE", "cpu")

PORT = int(os.environ.get("MODEL_SERVER_PORT", "8012"))
MAX_PARSE_SIZE_MB = int(os.environ.get("MAX_PARSE_SIZE_MB", "100"))
MAX_PARSE_OUTPUT_MB = int(os.environ.get("MAX_PARSE_OUTPUT_MB", "10"))

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
            fraction = max(0.1, min(1.0, fraction))
            torch.cuda.set_per_process_memory_fraction(fraction, 0)
            total_mb = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
            logger.info(f"VRAM pool: claiming {fraction*100:.0f}% of {total_mb} MB ({int(total_mb * fraction)} MB)")
    except Exception as e:
        logger.warning(f"VRAM reservation failed (non-fatal): {e}")

    kwargs = {"trust_remote_code": True} if TRUST_REMOTE else {}

    # Load embedding model (graceful — server continues if this fails)
    try:
        logger.info(f"Loading embedding model: {EMBED_MODEL_ID} ...")
        embed_model = SentenceTransformer(EMBED_MODEL_ID, **kwargs)
        logger.info(f"Embedding model loaded. Dimension: {embed_model.get_sentence_embedding_dimension()}")
    except Exception as e:
        logger.error(f"Failed to load embedding model '{EMBED_MODEL_ID}': {e}")
        logger.error("The /v1/embeddings endpoint will be unavailable.")

    # Load rerank model (graceful — server continues if this fails)
    try:
        logger.info(f"Loading rerank model: {RERANK_MODEL_ID} ...")
        rerank_model = CrossEncoder(RERANK_MODEL_ID, **kwargs)
        logger.info("Rerank model loaded and ready.")
    except Exception as e:
        logger.error(f"Failed to load rerank model '{RERANK_MODEL_ID}': {e}")
        logger.error("The /rerank endpoint will be unavailable.")

    # Enable float16 inference on CUDA for ~30% speedup, 50% less VRAM
    if embed_model:
        try:
            if torch.cuda.is_available():
                embed_model.half()
                logger.info("Embedding model using float16 (CUDA)")
        except Exception as e:
            logger.warning(f"Could not enable float16 for embedding model: {e}")

    if rerank_model:
        try:
            if torch.cuda.is_available():
                rerank_model.model.half()
                logger.info("Rerank model using float16 (CUDA)")
        except Exception as e:
            logger.warning(f"Could not enable float16 for reranker: {e}")

    # Warmup: run a dummy inference to trigger CUDA kernel compilation / JIT.
    # Also validates float16 didn't produce NaN.
    logger.info("Warming up models...")
    try:
        if embed_model:
            warmup_result = embed_model.encode(["warmup"], normalize_embeddings=True, show_progress_bar=False)
            if any(math.isnan(v) for v in warmup_result[0].tolist()):
                logger.warning("float16 embedding produced NaN — reverting to float32")
                embed_model.float()
                embed_model.encode(["warmup"], normalize_embeddings=True, show_progress_bar=False)
        if rerank_model:
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

    # Load spaCy NER model (optional, configurable via SPACY_NER_MODEL env var)
    # Default: en_core_web_sm (small, runs on any hardware)
    # For better accuracy: set SPACY_NER_MODEL=en_core_web_lg or en_core_web_trf
    ner_model = None
    if _spacy_available:
        ner_model_name = os.environ.get("SPACY_NER_MODEL", "en_core_web_sm")
        try:
            ner_model = spacy.load(ner_model_name)
            logger.info(f"NER model loaded: {ner_model_name}")
        except OSError:
            logger.warning(f"spaCy model {ner_model_name} not installed — NER endpoint disabled")
            logger.warning(f"Install with: python -m spacy download {ner_model_name}")


@app.route("/v1/embeddings", methods=["POST"])
def embeddings():
    if embed_model is None:
        return jsonify({"error": "Embedding model not loaded"}), 503

    data = request.json
    if not data or not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    input_text = data.get("input", [])
    if isinstance(input_text, str):
        input_text = [input_text]
    if not isinstance(input_text, list):
        return jsonify({"error": "input must be string or array of strings"}), 400

    if not input_text:
        return jsonify({"error": "input required"}), 400

    # Validate all items are strings
    for i, t in enumerate(input_text):
        if not isinstance(t, str):
            return jsonify({"error": f"input[{i}] must be a string"}), 400

    # Input size limits
    if len(input_text) > 256:
        return jsonify({"error": f"Too many inputs ({len(input_text)}). Maximum: 256"}), 400
    for i, t in enumerate(input_text):
        if len(t) > 8192:
            input_text[i] = t[:8192]

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
        "created": int(time.time()),
        "usage": {
            "prompt_tokens": sum(max(len(t) // 4, 1) for t in input_text),
            "total_tokens": sum(max(len(t) // 4, 1) for t in input_text),
        },
    })


@app.route("/rerank", methods=["POST"])
def rerank():
    if rerank_model is None:
        return jsonify({"error": "Rerank model not loaded"}), 503

    data = request.json
    if not data or not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    query = data.get("query", "")
    documents = data.get("documents", [])

    if not isinstance(query, str) or not query.strip():
        return jsonify({"error": "query must be a non-empty string"}), 400
    if not isinstance(documents, list) or not documents:
        return jsonify({"error": "documents must be a non-empty array"}), 400
    for i, d in enumerate(documents):
        if not isinstance(d, str):
            return jsonify({"error": f"documents[{i}] must be a string"}), 400

    # Input size limits
    if len(documents) > 500:
        return jsonify({"error": f"Too many documents ({len(documents)}). Maximum: 500"}), 400

    top_k = data.get("top_k", len(documents))
    try:
        top_k = max(1, min(int(top_k), len(documents)))
    except (TypeError, ValueError):
        top_k = len(documents)

    # Truncate inputs for efficiency — cross-encoders plateau after ~512 tokens
    q_truncated = ' '.join(query[:10000].split()[:200])
    pairs = [(q_truncated, ' '.join(doc[:10000].split()[:512])) for doc in documents]
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
                    logger.warning(f"CUDA OOM on rerank at batch_size={bs} — clearing cache, retrying smaller")
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
    if not data or not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    texts = data.get("texts", [])
    if not isinstance(texts, list) or not texts:
        return jsonify({"error": "texts must be a non-empty array"}), 400

    # Process texts (cap at 50 per request, cap text length at 10000 chars)
    results = []
    for text in texts[:50]:
        if not isinstance(text, str):
            text = str(text) if text is not None else ""
        text = text[:10000]
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
    if not data or not isinstance(data, dict):
        return jsonify({"error": "JSON body required"}), 400

    file_path = data.get("path", "")

    if not file_path:
        return jsonify({"error": "path required"}), 400

    # Resolve symlinks and .. traversal to prevent path manipulation
    real_path = os.path.realpath(file_path)

    if _is_path_blocked(real_path):
        return jsonify({"error": "Blocked path: contains sensitive file pattern"}), 403

    if not os.path.isfile(real_path):
        return jsonify({"error": "File not found"}), 404

    # File size limit
    file_size_mb = os.path.getsize(real_path) / (1024 * 1024)
    if file_size_mb > MAX_PARSE_SIZE_MB:
        return jsonify({"error": f"File too large ({file_size_mb:.1f} MB). Maximum: {MAX_PARSE_SIZE_MB} MB"}), 413

    try:
        device = DOCLING_DEVICE if DOCLING_DEVICE in ("cpu", "gpu") else "cpu"
        logger.info(f"Parsing document ({device}): {os.path.basename(real_path)}")

        if _docling_create_converter is None:
            return jsonify({"error": "Docling not installed or API not detected at startup"}), 503

        # Run Docling in a thread with timeout to prevent indefinite hangs
        def _do_parse():
            converter = _docling_create_converter(device)
            result = converter.convert(real_path)
            doc = result.document
            markdown = doc.export_to_markdown()
            metadata = {
                "title": None, "author": None, "date": None,
                "language": None, "page_count": None,
            }
            if hasattr(doc, 'name') and doc.name:
                metadata["title"] = doc.name
            if hasattr(doc, 'origin') and doc.origin:
                if hasattr(doc.origin, 'filename') and not metadata["title"]:
                    metadata["title"] = doc.origin.filename
            if hasattr(result, 'pages') and result.pages:
                metadata["page_count"] = len(result.pages)
            metadata["language"] = detect_language(markdown[:2000]) if markdown else "unknown"
            del converter, result, doc
            return markdown, metadata

        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_do_parse)
            markdown, metadata = future.result(timeout=300)  # 5 minute timeout

        # Guard against enormous Docling output
        max_output_chars = MAX_PARSE_OUTPUT_MB * 1_000_000
        if len(markdown) > max_output_chars:
            _cleanup_gpu()
            return jsonify({"error": f"Parsed output too large ({len(markdown) // 1_000_000} MB). Maximum: {MAX_PARSE_OUTPUT_MB} MB"}), 413

        logger.info(f"Parsed: {os.path.basename(real_path)} -> {len(markdown)} chars")
        _cleanup_gpu()

        return jsonify({
            "markdown": markdown,
            "metadata": metadata,
        })

    except FuturesTimeout:
        logger.error(f"Parse timed out (300s): {os.path.basename(real_path)}")
        _cleanup_gpu()
        return jsonify({"error": "Parse timed out (document too complex or too large)"}), 504
    except Exception as e:
        logger.error(f"Parse failed: {os.path.basename(real_path)}: {str(e)[:500]}")
        _cleanup_gpu()
        return jsonify({"error": "Parse failed"}), 500


def _cleanup_gpu():
    """Release cached GPU memory after Docling parsing."""
    try:
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception as e:
        logger.warning(f"GPU cleanup failed (non-fatal): {e}")


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
            "embed": {
                "id": EMBED_MODEL_ID,
                "ready": embed_model is not None,
                "dimension": embed_model.get_sentence_embedding_dimension() if embed_model else None,
            },
            "rerank": {"id": RERANK_MODEL_ID, "ready": rerank_model is not None},
            "docling": {"ready": _is_docling_available() and DOCLING_DEVICE != "off", "device": DOCLING_DEVICE},
            "ner": {"ready": ner_model is not None, "model": "en_core_web_sm" if ner_model else None, "available": _spacy_available},
        },
    })


@app.route("/shutdown", methods=["POST"])
def shutdown():
    """Graceful shutdown — only from localhost."""
    if request.remote_addr not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        return jsonify({"error": "Forbidden"}), 403
    logger.info("Shutdown requested, exiting in 0.5s")
    import threading
    def _exit():
        time.sleep(0.5)
        # Release CUDA resources before exit
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        os._exit(0)
    threading.Thread(target=_exit, daemon=True).start()
    return jsonify({"status": "shutting down"})


if __name__ == "__main__":
    load_models()
    host = os.environ.get("MODEL_SERVER_HOST", "127.0.0.1")
    logger.info(f"ClawCore Model Server starting on {host}:{PORT}")

    # Use Waitress (production WSGI server) if available, else fall back to Flask dev server.
    # threads=1: GPU inference is not thread-safe; Waitress queues requests naturally.
    try:
        from waitress import serve
        logger.info("Using Waitress WSGI server (single-threaded for CUDA safety)")
        serve(app, host=host, port=PORT, threads=1, channel_timeout=120)
    except ImportError:
        logger.warning("Waitress not installed — using Flask dev server (pip install waitress)")
        app.run(host=host, port=PORT, threaded=False)
