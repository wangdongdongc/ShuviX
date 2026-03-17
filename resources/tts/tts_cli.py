#!/usr/bin/env python3
"""
Qwen3-TTS CLI — ShuviX 本地语音合成脚本

Usage:
  python3 tts_cli.py --text "你好世界" --output /tmp/hello.wav [--voice Vivian] [--emotion "cheerful"] [--speed 1.0] [--models-dir /path/to/models]
"""

import argparse
import os
import sys
import shutil
import warnings
import gc

os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

DEFAULT_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def get_model_path(models_dir, folder_name):
    full_path = os.path.join(models_dir, folder_name)
    if not os.path.exists(full_path):
        return None
    snapshots_dir = os.path.join(full_path, "snapshots")
    if os.path.exists(snapshots_dir):
        subfolders = [f for f in os.listdir(snapshots_dir) if not f.startswith(".")]
        if subfolders:
            return os.path.join(snapshots_dir, subfolders[0])
    return full_path


def main():
    parser = argparse.ArgumentParser(description="Qwen3-TTS CLI for ShuviX")
    parser.add_argument("--text", required=True, help="Text to speak")
    parser.add_argument("--output", required=True, help="Output WAV file path")
    parser.add_argument("--voice", default="Vivian", help="Voice name")
    parser.add_argument("--emotion", default="", help="Emotion/style instruction")
    parser.add_argument("--speed", type=float, default=1.0, help="Speed multiplier")
    parser.add_argument("--model", default="CustomVoice-1.7B", help="Model folder name")
    parser.add_argument("--models-dir", default=DEFAULT_MODELS_DIR, help="Models directory path")
    args = parser.parse_args()

    model_path = get_model_path(args.models_dir, args.model)
    if not model_path:
        print(f"Error: Model not found at {args.models_dir}/{args.model}", file=sys.stderr)
        sys.exit(1)

    try:
        from mlx_audio.tts.utils import load_model
        from mlx_audio.tts.generate import generate_audio
    except ImportError:
        print("Error: mlx_audio not installed.", file=sys.stderr)
        sys.exit(1)

    instruct = args.emotion if args.emotion else "Speak naturally"

    temp_dir = f"/tmp/shuvix_tts_{os.getpid()}"
    os.makedirs(temp_dir, exist_ok=True)

    try:
        print(f"Loading model: {args.model}...", file=sys.stderr)
        model = load_model(model_path)

        print(
            f'Generating: "{args.text[:50]}..." voice={args.voice}',
            file=sys.stderr,
        )
        generate_audio(
            model=model,
            text=args.text,
            voice=args.voice,
            instruct=instruct,
            speed=args.speed,
            output_path=temp_dir,
        )

        source = os.path.join(temp_dir, "audio_000.wav")
        if os.path.exists(source):
            os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
            shutil.move(source, args.output)
            print(args.output)
        else:
            print("Error: No audio generated", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
        gc.collect()


if __name__ == "__main__":
    main()
