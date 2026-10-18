#!/usr/bin/env python3
"""tts_worker.py —— 常驻 TTS worker（被 pi 扩展以子进程方式拉起）

为什么常驻：sherpa-onnx 加载模型约 2.4s。每次播报起一个进程 = 每句话前等 2.4 秒。
常驻后首句合成 0.2~0.6s（配合"首句切短"），这才是能接受的手感。

协议（stdin/stdout 各一行一个 JSON，UTF-8）：
  → {"cmd":"ping"}
  ← {"ok":true,"engine":"sherpa-onnx","model":"kokoro-multi-lang-v1_0","sample_rate":24000,"sid":50}
  → {"cmd":"say","id":7,"text":"改完了，104 项测试全过。","sid":50,"speed":1.0}
  ← {"id":7,"ok":true,"dur":4.2,"first_ms":182}          # 开始播时先回一条
  → {"cmd":"stop"}                                        # 立刻掐声（barge-in）
  ← {"ok":true,"stopped":true}
  → {"cmd":"install","model":"kokoro-multi-lang-v1_0","mirror":"github"}
  ← {"event":"progress","pct":37} / {"event":"installed","dir":"..."}
  → {"cmd":"shutdown"}

设计约束（都是踩过的坑）：
  · 绝不阻塞：播放用 SND_ASYNC，主循环一直能收 stop
  · 句级切分：**首句切短**（第一声最快），后续句子放长（韵律更好）
  · 模型目录里同时支持 Kokoro（voices.bin）与 VITS/MeloTTS（lexicon+tokens）
  · 任何异常都回一行 JSON，不让 node 侧等到超时
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tarfile
import time
import urllib.request
import wave
from pathlib import Path

try:
	sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
	pass

def _agent_dir() -> Path:
	env = os.environ.get("PI_CODING_AGENT_DIR")
	if env:
		return Path(env)
	try:
		return Path.home() / ".pi" / "agent"
	except Exception:  # 极端环境（无 HOME/USERPROFILE）也不能炸
		return Path.cwd() / ".pi-agent"


AGENT_DIR = _agent_dir()
MODELS_DIR = Path(os.environ.get("PI_TTS_MODELS_DIR") or (AGENT_DIR / "models" / "tts"))
CACHE_DIR = MODELS_DIR / ".cache"
HARD_END = "。！？!?；;…\n"
SOFT_END = "，,、：:"


# --------------------------------------------------------------------------- #
# 文本处理
# --------------------------------------------------------------------------- #
def split_sentences(text: str, first_len: int = 14, max_len: int = 40) -> list[str]:
	"""首句切短（最快出声），后续句子放长（韵律更好）。"""
	text = re.sub(r"\s+", " ", (text or "").strip())
	if not text:
		return []
	chunks, buf = [], ""
	for ch in text:
		buf += ch
		if ch in HARD_END:
			chunks.append(buf.strip())
			buf = ""
	if buf.strip():
		chunks.append(buf.strip())
	if chunks and len(chunks[0]) > first_len:
		head = chunks[0]
		for i in range(2, min(first_len, len(head))):
			if head[i] in SOFT_END:
				chunks[0:1] = [head[: i + 1].strip(), head[i + 1 :].strip()]
				break
	out = []
	for c in chunks:
		while len(c) > max_len:
			cut = -1
			for i in range(max_len - 1, max_len // 3, -1):
				if i < len(c) and c[i] in SOFT_END:
					cut = i + 1
					break
			if cut <= 0:
				cut = max_len
			out.append(c[:cut].strip())
			c = c[cut:].strip()
		if c:
			out.append(c)
	return [s for s in out if s]


# --------------------------------------------------------------------------- #
# 引擎
# --------------------------------------------------------------------------- #
class Engine:
	"""按模型目录自动识别 Kokoro / VITS(MeloTTS)，都走 sherpa-onnx。"""

	def __init__(self, model_dir: Path, sid: int, speed: float, threads: int = 4):
		import sherpa_onnx

		self.dir = model_dir
		self.sid = sid
		self.speed = speed
		self.length_scale = 1.0 / max(0.5, min(2.0, speed))
		self.kind = "kokoro" if (model_dir / "voices.bin").exists() else "vits"

		if self.kind == "kokoro":
			lexicon = model_dir / "lexicon.txt"
			if not lexicon.exists():
				lexicon = self._merged_lexicon(model_dir)
			m = sherpa_onnx.OfflineTtsKokoroModelConfig(
				model=str(model_dir / "model.onnx"),
				voices=str(model_dir / "voices.bin"),
				tokens=str(model_dir / "tokens.txt"),
				data_dir=str(model_dir / "espeak-ng-data"),
				dict_dir=str(model_dir / "dict") if (model_dir / "dict").exists() else "",
				lexicon=str(lexicon),
				length_scale=self.length_scale,
			)
			rules = [model_dir / f for f in ("date-zh.fst", "number-zh.fst", "phone-zh.fst") if (model_dir / f).exists()]
		else:
			m = sherpa_onnx.OfflineTtsVitsModelConfig(
				model=str(model_dir / "model.onnx"),
				lexicon=str(model_dir / "lexicon.txt"),
				tokens=str(model_dir / "tokens.txt"),
				noise_scale=0.667,
				noise_scale_w=0.8,
				length_scale=self.length_scale,
			)
			rules = [model_dir / f for f in ("phone.fst", "date.fst", "number.fst") if (model_dir / f).exists()]

		cfg = sherpa_onnx.OfflineTtsConfig(
			model=sherpa_onnx.OfflineTtsModelConfig(
				vits=m if self.kind == "vits" else sherpa_onnx.OfflineTtsVitsModelConfig(),
				kokoro=m if self.kind == "kokoro" else sherpa_onnx.OfflineTtsKokoroModelConfig(),
				num_threads=threads,
				provider="cpu",
			),
			rule_fsts=",".join(str(p) for p in rules),
			max_num_sentences=1,
		)
		if not cfg.validate():
			raise RuntimeError(f"模型配置无效：{model_dir}")
		self.tts = sherpa_onnx.OfflineTts(cfg)
		self.sample_rate = self.tts.sample_rate

	@staticmethod
	def _merged_lexicon(model_dir: Path) -> Path:
		"""Kokoro 中英混读要把 zh 与 en 词表合并（实测必须），带缓存。"""
		merged = model_dir / "lexicon-mixed.txt"
		src = [model_dir / "lexicon-zh.txt", model_dir / "lexicon-us-en.txt"]
		if not all(p.exists() for p in src):
			raise RuntimeError("Kokoro 模型缺少 lexicon-zh.txt / lexicon-us-en.txt")
		key = "|".join(f"{p.stat().st_mtime_ns}:{p.stat().st_size}" for p in src)
		stamp = model_dir / ".lexicon-mixed.stamp"
		if merged.exists() and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == key:
			return merged
		lines = []
		for p in src:
			lines += [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
		merged.write_text("\n".join(lines) + "\n", encoding="utf-8")
		stamp.write_text(key, encoding="utf-8")
		return merged

	def synth(self, text: str):
		a = self.tts.generate(text, sid=self.sid)
		return list(a.samples), a.sample_rate

	def wav_path(self, text: str) -> Path:
		CACHE_DIR.mkdir(parents=True, exist_ok=True)
		key = hashlib.sha1(f"{text}|{self.speed}|{self.dir.name}|{self.sid}".encode()).hexdigest()[:16]
		p = CACHE_DIR / f"{key}.wav"
		if p.exists():
			return p
		import array

		samples, sr = self.synth(text)
		arr = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
		with wave.open(str(p), "wb") as w:
			w.setnchannels(1)
			w.setsampwidth(2)
			w.setframerate(sr)
			w.writeframes(arr.tobytes())
		return p


# --------------------------------------------------------------------------- #
# 播放（可打断）
# --------------------------------------------------------------------------- #
def play(path: Path, blocking: bool = False) -> None:
	if sys.platform == "win32":
		import winsound

		winsound.PlaySound(str(path), winsound.SND_FILENAME | (0 if blocking else winsound.SND_ASYNC))
	else:
		import subprocess

		cmd = ["afplay", str(path)] if sys.platform == "darwin" else ["aplay", "-q", str(path)]
		subprocess.run(cmd, check=False)


def stop_play() -> None:
	if sys.platform == "win32":
		import winsound

		winsound.PlaySound(None, winsound.SND_PURGE)
	else:
		import subprocess

		if sys.platform == "darwin":
			subprocess.run(["killall", "afplay"], check=False, capture_output=True)
		else:
			subprocess.run(["pkill", "-f", "aplay"], check=False, capture_output=True)


# --------------------------------------------------------------------------- #
# 主循环
# --------------------------------------------------------------------------- #
def reply(obj: dict) -> None:
	sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
	sys.stdout.flush()


def resolve_model(name: str | None) -> Path | None:
	if name:
		p = Path(name)
		if p.is_dir():
			return p
		if (MODELS_DIR / name).is_dir():
			return MODELS_DIR / name
	if not MODELS_DIR.exists():
		return None
	dirs = [d for d in MODELS_DIR.iterdir() if d.is_dir() and not d.name.startswith(".") and (d / "model.onnx").exists()]
	return dirs[0] if dirs else None


def content_hash(d: Path) -> str:
	"""目录的确定性哈希：按相对路径排序，逐个文件喂 sha256（能发现解压不全）。"""
	h = hashlib.sha256()
	files = [x for x in d.rglob("*") if x.is_file() and ".cache" not in x.parts]
	for p in sorted(files, key=lambda x: x.relative_to(d).as_posix()):
		h.update(p.relative_to(d).as_posix().encode())
		h.update(b"\0")
		h.update(hashlib.sha256(p.read_bytes()).digest())
	return h.hexdigest()


def do_extract(req: dict) -> None:
	"""把 node 下载好的 .tar.bz2 解压到目标目录，并校验内容哈希。

	参数：src(压缩包) dst(最终目录) sha256(期望的内容哈希，可空) strip(是否去掉顶层目录)
	"""
	import shutil
	import tempfile

	src = Path(req["src"])
	dst = Path(req["dst"])
	expect = (req.get("sha256") or "").strip()
	if not src.exists():
		reply({"id": req.get("id"), "ok": False, "error": f"压缩包不存在：{src}"})
		return
	tmp = Path(tempfile.mkdtemp(prefix="tts-unpack-"))
	try:
		reply({"id": req.get("id"), "event": "unpacking"})
		with tarfile.open(src, "r:bz2") as tf:
			tf.extractall(tmp)
		roots = [p for p in tmp.iterdir()]
		root = roots[0] if len(roots) == 1 and roots[0].is_dir() else tmp
		if expect:
			got = content_hash(root)
			if got != expect:
				shutil.rmtree(tmp, ignore_errors=True)
				reply({"id": req.get("id"), "ok": False, "error": f"内容校验失败（期望 {expect[:12]}… 实际 {got[:12]}…）"})
				return
		dst.parent.mkdir(parents=True, exist_ok=True)
		if dst.exists():
			shutil.rmtree(dst, ignore_errors=True)
		shutil.move(str(root), str(dst))
		reply({"id": req.get("id"), "ok": True, "dir": str(dst), "sha256": content_hash(dst) if expect else None})
	finally:
		shutil.rmtree(tmp, ignore_errors=True)
		try:
			src.unlink()
		except Exception:
			pass


def do_install(name: str) -> None:
	"""下载 → 校验 → 解压（清单由 node 侧传入 url/sha256）。"""
	reply({"event": "error", "msg": "install 需要由 node 侧下发 url 与 sha256（见 manifest.json）"})


def main() -> None:
	"""非阻塞主循环：读线程 → 命令队列；播放用状态机推进，任何时刻都能被 stop 打断。"""
	import queue
	import threading

	sid = int(os.environ.get("PI_TTS_SID") or 50)
	speed = float(os.environ.get("PI_TTS_SPEED") or 1.0)
	st: dict = {"engine": None, "model_dir": None, "sid": sid, "speed": speed,
	            "plan": [], "until": 0.0, "id": None, "total": 0.0, "first_ms": None}

	q: "queue.Queue[str]" = queue.Queue()

	def reader() -> None:
		for line in sys.stdin:
			line = line.strip()
			if line:
				q.put(line)
		q.put(json.dumps({"cmd": "_eof"}))  # 父进程死了 → stdin 关闭 → 自杀（防孤儿进程）

	import signal

	def _bye(_sig, _frm):
		try:
			stop_play()
		finally:
			os._exit(0)

	for sig in ("SIGTERM", "SIGINT", "SIGBREAK"):
		try:
			signal.signal(getattr(signal, sig), _bye)
		except Exception:
			pass

	threading.Thread(target=reader, daemon=True).start()

	def ensure_engine(req: dict) -> None:
		if st["engine"] is not None:
			return
		md = resolve_model(req.get("model"))
		if md is None:
			raise RuntimeError("没有可用模型（先用面板下载 / 或指定 model）")
		st["model_dir"] = md
		st["sid"] = int(req.get("sid") or st["sid"])
		st["speed"] = float(req.get("speed") or st["speed"])
		st["engine"] = Engine(md, st["sid"], st["speed"])

	def start_next() -> None:
		"""推进播放状态机：播下一句 / 收尾。"""
		if st["until"] and time.time() < st["until"]:
			return
		st["until"] = 0.0
		if st["plan"]:
			path, dur = st["plan"].pop(0)
			play(path, blocking=False)
			st["until"] = time.time() + dur
			return
		if st["id"] is not None:
			reply({"id": st["id"], "ok": True, "done": True, "dur": round(st["total"], 2)})
			st["id"] = None

	def interrupt() -> None:
		stop_play()
		st["plan"].clear()
		st["until"] = 0.0
		st["total"] = 0.0
		if st["id"] is not None:
			reply({"id": st["id"], "ok": True, "interrupted": True})
			st["id"] = None

	reply({"event": "ready", "models_dir": str(MODELS_DIR), "pid": os.getpid()})

	while True:
		try:
			line = q.get(timeout=0.05)
		except queue.Empty:
			start_next()
			continue
		try:
			req = json.loads(line)
		except Exception as e:
			reply({"ok": False, "error": f"bad json: {e}"})
			continue

		cmd = req.get("cmd")
		try:
			if cmd == "ping":
				eng = st["engine"]
				reply({"id": req.get("id"), "ok": True, "engine": "sherpa-onnx",
				       "model": st["model_dir"].name if st["model_dir"] else None,
				       "kind": eng.kind if eng else None,
				       "sample_rate": eng.sample_rate if eng else None,
				       "sid": st["sid"], "speed": st["speed"],
				       "models_dir": str(MODELS_DIR)})
			elif cmd == "say":
				interrupt()  # 新播报抢占旧的（node 侧已按优先级判定过）
				ensure_engine(req)
				text = str(req.get("text") or "")
				sents = split_sentences(text)
				if not sents:
					reply({"id": req.get("id"), "ok": False, "error": "空文本"})
					continue
				eng: Engine = st["engine"]
				t0 = time.perf_counter()
				first = eng.wav_path(sents[0])
				with wave.open(str(first)) as w:
					d0 = w.getnframes() / w.getframerate()
				st["id"] = req.get("id")
				st["total"] = d0
				st["first_ms"] = (time.perf_counter() - t0) * 1000
				play(first, blocking=False)
				st["until"] = time.time() + d0
				reply({"id": st["id"], "ok": True, "first_ms": round(st["first_ms"]), "dur": round(d0, 2)})
				# 剩下的句子后台合成，避免阻塞命令处理
				rest = sents[1:]

				def synth_rest() -> None:
					for sen in rest:
						try:
							p = eng.wav_path(sen)
							with wave.open(str(p)) as w2:
								dur = w2.getnframes() / w2.getframerate()
							st["plan"].append((p, dur))
							st["total"] += dur
						except Exception:
							pass

				if rest:
					threading.Thread(target=synth_rest, daemon=True).start()
			elif cmd == "stop":
				interrupt()
				reply({"id": req.get("id"), "ok": True, "stopped": True})
			elif cmd == "install":
				reply({"id": req.get("id"), "event": "error", "msg": "install 已拆成 node 下载 + extract 解压"})
			elif cmd == "extract":
				do_extract(req)
			elif cmd == "config":
				if req.get("sid") is not None:
					st["sid"] = int(req["sid"])
					if st["engine"]:
						st["engine"].sid = st["sid"]
				if req.get("speed") is not None:
					st["speed"] = float(req["speed"])
					st["engine"] = None  # 语速要重建引擎（length_scale 在构造时定）
				reply({"id": req.get("id"), "ok": True, "sid": st["sid"], "speed": st["speed"], "rebuilt": req.get("speed") is not None})
			elif cmd in ("shutdown", "_eof"):
				stop_play()
				reply({"id": req.get("id"), "ok": True, "bye": True, "reason": cmd})
				return
			else:
				reply({"id": req.get("id"), "ok": False, "error": f"unknown cmd: {cmd}"})
		except Exception as e:
			reply({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
	main()
