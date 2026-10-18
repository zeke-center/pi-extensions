"""豆包 TTS 2.0 双向流式（WebSocket）最小客户端 —— 纯标准库，无需 websockets 包。

协议要点（火山 v3）：
  握手：自定义头 X-Api-Key / X-Api-Resource-Id(seed-tts-2.0) / X-Api-Connect-Id
  帧头 4 字节：proto_ver|header_size / msg_type|flags / serialization|compression / 0
    msg_type：1=full client request  9=full server response  11=audio-only server response
    flags 0x01 = 带 event（4 字节大端）
  audio-only 响应：4 字节序号 + 4 字节长度 + payload
"""
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import uuid
import wave

HOST = "openspeech.bytedance.com"
PATH = "/api/v3/tts/bidirection"

EV = {
    "StartConnection": 1, "FinishConnection": 2,
    "ConnectionStarted": 50, "ConnectionFailed": 51, "ConnectionFinished": 52,
    "StartSession": 100, "FinishSession": 102,
    "SessionStarted": 150, "SessionFinished": 152, "SessionFailed": 153, "SessionCanceled": 154,
    "TaskRequest": 200,
    "TTSSentenceStart": 350, "TTSSentenceEnd": 351, "TTSResponse": 352,
}
NAME = {v: k for k, v in EV.items()}

MSG_FULL_CLIENT = 1
MSG_FULL_SERVER = 9
MSG_AUDIO_ONLY = 11


def ws_connect(api_key, resource_id, timeout=20):
    key = base64.b64encode(os.urandom(16)).decode()
    raw = socket.create_connection((HOST, 443), timeout=timeout)
    sock = ssl.create_default_context().wrap_socket(raw, server_hostname=HOST)
    lines = [
        f"GET {PATH} HTTP/1.1",
        f"Host: {HOST}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
        f"X-Api-Key: {api_key}",
        f"X-Api-Resource-Id: {resource_id}",
        f"X-Api-Connect-Id: {uuid.uuid4()}",
        "X-Control-Require-Usage-Tokens-Return: *",
    ]
    CRLF = chr(13) + chr(10)
    sock.sendall((CRLF.join(lines) + CRLF + CRLF).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("握手断开")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b" 101 " not in head.split(b"\r\n")[0]:
        raise RuntimeError("握手失败: " + head.decode("utf-8", "ignore")[:200])
    return sock, rest


def ws_send(sock, payload: bytes, opcode=0x2):
    mask = os.urandom(4)
    n = len(payload)
    header = bytearray([0x80 | opcode])  # FIN + opcode
    if n < 126:
        header.append(0x80 | n)
    elif n < (1 << 16):
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + mask + masked)


class Reader:
    def __init__(self, sock, rest=b""):
        self.sock = sock
        self.buf = bytearray(rest)

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("连接关闭")
            self.buf += chunk

    def frame(self):
        """返回 (opcode, payload)"""
        self._need(2)
        b0, b1 = self.buf[0], self.buf[1]
        self.buf = self.buf[2:]
        opcode = b0 & 0x0F
        n = b1 & 0x7F
        if n == 126:
            self._need(2)
            n = struct.unpack(">H", bytes(self.buf[:2]))[0]
            self.buf = self.buf[2:]
        elif n == 127:
            self._need(8)
            n = struct.unpack(">Q", bytes(self.buf[:8]))[0]
            self.buf = self.buf[8:]
        self._need(n)
        payload = bytes(self.buf[:n])
        self.buf = self.buf[n:]
        return opcode, payload


def pack(msg_type, event, body: bytes, serialization=1, session_id=None):
    """v3 双向流：带 event(0x04)；会话级消息还要带 session_id（长度前缀）。"""
    header = bytearray()
    header.append((1 << 4) | 1)              # protocol_version=1, header_size=1
    header.append((msg_type << 4) | 0x04)    # 0x04 = 带 event
    header.append((serialization << 4) | 0)  # JSON / 无压缩
    header.append(0)
    header += struct.pack(">i", event)
    if session_id is not None:
        b = session_id.encode()
        header += struct.pack(">I", len(b)) + b
    header += struct.pack(">I", len(body))
    return bytes(header) + body


def unpack(data: bytes):
    """v3 帧：头(4) + event(4, flags&0x04) + id长度(4)+id + [序号(4) 仅音频] + 长度(4) + payload"""
    if len(data) < 12:
        raise ValueError("帧太短: " + repr(data[:32]))
    b0, b1, b2 = data[0], data[1], data[2]
    header_size = (b0 & 0x0F) * 4
    msg_type = b1 >> 4
    flags = b1 & 0x0F
    off = header_size
    event = None
    if flags & 0x04:
        event = int.from_bytes(data[off:off + 4], "big")
        off += 4
    idlen = int.from_bytes(data[off:off + 4], "big")
    off += 4
    ident = data[off:off + idlen].decode("utf-8", "ignore") if idlen else ""
    off += idlen
    seq = None
    if msg_type == MSG_AUDIO_ONLY:
        seq = int.from_bytes(data[off:off + 4], "big")
        off += 4
    size = int.from_bytes(data[off:off + 4], "big")
    off += 4
    payload = data[off:off + size]
    if (b2 & 0x0F) == 1:
        import gzip
        payload = gzip.decompress(payload)
    return msg_type, event, seq, payload


def synth(api_key, text, speaker, out_path, sample_rate=24000, resource_id="seed-tts-2.0",
          speech_rate=0, log=None):
    sock, rest = ws_connect(api_key, resource_id)
    sock.settimeout(12)
    rd = Reader(sock, rest)
    try:
        ws_send(sock, pack(MSG_FULL_CLIENT, EV["StartConnection"], b"{}"))
        deadline = time.time() + 25
        while True:
            if time.time() > deadline:
                raise RuntimeError("连豆包超时")
            op, d = rd.frame()
            if op != 0x2:
                if op == 0x9:
                    ws_send(sock, d, opcode=0xA)
                continue
            t, ev, _, _ = unpack(d)
            if ev == EV["ConnectionStarted"]:
                break
            if ev == EV["ConnectionFailed"]:
                raise RuntimeError("建连失败")

        sid = str(uuid.uuid4())
        body = json.dumps({
            "event": EV["StartSession"],
            "req_params": {
                "speaker": speaker,
                "audio_params": {"format": "pcm", "sample_rate": sample_rate, "speech_rate": speech_rate},
            },
        }).encode()
        ws_send(sock, pack(MSG_FULL_CLIENT, EV["StartSession"], body, session_id=sid))
        while True:
            t, ev, _, _ = unpack(rd.frame()[1])
            if ev == EV["SessionStarted"]:
                break
            if ev in (EV["SessionFailed"], EV["ConnectionFailed"]):
                raise RuntimeError("会话启动失败")

        t0 = time.time()
        body = json.dumps({"event": EV["TaskRequest"], "req_params": {"text": text}}).encode()
        ws_send(sock, pack(MSG_FULL_CLIENT, EV["TaskRequest"], body, session_id=sid))
        ws_send(sock, pack(MSG_FULL_CLIENT, EV["FinishSession"], b"{}", session_id=sid))

        pcm = bytearray()
        first = None
        usage = None
        while True:
            opcode, data = rd.frame()
            if opcode == 0x9:      # ping → pong
                ws_send(sock, data, opcode=0xA)
                continue
            if opcode == 0x8:      # close
                raise RuntimeError("服务端关闭连接")
            if opcode not in (0x1, 0x2):
                continue
            if len(data) < 8:
                continue
            t, ev, seq, payload = unpack(data)
            if t == MSG_AUDIO_ONLY:
                if first is None:
                    first = time.time() - t0
                pcm += payload
            elif ev in (EV["SessionFinished"], EV["SessionFailed"], EV["SessionCanceled"]) or t == MSG_FULL_SERVER and ev == EV["SessionFinished"]:
                try:
                    usage = json.loads(payload.decode() or "{}").get("usage")
                except Exception:
                    pass
                break
        total = time.time() - t0
        with wave.open(out_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(bytes(pcm))
        dur = len(pcm) / 2 / sample_rate
        if log:
            log(f"首音 {first*1000:.0f}ms 总耗时 {total:.1f}s 音频 {dur:.1f}s usage={usage}")
        return out_path
    finally:
        try:
            ws_send(sock, pack(MSG_FULL_CLIENT, EV["FinishConnection"], b"{}"))
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass


def synth_many(api_key, jobs, resource_id="seed-tts-2.0", log=None, on_done=None):
    """一条连接合成多句（省掉每句重新握手的 1~2 秒）。

    jobs: [(text, speaker, out_path, sample_rate, speech_rate), ...]
    """
    sock, rest = ws_connect(api_key, resource_id)
    sock.settimeout(30)
    rd = Reader(sock, rest)
    out = []
    try:
        ws_send(sock, pack(MSG_FULL_CLIENT, EV["StartConnection"], b"{}"))
        deadline = time.time() + 25
        while True:
            if time.time() > deadline:
                raise RuntimeError("连豆包超时")
            op, d = rd.frame()
            if op == 0x9:
                ws_send(sock, d, opcode=0xA)
                continue
            if op != 0x2:
                continue
            _, ev, _, _ = unpack(d)
            if ev == EV["ConnectionStarted"]:
                break
            if ev == EV["ConnectionFailed"]:
                raise RuntimeError("建连失败")

        for text, speaker, out_path, sample_rate, speech_rate in jobs:
            sid = str(uuid.uuid4())
            params = {"speaker": speaker,
                      "audio_params": {"format": "pcm", "sample_rate": sample_rate,
                                       "speech_rate": speech_rate or 0}}
            if tone:
                params["context_texts"] = [tone]   # 语音指令：不计费
            body = json.dumps({"event": EV["StartSession"], "req_params": params}).encode()
            ws_send(sock, pack(MSG_FULL_CLIENT, EV["StartSession"], body, session_id=sid))
            while True:
                op, d = rd.frame()
                if op == 0x9:
                    ws_send(sock, d, opcode=0xA)
                    continue
                if op != 0x2:
                    continue
                _, ev, _, _ = unpack(d)
                if ev == EV["SessionStarted"]:
                    break
                if ev in (EV["SessionFailed"], EV["ConnectionFailed"]):
                    raise RuntimeError("会话启动失败")

            t0 = time.time()
            body = json.dumps({"event": EV["TaskRequest"], "req_params": {"text": text}}).encode()
            ws_send(sock, pack(MSG_FULL_CLIENT, EV["TaskRequest"], body, session_id=sid))
            ws_send(sock, pack(MSG_FULL_CLIENT, EV["FinishSession"], b"{}", session_id=sid))

            pcm = bytearray()
            while True:
                op, d = rd.frame()
                if op == 0x9:
                    ws_send(sock, d, opcode=0xA)
                    continue
                if op != 0x2:
                    continue
                t, ev, seq, payload = unpack(d)
                if t == MSG_AUDIO_ONLY:
                    pcm += payload
                elif ev in (EV["SessionFinished"], EV["SessionFailed"], EV["SessionCanceled"]):
                    break
            with wave.open(out_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(bytes(pcm))
            if log:
                log(f"  句 {len(text)} 字 → {len(pcm)/2/sample_rate:.1f}s 音频，用时 {time.time()-t0:.2f}s")
            out.append(out_path)
            if on_done:
                on_done(out_path)   # 每合成好一句就通知调用方，边播边合，不留空档
        return out
    finally:
        try:
            ws_send(sock, pack(MSG_FULL_CLIENT, EV["FinishConnection"], b"{}"))
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass


class CloudConn:
    """**常驻**的豆包连接：握手只做一次，之后每句只发 StartSession/TaskRequest。

    为什么必须常驻：实测握手+建会话要 3.2~3.4 秒（跟句子长短无关），
    每句都重连就等于每句话前都顿一下 —— 用户听到的就是"漏点/断断续续"。
    """

    def __init__(self, api_key, resource_id="seed-tts-2.0"):
        self.api_key = api_key
        self.resource_id = resource_id
        self.sock = None
        self.rd = None
        self.dead = False

    def _open(self):
        self.sock, rest = ws_connect(self.api_key, self.resource_id)
        self.sock.settimeout(30)
        self.rd = Reader(self.sock, rest)
        ws_send(self.sock, pack(MSG_FULL_CLIENT, EV["StartConnection"], b"{}"))
        deadline = time.time() + 20
        while True:
            if time.time() > deadline:
                raise RuntimeError("连豆包超时")
            op, d = self.rd.frame()
            if op == 0x9:
                ws_send(self.sock, d, opcode=0xA)
                continue
            if op != 0x2:
                continue
            _, ev, _, _ = unpack(d)
            if ev == EV["ConnectionStarted"]:
                return
            if ev == EV["ConnectionFailed"]:
                raise RuntimeError("建连失败")

    def ensure(self):
        if self.sock is None or self.dead:
            self.close()
            self._open()
            self.dead = False
        return self

    def synth(self, text, speaker, out_path, sample_rate=24000, speech_rate=0, tone=None):
        """合成一句到 wav。失败时把连接标记为坏、下次重连。"""
        self.ensure()
        sid = str(uuid.uuid4())
        try:
            body = json.dumps({
                "event": EV["StartSession"],
                "req_params": {"speaker": speaker,
                               "audio_params": {"format": "pcm", "sample_rate": sample_rate,
                                                "speech_rate": speech_rate or 0}},
            }).encode()
            ws_send(self.sock, pack(MSG_FULL_CLIENT, EV["StartSession"], body, session_id=sid))
            while True:
                op, d = self.rd.frame()
                if op == 0x9:
                    ws_send(self.sock, d, opcode=0xA)
                    continue
                if op != 0x2:
                    continue
                _, ev, _, _ = unpack(d)
                if ev == EV["SessionStarted"]:
                    break
                if ev in (EV["SessionFailed"], EV["ConnectionFailed"]):
                    raise RuntimeError("会话启动失败")

            body = json.dumps({"event": EV["TaskRequest"], "req_params": {"text": text}}).encode()
            ws_send(self.sock, pack(MSG_FULL_CLIENT, EV["TaskRequest"], body, session_id=sid))
            ws_send(self.sock, pack(MSG_FULL_CLIENT, EV["FinishSession"], b"{}", session_id=sid))

            pcm = bytearray()
            while True:
                op, d = self.rd.frame()
                if op == 0x9:
                    ws_send(self.sock, d, opcode=0xA)
                    continue
                if op != 0x2:
                    continue
                t, ev, seq, payload = unpack(d)
                if t == MSG_AUDIO_ONLY:
                    pcm += payload
                elif ev in (EV["SessionFinished"], EV["SessionFailed"], EV["SessionCanceled"]):
                    break
            if not pcm:
                raise RuntimeError("豆包没有返回音频")
            with wave.open(out_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(bytes(pcm))
            return out_path
        except Exception:
            self.dead = True
            raise

    def close(self):
        try:
            if self.sock is not None:
                ws_send(self.sock, pack(MSG_FULL_CLIENT, EV["FinishConnection"], b"{}"))
        except Exception:
            pass
        try:
            if self.sock is not None:
                self.sock.close()
        except Exception:
            pass
        self.sock = None
        self.rd = None


_CONNS = {}


def get_conn(api_key, resource_id="seed-tts-2.0"):
    """拿（或建）一条常驻连接。按 key+resource 复用，不同凭据互不干扰。"""
    k = (api_key, resource_id)
    c = _CONNS.get(k)
    if c is None:
        c = CloudConn(api_key, resource_id)
        _CONNS[k] = c
    return c


def close_all():
    for c in list(_CONNS.values()):
        try:
            c.close()
        except Exception:
            pass
    _CONNS.clear()
