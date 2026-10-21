"""YT Reaper — вставил ссылку, нажал «Скачать»."""

import json
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import yt_dlp

CONFIG_PATH = Path(__file__).with_name("settings.json")

QUALITIES = {
    "Лучшее (mp4)": "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b",
    "1080p (mp4)": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]",
    "720p (mp4)": "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]",
    "Только звук (mp3)": "ba/b",
}


def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


class App:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.busy = False
        cfg = load_config()

        root.title("YT Reaper")
        root.geometry("620x360")
        root.minsize(480, 320)

        pad = {"padx": 10, "pady": 4}
        frm = ttk.Frame(root, padding=10)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(0, weight=1)

        ttk.Label(frm, text="Ссылка на видео:").grid(row=0, column=0, sticky="w", **pad)
        url_row = ttk.Frame(frm)
        url_row.grid(row=1, column=0, sticky="ew", **pad)
        url_row.columnconfigure(0, weight=1)
        self.url = tk.StringVar()
        self.url_entry = ttk.Entry(url_row, textvariable=self.url)
        self.url_entry.grid(row=0, column=0, sticky="ew")
        self.url_entry.bind("<Return>", lambda e: self.start())
        ttk.Button(url_row, text="Вставить", command=self.paste).grid(row=0, column=1, padx=(6, 0))

        ttk.Label(frm, text="Папка:").grid(row=2, column=0, sticky="w", **pad)
        dir_row = ttk.Frame(frm)
        dir_row.grid(row=3, column=0, sticky="ew", **pad)
        dir_row.columnconfigure(0, weight=1)
        self.folder = tk.StringVar(value=cfg.get("folder") or str(Path.home() / "Downloads"))
        ttk.Entry(dir_row, textvariable=self.folder).grid(row=0, column=0, sticky="ew")
        ttk.Button(dir_row, text="Выбрать…", command=self.pick_folder).grid(row=0, column=1, padx=(6, 0))
        ttk.Button(dir_row, text="Открыть", command=self.open_folder).grid(row=0, column=2, padx=(6, 0))

        opt_row = ttk.Frame(frm)
        opt_row.grid(row=4, column=0, sticky="ew", **pad)
        ttk.Label(opt_row, text="Качество:").pack(side="left")
        self.quality = tk.StringVar(value=cfg.get("quality") if cfg.get("quality") in QUALITIES else "Лучшее (mp4)")
        ttk.Combobox(opt_row, textvariable=self.quality, values=list(QUALITIES), state="readonly",
                     width=18).pack(side="left", padx=(6, 16))
        self.subs = tk.BooleanVar(value=cfg.get("subs", False))
        ttk.Checkbutton(opt_row, text="Скачать субтитры YouTube (.srt)", variable=self.subs).pack(side="left")

        self.btn = ttk.Button(frm, text="Скачать", command=self.start)
        self.btn.grid(row=5, column=0, sticky="ew", padx=10, pady=(10, 4), ipady=6)

        self.progress = ttk.Progressbar(frm, maximum=100)
        self.progress.grid(row=6, column=0, sticky="ew", **pad)
        self.status = tk.StringVar(value="Вставь ссылку и нажми «Скачать» (или Enter).")
        ttk.Label(frm, textvariable=self.status, wraplength=580).grid(row=7, column=0, sticky="w", **pad)

        bottom = ttk.Frame(frm)
        bottom.grid(row=8, column=0, sticky="ew", padx=10, pady=(12, 0))
        ttk.Label(bottom, text=f"yt-dlp {yt_dlp.version.__version__}", foreground="gray").pack(side="left")
        ttk.Button(bottom, text="Обновить yt-dlp", command=self.update_ytdlp).pack(side="right")

        self.paste(only_if_url=True)
        self.url_entry.focus_set()
        root.after(100, self.poll)

    # --- UI helpers -----------------------------------------------------

    def paste(self, only_if_url=False):
        try:
            text = self.root.clipboard_get().strip()
        except tk.TclError:
            return
        if only_if_url and not text.startswith("http"):
            return
        self.url.set(text)

    def pick_folder(self):
        path = filedialog.askdirectory(initialdir=self.folder.get() or None)
        if path:
            self.folder.set(path)

    def open_folder(self):
        path = Path(self.folder.get())
        path.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(["explorer", str(path)])

    def set_busy(self, busy):
        self.busy = busy
        self.btn.configure(state="disabled" if busy else "normal")

    def poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "progress":
                    self.progress["value"] = value
                elif kind == "status":
                    self.status.set(value)
                elif kind == "done":
                    self.set_busy(False)
                    self.progress["value"] = 100
                    self.status.set(f"Готово: {value}")
                    self.url.set("")
                elif kind == "error":
                    self.set_busy(False)
                    self.progress["value"] = 0
                    self.status.set("Ошибка")
                    messagebox.showerror("Не получилось", value)
                elif kind == "warn":
                    title, problem = value
                    self.set_busy(False)
                    self.progress["value"] = 100
                    self.status.set(f"Видео скачано, субтитры — нет: {title}")
                    messagebox.showwarning("Видео скачано, а субтитры — нет", problem)
                elif kind == "info":
                    self.set_busy(False)
                    self.status.set(value)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    # --- download -------------------------------------------------------

    def start(self):
        if self.busy:
            return
        url = self.url.get().strip()
        if not url.startswith("http"):
            messagebox.showwarning("Нет ссылки", "Вставь ссылку на видео.")
            return
        folder = Path(self.folder.get().strip() or Path.home() / "Downloads")
        save_config({"folder": str(folder), "quality": self.quality.get(), "subs": self.subs.get()})
        self.set_busy(True)
        self.progress["value"] = 0
        self.status.set("Получаю информацию о видео…")
        args = (url, folder, self.quality.get(), self.subs.get())
        threading.Thread(target=self.download, args=args, daemon=True).start()

    def hook(self, d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes", 0)
            if total:
                pct = done * 100 / total
                self.events.put(("progress", pct))
                speed = d.get("speed")
                speed_txt = f" · {speed / 1024 / 1024:.1f} МБ/с" if speed else ""
                name = Path(d.get("filename", "")).name
                self.events.put(("status", f"Качаю {pct:.0f}%{speed_txt} — {name}"))
        elif d["status"] == "finished":
            self.events.put(("status", "Склеиваю видео и звук…"))

    def download(self, url, folder, quality, subs):
        folder.mkdir(parents=True, exist_ok=True)
        opts = {
            "format": QUALITIES[quality],
            "outtmpl": str(folder / "%(title).150B [%(id)s].%(ext)s"),
            "windowsfilenames": True,
            "noplaylist": True,
            "progress_hooks": [self.hook],
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        if quality.startswith("Только звук"):
            opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
                                       "preferredquality": "0"}]
        else:
            opts["merge_output_format"] = "mp4"
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception as e:  # noqa: BLE001 — показываем пользователю любую ошибку
            self.events.put(("error", str(e)))
            return
        title = info.get("title") or url
        if not subs:
            self.events.put(("done", title))
            return
        # Субтитры — отдельным шагом: если YouTube их не отдаст, видео всё равно остаётся.
        problem = self.download_subs(url, info, opts["outtmpl"])
        if problem:
            self.events.put(("warn", (title, problem)))
        else:
            self.events.put(("done", title + " (+ субтитры)"))

    @staticmethod
    def pick_sub_langs(info):
        """Язык оригинала + ru/en, но только те, что реально есть; авто-сабы — только на языке оригинала,
        иначе YouTube начинает отдавать машинные переводы на все языки и быстро режет по 429."""
        manual = set(info.get("subtitles") or {}) - {"live_chat"}
        auto = set(info.get("automatic_captions") or {})
        orig = next((k[:-5] for k in auto if k.endswith("-orig")), None) or info.get("language")
        langs = [lang for lang in dict.fromkeys([orig, "ru", "en"]) if lang and lang in manual]
        if not langs and orig and (orig in auto or f"{orig}-orig" in auto):
            langs = [f"{orig}-orig" if f"{orig}-orig" in auto else orig]
        return langs, bool(set(langs) - manual)

    def download_subs(self, url, info, outtmpl):
        langs, need_auto = self.pick_sub_langs(info)
        if not langs:
            return "У этого видео нет субтитров на YouTube (даже автоматических)."
        opts = {
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": need_auto,
            "subtitleslangs": langs,
            "subtitlesformat": "srt/vtt/best",
            "sleep_interval_subtitles": 2,
            "outtmpl": outtmpl,
            "windowsfilenames": True,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "postprocessors": [{"key": "FFmpegSubtitlesConvertor", "format": "srt", "when": "before_dl"}],
        }
        waits = [0, 20, 60]
        for attempt, wait in enumerate(waits, 1):
            for left in range(wait, 0, -1):
                self.events.put(("status", f"YouTube просит подождать — повторю загрузку субтитров через {left} с…"))
                time.sleep(1)
            self.events.put(("status", f"Качаю субтитры ({', '.join(langs)}), попытка {attempt}/{len(waits)}…"))
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    ydl.extract_info(url, download=True)
                return None
            except Exception as e:  # noqa: BLE001
                error = str(e)
                if "429" not in error:
                    break
        if "429" in error:
            return ("YouTube временно не отдаёт субтитры (ошибка 429 — слишком много запросов). "
                    "Видео скачано. Попробуй скачать ещё раз минут через 15–30: "
                    "видео повторно качаться не будет, догрузятся только субтитры.")
        return "Не удалось скачать субтитры: " + error

    def update_ytdlp(self):
        if self.busy:
            return
        self.set_busy(True)
        self.status.set("Обновляю yt-dlp…")

        def run():
            r = subprocess.run([sys.executable.replace("pythonw", "python"), "-m", "pip", "install", "-U",
                                "yt-dlp[default]"], capture_output=True, text=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if r.returncode == 0:
                self.events.put(("info", "yt-dlp обновлён. Перезапусти программу."))
            else:
                self.events.put(("error", r.stderr[-1500:] or "pip завершился с ошибкой"))

        threading.Thread(target=run, daemon=True).start()


def main():
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:  # noqa: BLE001
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
