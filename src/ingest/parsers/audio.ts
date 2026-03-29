/**
 * Audio parser — transcribes audio files via OpenAI Whisper.
 *
 * Supports: .mp3, .wav, .m4a, .ogg, .flac, .webm
 * Requires: Python + openai-whisper package OR whisper.cpp
 *   Install: pip install openai-whisper
 *
 * This parser is OPT-IN — requires AUDIO_TRANSCRIPTION_ENABLED=true in .env.
 * Transcription is CPU/GPU intensive and can take 30-120s per file.
 */

import { basename, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import type { ParsedDocument, DocMetadata } from "./index.js";
import { getSystemPythonCmd } from "../../tui/platform.js";

const execFileAsync = promisify(execFile);

const WHISPER_MODELS = new Set([
  "tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo",
]);

// Cache which whisper invocation method works (direct CLI vs python -m)
// TODO: This cache never invalidates. Add a TTL (e.g., 5 minutes) to re-check
// after user installs/uninstalls whisper.
let _whisperAvailable: boolean | null = null;
let _whisperMethod: "cli" | "python-m" | null = null;

async function isWhisperAvailable(): Promise<boolean> {
  if (_whisperAvailable !== null) return _whisperAvailable;
  try {
    await execFileAsync("whisper", ["--help"], { timeout: 10000 });
    _whisperAvailable = true;
    _whisperMethod = "cli";
  } catch {
    try {
      await execFileAsync(getSystemPythonCmd(), ["-m", "whisper", "--help"], { timeout: 10000 });
      _whisperAvailable = true;
      _whisperMethod = "python-m";
    } catch {
      _whisperAvailable = false;
    }
  }
  return _whisperAvailable;
}

function isAudioTranscriptionEnabled(): boolean {
  return process.env.AUDIO_TRANSCRIPTION_ENABLED === "true";
}

export async function parseAudio(filePath: string): Promise<ParsedDocument> {
  const metadata: DocMetadata = {
    fileType: "audio",
    title: basename(filePath),
    source: filePath,
  };

  if (!existsSync(filePath)) {
    return { text: `[Audio: ${basename(filePath)} — file not found]`, structure: [], metadata };
  }

  if (!isAudioTranscriptionEnabled()) {
    return {
      text: `[Audio: ${basename(filePath)} — transcription disabled. Set AUDIO_TRANSCRIPTION_ENABLED=true to enable.]`,
      structure: [],
      metadata,
    };
  }

  if (!(await isWhisperAvailable())) {
    return {
      text: `[Audio: ${basename(filePath)} — Whisper not installed. Run: pip install openai-whisper]`,
      structure: [],
      metadata,
    };
  }

  // Unique temp dir per call to prevent concurrent ingest collisions
  const outputDir = mkdtempSync(join(tmpdir(), "threadclaw-whisper-"));

  try {
    // Validate model against allowlist
    const modelEnv = process.env.WHISPER_MODEL ?? "base";
    const model = WHISPER_MODELS.has(modelEnv) ? modelEnv : "base";

    // Use the method that succeeded during availability check
    const args = [
      filePath,
      "--model", model,
      "--output_format", "txt",
      "--output_dir", outputDir,
      "--fp16", "False",
    ];
    const execOpts = {
      timeout: 300000, // 5 min max for large files
      maxBuffer: 50 * 1024 * 1024,
    };

    if (_whisperMethod === "python-m") {
      await execFileAsync(getSystemPythonCmd(), ["-m", "whisper", ...args], execOpts);
    } else {
      await execFileAsync("whisper", args, execOpts);
    }

    // Whisper outputs to <basename>.txt in the output dir
    const baseName = basename(filePath).replace(/\.[^.]+$/, "");
    const whisperOutput = join(outputDir, baseName + ".txt");

    let transcript = "";
    if (existsSync(whisperOutput)) {
      transcript = readFileSync(whisperOutput, "utf-8").trim();
    }

    if (!transcript || transcript.length < 3) {
      return {
        text: `[Audio: ${basename(filePath)} — no speech detected]`,
        structure: [],
        metadata,
      };
    }

    return { text: transcript, structure: [], metadata };
  } catch (err: any) {
    return {
      text: `[Audio: ${basename(filePath)} — transcription failed: ${err.message?.substring(0, 100) ?? "unknown error"}]`,
      structure: [],
      metadata,
    };
  } finally {
    try { rmSync(outputDir, { recursive: true, force: true }); } catch {}
  }
}
