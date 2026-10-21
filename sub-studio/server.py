"""Sub Studio — локальный редактор субтитров. Запуск: «Sub Studio.bat» в корне проекта."""

import base64
import ctypes
import hashlib
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from pathlib import Path

import numpy as np
import requests
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = ROOT / "cache"
RECENT_PATH = ROOT / "recent.json"
DOWNLOADER_CFG = ROOT.parent / "settings.json"
PORT = 8765
MEDIA_EXT = {".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".wav", ".ogg", ".opus", ".flac"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

app = Flask(__name__, static_folder=None)
files = {}  # id -> Path: отдаём только то, что пользователь сам открыл
jobs = {}
whisper_lock = threading.Lock()  # распознаём по одному участку за раз
model_lock = threading.Lock()  # и грузим по одной модели
models = {}  # name, device, model — та, что сейчас в памяти; loading — та, что грузится
cuda_broken = False
WINDOW = None  # окно приложения, если запущены в своём окне, а не в браузере


# --- защита: только с этого компьютера и только со своей страницы ------------

@app.before_request
def guard():
    if request.host.split(":")[0] not in ("127.0.0.1", "localhost"):
        abort(403)
    if request.method == "POST" and request.headers.get("X-Sub-Studio") != "1":
        abort(403)


@app.errorhandler(Exception)
def on_error(e):
    code = getattr(e, "code", 500)
    return jsonify(error=str(getattr(e, "description", e))), code if isinstance(code, int) else 500


# --- служебное ----------------------------------------------------------------

def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def project_path(media):
    return media.with_name(media.stem + ".substudio.json")


def media_for(fid):
    path = files.get(fid)
    if not path:
        abort(404, "Файл не открыт — открой видео заново")
    return path


def downloads_folder():
    folder = read_json(DOWNLOADER_CFG, {}).get("folder")
    return Path(folder) if folder else Path.home() / "Downloads"


def remember_recent(path):
    recent = [p for p in read_json(RECENT_PATH, []) if p != str(path)]
    recent.insert(0, str(path))
    RECENT_PATH.write_text(json.dumps(recent[:15], ensure_ascii=False, indent=2), encoding="utf-8")


def ffmpeg_pcm(path, rate, fmt, start=None, end=None):
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if end:
        cmd += ["-t", f"{end - (start or 0):.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", str(rate), "-f", fmt, "-"]
    proc = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg: " + proc.stderr.decode(errors="replace")[-600:])
    return proc.stdout


def start_job(fn, *args):
    jid = uuid.uuid4().hex[:12]
    job = {"status": "running", "progress": 0, "message": "", "result": None, "error": None}
    jobs[jid] = job

    def run():
        try:
            job["result"] = fn(job, *args)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001 — ошибку показываем в интерфейсе
            job["error"] = str(e)
            job["status"] = "error"

    threading.Thread(target=run, daemon=True).start()
    return jid


# --- страницы и медиа ---------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(STATIC, name)


@app.get("/media/<fid>")
def media(fid):
    path = media_for(fid)
    mime = "video/webm" if path.suffix.lower() == ".mkv" else None  # Chrome играет mkv как webm
    return send_file(path, mimetype=mime, conditional=True)


# --- файлы --------------------------------------------------------------------

PICK_SCRIPT = r"""
import sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk(); r.withdraw(); r.attributes("-topmost", True)
p = filedialog.askopenfilename(parent=r, title="Открыть видео", initialdir=sys.argv[1],
    filetypes=[("Видео и звук", "*.mp4 *.mkv *.webm *.mov *.m4a *.mp3 *.wav *.ogg *.opus *.flac"), ("Все файлы", "*.*")])
sys.stdout.buffer.write(p.encode("utf-8"))
"""


@app.post("/api/pick")
def pick():
    if WINDOW:
        import webview
        exts = ";".join("*" + e for e in sorted(MEDIA_EXT))
        res = WINDOW.create_file_dialog(webview.FileDialog.OPEN, directory=str(downloads_folder()),
                                        file_types=(f"Видео и звук ({exts})", "Все файлы (*.*)"))
        return jsonify(path=res[0] if res else "")
    proc = subprocess.run([sys.executable.replace("pythonw", "python"), "-c", PICK_SCRIPT, str(downloads_folder())],
                          capture_output=True, creationflags=NO_WINDOW)
    return jsonify(path=proc.stdout.decode("utf-8").strip())


@app.get("/api/recent")
def recent():
    rec = [p for p in read_json(RECENT_PATH, []) if Path(p).exists()]
    folder = downloads_folder()
    dl = []
    if folder.is_dir():
        dl = sorted((p for p in folder.iterdir() if p.suffix.lower() in MEDIA_EXT),
                    key=lambda p: p.stat().st_mtime, reverse=True)[:15]
    return jsonify(recent=rec, downloads=[str(p) for p in dl], folder=str(folder))


@app.post("/api/open")
def open_media():
    path = Path(request.json["path"])
    if not path.is_file():
        abort(404, f"Файл не найден: {path}")
    if path.suffix.lower() not in MEDIA_EXT:
        abort(400, "Это не видео/аудио файл")
    fid = next((k for k, v in files.items() if v == path), None) or uuid.uuid4().hex[:12]
    files[fid] = path
    remember_recent(path)
    return jsonify(id=fid, path=str(path), name=path.name, project=read_json(project_path(path), None))


@app.post("/api/project")
def save_project():
    path = project_path(media_for(request.json["id"]))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(request.json["project"], ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
    return jsonify(ok=True)


@app.post("/api/export")
def export():
    media_path = media_for(request.json["id"])
    suffix = request.json["suffix"]
    if not re.fullmatch(r"(\.[\w-]+)+", suffix):
        abort(400, "Плохое расширение файла")
    out = media_path.with_name(media_path.stem + suffix)
    out.write_text(request.json["content"], encoding="utf-8")
    return jsonify(path=str(out))


@app.post("/api/reveal")
def reveal():
    media_path = media_for(request.json["id"])
    name = request.json.get("name") or media_path.name
    target = media_path.with_name(Path(name).name)
    subprocess.Popen(["explorer", "/select,", str(target if target.exists() else media_path)])
    return jsonify(ok=True)


# --- звуковая дорожка ---------------------------------------------------------

PEAK_RATE = 100  # столбиков на секунду


@app.get("/api/waveform/<fid>")
def waveform(fid):
    path = media_for(fid)
    st = path.stat()
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()
    cached = CACHE / f"{key}.json"
    if cached.exists():
        return send_file(cached, mimetype="application/json")
    rate = 4000
    a = np.frombuffer(ffmpeg_pcm(path, rate, "s16le"), dtype=np.int16)
    per = rate // PEAK_RATE
    n = len(a) // per
    peaks = np.zeros(0, np.uint8)
    if n:
        blocks = np.abs(a[: n * per].astype(np.int32)).reshape(n, per).max(axis=1)
        ref = max(float(np.percentile(blocks, 99.5)), 1.0)
        peaks = np.clip(blocks / ref * 255, 0, 255).astype(np.uint8)
    data = {"rate": PEAK_RATE, "duration": len(a) / rate, "peaks": base64.b64encode(peaks.tobytes()).decode()}
    CACHE.mkdir(exist_ok=True)
    cached.write_text(json.dumps(data), encoding="utf-8")
    return jsonify(data)


# --- распознавание речи -------------------------------------------------------

MODEL_NAMES = ["base", "small", "medium", "large-v3-turbo"]
MODEL_MB = {"base": 145, "small": 465, "medium": 1460, "large-v3-turbo": 1550}


def model_path(name, download=False, say=lambda m: None):
    """Папка модели на диске. Скачанную берём без обращения к интернету; новую качаем один раз."""
    from faster_whisper.utils import download_model
    try:
        return download_model(name, local_files_only=True)
    except Exception:  # noqa: BLE001 — значит, ещё не скачана
        if not download:
            return None
    say(f"Скачиваю модель {name} (~{MODEL_MB.get(name, '?')} МБ). Это только в первый раз — дальше она берётся с диска…")
    return download_model(name)


def cuda_ready():
    """Видеокарту пробуем, только если на месте библиотеки CUDA, — иначе каждая неудачная попытка стоит секунд."""
    global cuda_broken
    if cuda_broken:
        return False
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() == 0:
            raise OSError("нет видеокарты NVIDIA")
        # библиотеки из пакетов nvidia-cublas-cu12 / nvidia-cudnn-cu12, если они поставлены через pip
        for bin_dir in (Path(sys.prefix) / "Lib" / "site-packages" / "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]
        for dll in ("cublas64_12.dll", "cudnn64_9.dll"):
            ctypes.WinDLL(dll)
        return True
    except Exception:  # noqa: BLE001
        cuda_broken = True
        return False


def devices():
    return ["cuda", "cpu"] if cuda_ready() else ["cpu"]


def get_model(name, say=lambda m: None):
    """Модель из памяти, а если её там нет — с диска (одна модель за раз: они большие)."""
    global cuda_broken
    with model_lock:
        if models.get("name") == name and not (models["device"] == "cuda" and cuda_broken):
            return models["model"], models["device"]
        path = model_path(name, download=True, say=say)
        models.clear()
        models["loading"] = name
        try:
            from faster_whisper import WhisperModel
            say(f"Загружаю модель {name} в память — это один раз за запуск…")
            for device in devices():
                try:
                    model = WhisperModel(path, device=device, compute_type="int8")
                    models.update(name=name, device=device, model=model)
                    return model, device
                except Exception:  # noqa: BLE001
                    if device == "cpu":
                        raise
                    cuda_broken = True
        finally:
            models.pop("loading", None)


@app.get("/api/models")
def models_info():
    return jsonify(downloaded=[n for n in MODEL_NAMES if model_path(n)], loaded=models.get("name"),
                   loading=models.get("loading"), device=models.get("device"))


@app.post("/api/models/preload")
def models_preload():
    """Заранее поднимаем модель в память, пока человек смотрит видео, — к распознаванию она уже готова."""
    name = request.json.get("model")
    if name in MODEL_NAMES and models.get("name") != name and not model_lock.locked() and model_path(name):
        def run():
            try:
                get_model(name)
            except Exception as e:  # noqa: BLE001 — при распознавании ошибка покажется ещё раз, уже в интерфейсе
                print("Модель не загрузилась:", e)
        threading.Thread(target=run, daemon=True).start()
    return jsonify(ok=True)


def wrap_lines(text, limit=42):
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    spaces = [i for i, c in enumerate(text) if c == " "]
    if not spaces:
        return text
    mid = len(text) // 2
    i = min(spaces, key=lambda i: abs(i - mid))
    return text[:i] + "\n" + text[i + 1:]


def build_cues(words, offset, max_chars=84, max_dur=6.0, line=42):
    """Режет поток слов на удобные для чтения субтитры."""
    cues, cur = [], []

    def flush():
        if cur:
            text = "".join(w[2] for w in cur).strip()
            if text:
                cues.append({"start": cur[0][0], "end": cur[-1][1], "text": wrap_lines(text, line)})
            cur.clear()

    for w in words:
        if cur:
            size = len("".join(x[2] for x in cur).strip())
            last = cur[-1][2].strip()
            if (w[0] - cur[-1][1] > 0.7 or size + len(w[2]) > max_chars or w[1] - cur[0][0] > max_dur
                    or (size > 25 and last[-1:] in ".?!…") or (size > 50 and last[-1:] in ",;:")):
                flush()
        cur.append(w)
    flush()

    for i, c in enumerate(cues):  # чуть продлеваем показ, но без наложений
        nxt = cues[i + 1]["start"] if i + 1 < len(cues) else c["end"] + 1
        c["end"] = min(max(c["end"] + 0.25, c["start"] + 0.8), nxt - 0.04) if nxt > c["end"] else c["end"]
        c["start"] = round(c["start"] + offset, 3)
        c["end"] = round(c["end"] + offset, 3)
    return cues


def transcribe_job(job, path, start, end, lang, model_name):
    global cuda_broken
    job["message"] = "Жду, пока закончится предыдущее распознавание…"
    with whisper_lock:
        job["message"] = "Вырезаю звук…"
        audio = np.frombuffer(ffmpeg_pcm(path, 16000, "f32le", start, end), dtype=np.float32)
        dur = len(audio) / 16000
        if dur < 0.3:
            raise RuntimeError("Слишком короткий участок")
        for attempt in range(2):
            model, device = get_model(model_name, say=lambda m: job.update(message=m))
            try:
                job["message"] = "Распознаю речь (" + ("видеокарта" if device == "cuda" else "процессор") + ")…"
                segments, info = model.transcribe(audio, language=lang or None, vad_filter=True,
                                                  word_timestamps=True, beam_size=5,
                                                  condition_on_previous_text=False)
                words = []
                for seg in segments:
                    job["progress"] = min(99.0, seg.end / dur * 100)
                    if seg.words:
                        words += [(w.start, w.end, w.word) for w in seg.words]
                    else:
                        words.append((seg.start, seg.end, " " + seg.text.strip()))
                return {"cues": build_cues(words, start or 0), "language": info.language, "device": device}
            except Exception:  # noqa: BLE001 — видеокарта подвела посреди работы: повторяем на процессоре
                if device != "cuda" or attempt:
                    raise
                cuda_broken = True


@app.post("/api/transcribe")
def transcribe():
    body = request.json
    path = media_for(body["id"])
    jid = start_job(transcribe_job, path, float(body.get("start") or 0), body.get("end"),
                    body.get("lang") or "", body.get("model") or "small")
    return jsonify(job=jid)


# --- перевод ------------------------------------------------------------------

def google_translate(text, src, tgt):
    for attempt in range(3):
        r = requests.post("https://translate.googleapis.com/translate_a/single",
                          params={"client": "gtx", "sl": src or "auto", "tl": tgt, "dt": "t"},
                          data={"q": text}, timeout=30)
        if r.status_code == 429 and attempt < 2:
            time.sleep(2 + attempt * 3)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"Google Translate ответил {r.status_code}. Попробуй позже.")
        return "".join(part[0] for part in r.json()[0] if part and part[0])
    return ""


def translate_job(job, texts, src, tgt, glossary):
    glossary = [(a.strip(), b.strip()) for a, b in glossary if a.strip()]

    def protect(t):
        for k, (a, _) in enumerate(glossary):
            t = re.sub(re.escape(a), f"ZQX{k}Z", t, flags=re.I)
        return t

    def restore(t):
        for k, (_, b) in enumerate(glossary):
            t = re.sub(rf"ZQX\s*{k}\s*Z", b, t, flags=re.I)
        return t

    prepared = [protect(" ".join(re.sub(r"<[^>]+>", "", t).split())) for t in texts]
    out = [""] * len(texts)
    chunks, cur, size = [], [], 0
    for i, t in enumerate(prepared):
        if not t:
            continue
        if cur and size + len(t) + 1 > 3000:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(i)
        size += len(t) + 1
    if cur:
        chunks.append(cur)

    done = 0
    job["message"] = "Перевожу…"
    for chunk in chunks:
        res = google_translate("\n".join(prepared[i] for i in chunk), src, tgt)
        parts = res.split("\n")
        if len(parts) != len(chunk):  # Google склеил строки — переводим по одной
            parts = [google_translate(prepared[i], src, tgt) for i in chunk]
        for i, p in zip(chunk, parts):
            out[i] = wrap_lines(restore(p.strip()))
        done += len(chunk)
        job["progress"] = done / max(1, len([t for t in prepared if t])) * 100
    return {"texts": out}


@app.post("/api/translate")
def translate():
    body = request.json
    jid = start_job(translate_job, body["texts"], body.get("source"), body["target"], body.get("glossary") or [])
    return jsonify(job=jid)


# --- вшивание сабов в видео ---------------------------------------------------

FONTS_DIR = ROOT / "fonts"
GOOGLE_FONTS = [("family", "Roboto:ital,wght@0,400;0,700;1,400;1,700"), ("family", "Carrois Gothic SC")]
X264 = {"high": ["-crf", "17", "-preset", "slow"], "normal": ["-crf", "20", "-preset", "medium"],
        "fast": ["-crf", "23", "-preset", "veryfast"]}
NVENC = {"high": ("19", "p6"), "normal": ("23", "p5"), "fast": ("27", "p3")}
AUDIO_COPY = {"aac", "mp3", "opus", "ac3", "eac3", "alac"}
nvenc_ok = None


def has_nvenc():
    global nvenc_ok
    if nvenc_ok is None:
        r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2",
                            "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True, creationflags=NO_WINDOW)
        nvenc_ok = r.returncode == 0
    return nvenc_ok


def ensure_fonts(job):
    """Шрифтов YouTube (Roboto, Carrois Gothic SC) обычно нет в Windows — один раз скачиваем их с Google Fonts."""
    if any(FONTS_DIR.glob("*.ttf")):
        return
    job["message"] = "Скачиваю шрифты YouTube (один раз)…"
    try:
        css = requests.get("https://fonts.googleapis.com/css2", params=GOOGLE_FONTS, timeout=20).text
        FONTS_DIR.mkdir(exist_ok=True)
        pattern = r"font-family: '([^']+)';\s*font-style: (\w+);\s*font-weight: (\d+);.*?src: url\((\S+?\.ttf)\)"
        for family, style, weight, url in re.findall(pattern, css, re.S):
            data = requests.get(url, timeout=30).content
            (FONTS_DIR / f"{family.replace(' ', '')}-{weight}-{style}.ttf").write_bytes(data)
    except Exception:  # noqa: BLE001 — без интернета libass возьмёт похожий системный шрифт
        job["message"] = "Шрифты скачать не удалось — будет похожий системный"


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration",
                        "-of", "json", str(path)], capture_output=True, creationflags=NO_WINDOW)
    info = json.loads(r.stdout or b"{}")
    streams = info.get("streams", [])
    video = any(s.get("codec_type") == "video" and s.get("codec_name") not in ("mjpeg", "png") for s in streams)
    audio = next((s.get("codec_name") for s in streams if s.get("codec_type") == "audio"), None)
    return video, audio, float(info.get("format", {}).get("duration") or 0)


def run_ffmpeg(job, cmd, duration, label):
    err_path = CACHE / f"ffmpeg_{uuid.uuid4().hex[:8]}.log"
    with open(err_path, "w", encoding="utf-8", errors="replace") as err:
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=err, text=True,
                                creationflags=NO_WINDOW)
        job["_proc"] = proc
        speed = ""
        for line in proc.stdout:
            key, _, value = line.strip().partition("=")
            if key == "speed" and value not in ("N/A", ""):
                speed = value
            if key == "out_time_us" and value.isdigit() and duration:
                job["progress"] = min(99.0, int(value) / 1e6 / duration * 100)
                job["message"] = f"{label} {job['progress']:.0f}%" + (f" · скорость {speed}" if speed else "")
        proc.wait()
    tail = err_path.read_text(encoding="utf-8", errors="replace")[-800:]
    err_path.unlink(missing_ok=True)
    return proc.returncode, tail


def burn_job(job, path, ass_text, start, end, quality, encoder, out):
    ensure_fonts(job)
    video, audio, total = probe(path)
    if not video:
        raise RuntimeError("В этом файле нет видео — вшивать сабы некуда")
    CACHE.mkdir(exist_ok=True)
    ass_path = CACHE / f"burn_{uuid.uuid4().hex[:8]}.ass"
    ass_path.write_text(ass_text, encoding="utf-8")
    tmp = out.with_name(out.stem + ".part" + out.suffix)
    duration = (end - start) if end else max(0.0, total - start)
    try:
        encoders = ["nvenc", "x264"] if encoder == "nvenc" and has_nvenc() else ["x264"]
        for enc in encoders:
            cmd = ["ffmpeg", "-y", "-hide_banner", "-nostdin", "-v", "error"]
            if start:
                cmd += ["-ss", f"{start:.3f}"]
            cmd += ["-i", str(path)]
            if end:
                cmd += ["-t", f"{end - start:.3f}"]
            # пути относительные (cwd = папка Sub Studio): в фильтрах ffmpeg двоеточие из «C:\» ломает разбор
            cmd += ["-vf", f"ass=filename=cache/{ass_path.name}:fontsdir=fonts", "-map", "0:v:0", "-map", "0:a:0?"]
            if enc == "nvenc":
                cq, preset = NVENC[quality]
                cmd += ["-c:v", "h264_nvenc", "-rc", "vbr", "-cq", cq, "-b:v", "0", "-preset", preset]
            else:
                cmd += ["-c:v", "libx264", *X264[quality]]
            cmd += ["-pix_fmt", "yuv420p"]
            cmd += ["-c:a", "copy"] if audio in AUDIO_COPY else ["-c:a", "aac", "-b:a", "192k"]
            cmd += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(tmp)]
            label = "Вшиваю сабы (" + ("видеокарта" if enc == "nvenc" else "процессор") + ")…"
            job["message"] = label
            code, tail = run_ffmpeg(job, cmd, duration, label)
            if job.get("cancelled"):
                raise RuntimeError("Отменено")
            if code == 0:
                tmp.replace(out)
                return {"path": str(out), "encoder": enc}
            if enc == "x264":
                raise RuntimeError("ffmpeg: " + tail)
            job["message"] = "Видеокарта не справилась — переключаюсь на процессор…"
    finally:
        ass_path.unlink(missing_ok=True)
        tmp.unlink(missing_ok=True)


@app.get("/api/burn/caps")
def burn_caps():
    return jsonify(nvenc=has_nvenc())


@app.post("/api/burn")
def burn():
    body = request.json
    path = media_for(body["id"])
    suffix = body["suffix"]
    if not re.fullmatch(r"(\.[\w-]+)+\.mp4", suffix):
        abort(400, "Плохое имя файла")
    out = path.with_name(path.stem + suffix)
    if out == path:
        abort(400, "Нельзя перезаписать исходное видео")
    start = float(body.get("start") or 0)
    end = float(body["end"]) if body.get("end") else None
    quality = body.get("quality") if body.get("quality") in X264 else "normal"
    jid = start_job(burn_job, path, body["ass"], start, end, quality, body.get("encoder") or "nvenc", out)
    return jsonify(job=jid)


@app.post("/api/job/<jid>/cancel")
def job_cancel(jid):
    job = jobs.get(jid)
    if not job:
        abort(404, "Задача не найдена")
    cancel_job(job)
    return jsonify(ok=True)


def cancel_job(job):
    job["cancelled"] = True
    proc = job.get("_proc")
    if proc and proc.poll() is None:
        proc.terminate()


@app.get("/api/job/<jid>")
def job_status(jid):
    job = jobs.get(jid)
    if not job:
        abort(404, "Задача не найдена")
    return jsonify({k: v for k, v in job.items() if not k.startswith("_")})


# --- запуск -------------------------------------------------------------------

APP_ID = "sub-studio/2"
ICON = STATIC / "icon.ico"
LOG_PATH = ROOT / "sub-studio.log"


@app.get("/api/ping")
def ping():
    return jsonify(app=APP_ID)


@app.post("/api/focus")
def focus():
    """Повторный запуск не открывает второе окно, а показывает уже открытое."""
    if WINDOW:
        WINDOW.restore()
        WINDOW.show()
        WINDOW.on_top = True
        WINDOW.on_top = False
    return jsonify(ok=bool(WINDOW))


def instance_on(port):
    """Кто слушает порт: никто (None), наша Sub Studio этой версии (True) или что-то другое (False)."""
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return None
    try:
        return requests.get(f"http://127.0.0.1:{port}/api/ping", timeout=2).json().get("app") == APP_ID
    except Exception:  # noqa: BLE001
        return False


def windows_light_theme():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 1
    except OSError:
        return False


def style_title_bar(window, light):
    """Заголовок окна — в цвет шапки приложения (Windows 11); на Windows 10 он хотя бы станет тёмным."""
    try:
        hwnd = ctypes.c_void_p(window.native.Handle.ToInt64())
        for attr, value in ((20, 0 if light else 1),  # тёмная тема рамки
                            (35, 0xFFFFFF if light else 0x27201D),  # цвет заголовка (0xBBGGRR) = --panel
                            (36, 0x251E1B if light else 0xEEE8E6)):  # цвет текста = --text
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(ctypes.c_int(value)), 4)
    except Exception as e:  # noqa: BLE001 — это украшение, без него тоже работает
        print("Не получилось покрасить заголовок окна:", e)


def run_window(webview, url):
    global WINDOW
    light = windows_light_theme()
    WINDOW = window = webview.create_window(
        "Sub Studio", url, width=1400, height=880, min_size=(1000, 640), maximized=True,
        background_color="#FFFFFF" if light else "#15171C", text_select=True)
    can_close = False

    def on_closing():
        if can_close:
            return True
        threading.Thread(target=close_safely, daemon=True).start()
        return False  # закроемся сами, когда сохраним проект

    def close_safely():
        nonlocal can_close
        busy = [j for j in jobs.values() if j["status"] == "running"]
        if busy and not window.create_confirmation_dialog(
                "Sub Studio", "Ещё идёт работа (распознавание, перевод или вшивание). Прервать её и закрыть?"):
            return
        for job in busy:
            cancel_job(job)
        try:  # дописываем несохранённые правки — автосохранение могло ещё не сработать
            window.evaluate_js("window.substudioFlush && window.substudioFlush()")
            for _ in range(40):
                if not window.evaluate_js("!!(window.substudioDirty && window.substudioDirty())"):
                    break
                time.sleep(0.1)
        except Exception:  # noqa: BLE001
            pass
        can_close = True
        window.destroy()

    def on_drop(e):
        paths = [f["pywebviewFullPath"] for f in e.get("dataTransfer", {}).get("files", []) if f.get("pywebviewFullPath")]
        if paths:
            window.evaluate_js(f"window.substudioDrop && window.substudioDrop({json.dumps(paths)})")

    def focus_page(*_):
        """Клавиатуру — странице, а не рамке окна, иначе горячие клавиши молчат, пока не кликнешь в окно."""
        from System import Action
        form = window.native
        form.BeginInvoke(Action(lambda: form.browser.webview.Focus()))

    def on_shown():
        style_title_bar(window, light)
        window.native.Activated += focus_page

    def on_loaded():
        from webview.dom import DOMEventHandler
        window.dom.document.events.drop += DOMEventHandler(on_drop, prevent_default=True)
        focus_page()

    window.events.shown += on_shown
    window.events.closing += on_closing
    window.events.loaded += on_loaded
    webview.start(icon=str(ICON), private_mode=False, storage_path=str(ROOT / "webview-data"))


def main():
    if sys.stdout is None:  # запуск без консоли (pythonw): сообщения — в файл, чтобы при сбое было что посмотреть
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
            LOG_PATH.unlink()
        sys.stdout = sys.stderr = open(LOG_PATH, "a", encoding="utf-8", errors="replace", buffering=1)
        print(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---")
    for stream in (sys.stdout, sys.stderr):  # консоль Windows может не уметь в кириллицу
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    logging.getLogger("werkzeug").setLevel(logging.WARNING)  # без строки на каждый запрос

    port = PORT
    while (found := instance_on(port)) is not None:
        if found:  # Sub Studio уже открыта — показываем её
            try:
                shown = requests.post(f"http://127.0.0.1:{port}/api/focus", headers={"X-Sub-Studio": "1"}, timeout=3).json()["ok"]
            except Exception:  # noqa: BLE001
                shown = False
            if not shown:
                webbrowser.open(f"http://127.0.0.1:{port}/")
            return
        port += 1  # порт занят чем-то другим (например, старой версией в консоли) — берём следующий
    url = f"http://127.0.0.1:{port}/"

    try:
        import webview
    except ImportError:
        webview = None
    if webview is None or "--browser" in sys.argv:
        print(f"Sub Studio работает: {url}\nНе закрывай это окно, пока работаешь с субтитрами.")
        threading.Timer(1.0, webbrowser.open, [url]).start()
        app.run(host="127.0.0.1", port=port, threaded=True)
        return

    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", port, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("SubStudio.App")  # своя кнопка на панели задач
    run_window(webview, url)
    sys.stdout.flush()
    os._exit(0)  # не ждём фоновые потоки (загрузку модели и т. п.) — окно закрыто, проект сохранён


if __name__ == "__main__":
    main()
