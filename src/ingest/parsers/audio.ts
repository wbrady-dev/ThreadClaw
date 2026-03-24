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

import { basename } from "path";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ParsedDocument, DocMetadata } from "./index.js";
import { getSystemPythonCmd } from "../../tui/platform.js";

const WHISPER_MODELS = new Set([
  "tiny", "base", "small", "medium", "large", "large-v2", "large-v3", "turbo",
]);

let _whisperAvailable: boolean | null = null;

function isWhisperAvailable(): boolean {
  if (_whisperAvailable !== null) return _whisperAvailable;
  try {
    execFileSync("whisper", ["--help"], { stdio: "pipe", timeout: 10000 });
    _whisperAvailable = true;
  } catch {
    try {
      execFileSync(getSystemPythonCmd(), ["-m", "whisper", "--help"], { stdio: "pipe", timeout: 10000 });
      _whisperAvailable = true;
    } catch {
      _whisperAvailable = false;
    }
  }
  return _whisperAvailable;
}

export function isAudioTranscriptionEnabled(): boolean {
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

  if (!isWhisperAvailable()) {
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

    // Run Whisper transcription — execFileSync with args array prevents shell injection
    execFileSync("whisper", [
      filePath,
      "--model", model,
      "--output_format", "txt",
      "--output_dir", outputDir,
      "--fp16", "False",
    ], {
      stdio: "pipe",
      timeout: 300000, // 5 min max for large files
      maxBuffer: 50 * 1024 * 1024,
    });

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
