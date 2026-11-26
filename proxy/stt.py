#!/usr/bin/env python3
"""Groq Whisper transcription worker for the HyperGlance proxy.

Reads a WAV file path from argv, POSTs it to Groq's OpenAI-compatible
/audio/transcriptions endpoint with the Bearer key from GROQ_API_KEY
(bridged by groq.py run — the raw key is never in a file, env var or log).
Prints one JSON object to stdout: {"text": "...", "language": "..."}.

Stdlib only (urllib) so it runs under any python3.
"""
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

API_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def encode_multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += f"{value}\r\n".encode()
    for name, filename, content_type, data in files:
        body += f"--{boundary}\r\n".encode()
        body += (
            f'Content-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\n'
        ).encode()
        body += f"Content-Type: {content_type}\r\n\r\n".encode()
        body += data
        body += b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: stt.py <wav-file>"}))
        return 2
    wav_path = sys.argv[1]
    key = os.environ.get("GROQ_API_KEY", "")
    if not key:
        print(json.dumps({"error": "GROQ_API_KEY missing"}))
        return 2
    try:
        with open(wav_path, "rb") as f:
            audio = f.read()
    except OSError as e:
        print(json.dumps({"error": f"cannot read wav: {e}"}))
        return 2
    fields = {
        "model": MODEL,
        "language": "id",
        "response_format": "json",
    }
    files = [("file", "audio.wav", "audio/wav", audio)]
    body, content_type = encode_multipart(fields, files)
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
            "User-Agent": BROWSER_UA,
        },
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=90) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            detail = ""
        print(json.dumps({"error": f"groq HTTP {e.code}: {detail}"}))
        return 3
    except Exception as e:
        print(json.dumps({"error": f"groq request failed: {e}"}))
        return 3
    print(json.dumps({"text": payload.get("text", ""), "language": payload.get("language", "")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
