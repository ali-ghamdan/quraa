#!/usr/bin/env python3
"""MPRIS2 D-Bus bridge for Quraa detached mpv daemon."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # type: ignore

MPRIS_OBJECT_PATH = "/org/mpris/MediaPlayer2"
MPRIS_ROOT_IFACE = "org.mpris.MediaPlayer2"
MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"
DBUS_PROPS_IFACE = "org.freedesktop.DBus.Properties"

MPRIS_XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg direction="in" name="Offset" type="x"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <method name="OpenUri">
      <arg direction="in" name="Uri" type="s"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>
"""

CP1252_REVERSE = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
}

LOST_DOUBLE_UTF8_RE = re.compile(r"[\u00D8-\u00DB]\?")
DOUBLE_UTF8_CLUSTER_RE = re.compile(
    r"[\u00D8-\u00DB][\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]"
)
CP1256_INDICATOR_RE = re.compile(r"[\u00C1-\u00DA\u00DC-\u00FA]{2,}")
ARABIC_LETTER_RE = re.compile(r"[\u0621-\u064A\u0671]")


def to_single_byte_array(text: str) -> bytes | None:
    out = bytearray()
    for ch in text:
        code = ord(ch)
        if code <= 0xFF:
            out.append(code)
        elif code in CP1252_REVERSE:
            out.append(CP1252_REVERSE[code])
        else:
            return None
    return bytes(out)


def repair_double_utf8(text: str) -> str:
    pattern = re.compile(
        r"[\x20-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]+"
    )

    def repl(match: re.Match[str]) -> str:
        chunk = match.group(0)
        if not DOUBLE_UTF8_CLUSTER_RE.search(chunk):
            return chunk
        raw_bytes = to_single_byte_array(chunk)
        if raw_bytes is None:
            return chunk
        try:
            decoded = raw_bytes.decode("utf-8", errors="strict")
            if decoded != chunk and re.search(r"[\u0600-\u06FF]", decoded):
                return decoded
        except UnicodeDecodeError:
            return chunk
        return chunk

    return pattern.sub(repl, text)


def repair_cp1256(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        if not CP1256_INDICATOR_RE.search(token):
            return token
        raw = bytearray()
        ext = 0
        for ch in token:
            code = ord(ch)
            if code <= 0xFF:
                raw.append(code)
                if code >= 0x80:
                    ext += 1
            elif code in CP1252_REVERSE:
                raw.append(CP1252_REVERSE[code])
                ext += 1
            else:
                return token
        try:
            decoded = bytes(raw).decode("windows-1256", errors="strict")
        except UnicodeDecodeError:
            return token
        if "\uFFFD" in decoded:
            return token
        ar_hits = len(ARABIC_LETTER_RE.findall(decoded))
        if ar_hits < 2 or ar_hits * 5 < ext * 3:
            return token
        return decoded

    return re.sub(r"[^\s]+", repl, text)


def repair_stream_text(raw: str) -> tuple[str, bool]:
    if not raw:
        return "", False
    if "\uFFFD" in raw:
        return "", True
    candidate = repair_double_utf8(raw) if DOUBLE_UTF8_CLUSTER_RE.search(raw) else raw
    if (
        LOST_DOUBLE_UTF8_RE.search(raw)
        or LOST_DOUBLE_UTF8_RE.search(candidate)
        or DOUBLE_UTF8_CLUSTER_RE.search(candidate)
    ):
        return "", True
    if CP1256_INDICATOR_RE.search(candidate):
        candidate = repair_cp1256(candidate)
    if "\uFFFD" in candidate or CP1256_INDICATOR_RE.search(candidate):
        return "", True
    cleaned = re.sub(r"[\x00-\x1F\x7F]", " ", candidate).replace("\u00AD", "-")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned, False


def normalize_art_key(raw: str) -> str:
    s = raw.lower()
    s = re.sub(r"^radio\s+", "", s)
    s = re.sub(r"\s+-\s*radio$", "", s)
    s = re.sub(r"[\u064B-\u065F\u0670\u0640]", "", s)
    s = s.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    s = re.sub(r"[-_]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def normalize_image_uri(raw: str | None, base_dir: Path) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    lower = trimmed.lower()
    if lower.startswith("http://") or lower.startswith("https://"):
        parsed = urllib.parse.urlparse(trimmed)
        return trimmed if parsed.netloc else None
    if lower.startswith("file://"):
        parsed = urllib.parse.urlparse(trimmed)
        fs_path = urllib.parse.unquote(parsed.path)
        return trimmed if fs_path and os.path.exists(fs_path) else None
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", trimmed):
        return None
    expanded = os.path.expanduser(trimmed)
    p = Path(expanded) if os.path.isabs(expanded) else (base_dir / expanded)
    resolved = p.resolve()
    return resolved.as_uri() if resolved.exists() else None


def load_art_map(path: Path, base_dir: Path) -> dict[str, Any]:
    out: dict[str, Any] = {"default": None, "authors": {}, "stations": {}}
    if not path.exists():
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return out
    if not isinstance(data, dict):
        return out
    out["default"] = normalize_image_uri(data.get("default"), base_dir)
    for sec in ("authors", "stations"):
        obj = data.get(sec)
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(k, str) and isinstance(v, str):
                    uri = normalize_image_uri(v, base_dir)
                    nk = normalize_art_key(k)
                    if uri and nk:
                        out[sec][nk] = uri
    for k, v in data.items():
        if k in ("default", "authors", "stations"):
            continue
        if isinstance(k, str) and isinstance(v, str):
            uri = normalize_image_uri(v, base_dir)
            nk = normalize_art_key(k)
            if uri and nk:
                out["authors"][nk] = uri
                out["stations"][nk] = uri
    return out


class MprisBridge:
    def __init__(
        self,
        ipc_socket: str,
        assets_dir: str,
        config_dir: str,
        cli_path: str,
        bus_name: str = "",
    ) -> None:
        self.ipc_socket = ipc_socket
        self.assets_dir = Path(assets_dir) if assets_dir else Path(__file__).resolve().parent
        self.config_dir = Path(config_dir) if config_dir else Path.home() / ".config" / "quraa"
        self.cli_path = cli_path
        self.explicit_bus_name = bus_name.strip()
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.ipc_sock: socket.socket | None = None
        self.req_id = 1

        self.signals: dict[str, Any] = {
            "pause": False,
            "idle-active": True,
            "paused-for-cache": False,
            "core-idle": True,
            "volume": 80.0,
            "mute": False,
            "media-title": None,
            "metadata": None,
            "path": None,
            "user-data/quraa/station-id": None,
            "user-data/quraa/station-name": None,
            "user-data/quraa/station-author": None,
            "user-data/quraa/station-art": None,
            "user-data/quraa/station-url": None,
            "user-data/quraa/paused": "",
        }
        self.connecting = False
        self.has_started_audio = False

        self.bundled_art = load_art_map(self.assets_dir / "station-images.json", self.assets_dir)
        self.user_art_mtime = -1.0
        self.user_art: dict[str, Any] = {"default": None, "authors": {}, "stations": {}}
        self._reload_user_art()

        self.dbus_conn: Gio.DBusConnection | None = None
        self.owner_id: int = 0
        self.reg_ids: list[int] = []
        self.mainloop = GLib.MainLoop()
        self.last_player_props: dict[str, GLib.Variant] | None = None
        self.acquired_once = False
        self.fallback_bus_tried = False

    def _reload_user_art(self) -> None:
        p = self.config_dir / "images.json"
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = -1.0
        if mtime != self.user_art_mtime:
            self.user_art_mtime = mtime
            self.user_art = load_art_map(p, self.config_dir)

    def _is_url_slug(self, value: str, url: str | None) -> bool:
        if not url:
            return False
        try:
            seg = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1].lower()
            clean = value.strip().lower()
            return bool(seg) and (clean == seg or clean == urllib.parse.unquote(seg))
        except Exception:
            return False

    def compute_mpris_state(self) -> dict[str, GLib.Variant]:
        with self.lock:
            s = dict(self.signals)
            connecting = self.connecting
        self._reload_user_art()

        paused_flag = s.get("user-data/quraa/paused") in ("1", True)
        idle_active = bool(s.get("idle-active"))
        pause_prop = bool(s.get("pause"))
        station_id = s.get("user-data/quraa/station-id") or None
        station_name = s.get("user-data/quraa/station-name") or None
        station_author = s.get("user-data/quraa/station-author") or None
        station_art = s.get("user-data/quraa/station-art") or None
        station_url = s.get("user-data/quraa/station-url") or s.get("path") or None

        if paused_flag and station_id:
            playback_status = "Paused"
        elif idle_active:
            playback_status = "Playing" if connecting else "Stopped"
        elif pause_prop:
            playback_status = "Paused"
        else:
            playback_status = "Playing"

        raw_meta = s.get("metadata") if isinstance(s.get("metadata"), dict) else {}
        icy_title = ""
        meta_title = ""
        meta_artist = ""
        for k, v in raw_meta.items():
            if not isinstance(v, str) or not v.strip():
                continue
            lk = k.lower()
            if lk == "icy-title":
                icy_title = v.strip()
            elif lk == "title":
                meta_title = v.strip()
            elif lk == "artist":
                meta_artist = v.strip()

        candidate = icy_title or meta_title
        media_title = s.get("media-title")
        if (
            not candidate
            and isinstance(media_title, str)
            and media_title.strip()
            and not media_title.strip().endswith(" — Quraa")
            and not self._is_url_slug(media_title, station_url)
        ):
            candidate = media_title.strip()

        track_title: str | None = None
        author: str | None = station_author
        if candidate:
            repaired, corrupted = repair_stream_text(candidate)
            if not corrupted and repaired:
                rep_artist = ""
                if meta_artist:
                    ra, rc = repair_stream_text(meta_artist)
                    if not rc and ra:
                        rep_artist = ra
                if rep_artist:
                    track_title = repaired
                    author = rep_artist
                else:
                    m = re.match(r"^(.+?)\s+-\s+(.+)$", repaired)
                    if m and m.group(1).strip() and m.group(2).strip():
                        author = m.group(1).strip()
                        track_title = m.group(2).strip()
                    else:
                        track_title = repaired

        resolved_title = track_title or station_name or "Quraa Radio"
        resolved_art = self._resolve_art(author, station_id, station_name, station_art)

        safe_track_suffix = re.sub(r"[^A-Za-z0-9_]", "_", str(station_id or "idle"))
        meta_dict: dict[str, GLib.Variant] = {
            "mpris:trackid": GLib.Variant("o", f"/org/quraa/track/{safe_track_suffix}"),
            "xesam:title": GLib.Variant("s", resolved_title),
        }
        if author:
            meta_dict["xesam:artist"] = GLib.Variant("as", [author])
        if station_name:
            meta_dict["xesam:album"] = GLib.Variant("s", station_name)
        if station_url:
            meta_dict["xesam:url"] = GLib.Variant("s", str(station_url))
        if resolved_art:
            meta_dict["mpris:artUrl"] = GLib.Variant("s", resolved_art)

        vol = float(s.get("volume") or 80.0)
        return {
            "PlaybackStatus": GLib.Variant("s", playback_status),
            "LoopStatus": GLib.Variant("s", "None"),
            "Rate": GLib.Variant("d", 1.0),
            "Shuffle": GLib.Variant("b", False),
            "Metadata": GLib.Variant("a{sv}", meta_dict),
            "Volume": GLib.Variant("d", max(0.0, min(1.0, vol / 100.0))),
            "Position": GLib.Variant("x", 0),
            "MinimumRate": GLib.Variant("d", 1.0),
            "MaximumRate": GLib.Variant("d", 1.0),
            "CanGoNext": GLib.Variant("b", True),
            "CanGoPrevious": GLib.Variant("b", True),
            "CanPlay": GLib.Variant("b", True),
            "CanPause": GLib.Variant("b", True),
            "CanSeek": GLib.Variant("b", False),
            "CanControl": GLib.Variant("b", True),
        }

    def _resolve_art(
        self,
        author: str | None,
        station_id: str | None,
        station_name: str | None,
        station_art: str | None,
    ) -> str | None:
        if author:
            ak = normalize_art_key(author)
            if ak in self.user_art["authors"]:
                return self.user_art["authors"][ak]
            if ak in self.user_art["stations"]:
                return self.user_art["stations"][ak]
        if station_id:
            sid_k = normalize_art_key(str(station_id))
            if sid_k in self.user_art["stations"]:
                return self.user_art["stations"][sid_k]
        if station_name:
            sn_k = normalize_art_key(station_name)
            if sn_k in self.user_art["stations"]:
                return self.user_art["stations"][sn_k]
            if sn_k in self.user_art["authors"]:
                return self.user_art["authors"][sn_k]
        if station_art:
            uri = normalize_image_uri(station_art, self.assets_dir)
            if uri:
                return uri
        if author:
            ak = normalize_art_key(author)
            if ak in self.bundled_art["authors"]:
                return self.bundled_art["authors"][ak]
            if ak in self.bundled_art["stations"]:
                return self.bundled_art["stations"][ak]
        if station_id:
            sid_k = normalize_art_key(str(station_id))
            if sid_k in self.bundled_art["stations"]:
                return self.bundled_art["stations"][sid_k]
        default_img = self.assets_dir / "quraa-default.png"
        return (
            self.user_art["default"]
            or self.bundled_art["default"]
            or (default_img.resolve().as_uri() if default_img.exists() else None)
        )

    def send_mpv_command(self, args: list[Any]) -> None:
        with self.lock:
            sock = self.ipc_sock
            rid = self.req_id
            self.req_id += 1
        if sock is None:
            return
        payload = json.dumps({"command": args, "request_id": rid}) + "\n"
        try:
            sock.sendall(payload.encode("utf-8"))
        except OSError:
            pass

    def run_cli_subcommand(self, cmd: str) -> None:
        if self.cli_path and os.path.exists(self.cli_path):
            argv = ["bun", "run", self.cli_path, cmd]
        else:
            quraa_bin = shutil.which("quraa")
            if not quraa_bin:
                return
            argv = [quraa_bin, cmd]
        try:
            subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError:
            pass

    def emit_updates(self) -> bool:
        if self.dbus_conn is None:
            return False
        current = self.compute_mpris_state()
        changed: dict[str, GLib.Variant] = {}
        if self.last_player_props is None:
            changed = current
        else:
            for k, val in current.items():
                prev = self.last_player_props.get(k)
                if prev is None or prev.print_(False) != val.print_(False):
                    changed[k] = val
        self.last_player_props = current
        if changed:
            try:
                self.dbus_conn.emit_signal(
                    None,
                    MPRIS_OBJECT_PATH,
                    DBUS_PROPS_IFACE,
                    "PropertiesChanged",
                    GLib.Variant("(sa{sv}as)", (MPRIS_PLAYER_IFACE, changed, [])),
                )
            except Exception:
                pass
        return False

    def _on_method_call(
        self,
        _conn: Gio.DBusConnection,
        _sender: str,
        _obj_path: str,
        iface_name: str,
        method_name: str,
        params: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ) -> None:
        if iface_name == MPRIS_ROOT_IFACE:
            if method_name == "Quit":
                self.send_mpv_command(["quit"])
            invocation.return_value(None)
            return

        if iface_name == MPRIS_PLAYER_IFACE:
            if method_name in ("Pause", "Play", "PlayPause"):
                with self.lock:
                    paused_flag = self.signals.get("user-data/quraa/paused") in ("1", True)
                    idle_active = bool(self.signals.get("idle-active"))
                    pause_prop = bool(self.signals.get("pause"))
                    station_url = (
                        self.signals.get("user-data/quraa/station-url")
                        or self.signals.get("path")
                    )
                currently_paused = (paused_flag and idle_active) or (not idle_active and pause_prop)
                want_pause = method_name == "Pause" or (method_name == "PlayPause" and not currently_paused)
                if want_pause:
                    self.send_mpv_command(["set_property", "user-data/quraa/paused", "1"])
                    self.send_mpv_command(["stop"])
                elif station_url:
                    self.send_mpv_command(["set_property", "user-data/quraa/paused", ""])
                    self.send_mpv_command(["loadfile", station_url, "replace"])
            elif method_name == "Stop":
                self.send_mpv_command(["set_property", "user-data/quraa/paused", ""])
                self.send_mpv_command(["stop"])
            elif method_name == "Next":
                self.run_cli_subcommand("next")
            elif method_name == "Previous":
                self.run_cli_subcommand("prev")
        invocation.return_value(None)

    def _on_get_property(
        self,
        _conn: Gio.DBusConnection,
        _sender: str,
        _obj_path: str,
        iface_name: str,
        prop_name: str,
    ) -> GLib.Variant:
        if iface_name == MPRIS_ROOT_IFACE:
            root_props: dict[str, GLib.Variant] = {
                "CanQuit": GLib.Variant("b", True),
                "CanRaise": GLib.Variant("b", False),
                "HasTrackList": GLib.Variant("b", False),
                "Identity": GLib.Variant("s", "Quraa"),
                "DesktopEntry": GLib.Variant("s", "quraa"),
                "SupportedUriSchemes": GLib.Variant("as", ["http", "https"]),
                "SupportedMimeTypes": GLib.Variant("as", ["audio/mpeg", "audio/aac", "audio/wav"]),
            }
            return root_props.get(prop_name, GLib.Variant("s", ""))
        props = self.compute_mpris_state()
        return props.get(prop_name, GLib.Variant("s", ""))

    def _on_set_property(
        self,
        _conn: Gio.DBusConnection,
        _sender: str,
        _obj_path: str,
        iface_name: str,
        prop_name: str,
        value: GLib.Variant,
    ) -> bool:
        if iface_name == MPRIS_PLAYER_IFACE and prop_name == "Volume":
            vol = max(0, min(100, round(float(value.unpack()) * 100.0)))
            self.send_mpv_command(["set_property", "volume", vol])
            return True
        return False

    def _start_ipc_thread(self) -> None:
        observed = [
            "pause", "idle-active", "paused-for-cache", "core-idle",
            "volume", "mute", "media-title", "metadata", "path",
            "user-data/quraa/station-id", "user-data/quraa/station-name",
            "user-data/quraa/station-author", "user-data/quraa/station-art",
            "user-data/quraa/station-url", "user-data/quraa/paused",
        ]

        def worker() -> None:
            sock: socket.socket | None = None
            deadline = time.monotonic() + 5.0
            while not self.stop_event.is_set() and time.monotonic() < deadline:
                if os.path.exists(self.ipc_socket):
                    try:
                        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        s.connect(self.ipc_socket)
                        sock = s
                        break
                    except OSError:
                        pass
                time.sleep(0.05)

            if sock is None:
                GLib.idle_add(self.mainloop.quit)
                return

            with self.lock:
                self.ipc_sock = sock

            try:
                for idx, prop in enumerate(observed, start=1):
                    self.send_mpv_command(["observe_property", idx, prop])
                    self.send_mpv_command(["get_property", prop])

                buf = ""
                sock.settimeout(1.0)
                while not self.stop_event.is_set():
                    try:
                        data = sock.recv(8192)
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    buf += data.decode("utf-8", errors="replace")
                    lines = buf.split("\n")
                    buf = lines.pop()
                    changed = False
                    for line in lines:
                        if not line.strip():
                            continue
                        try:
                            msg = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        ev = msg.get("event")
                        if ev == "property-change":
                            name = msg.get("name")
                            if name in self.signals:
                                with self.lock:
                                    self.signals[name] = msg.get("data")
                                changed = True
                        elif ev == "start-file":
                            with self.lock:
                                self.connecting = True
                            changed = True
                        elif ev == "playback-restart":
                            with self.lock:
                                self.connecting = False
                                self.has_started_audio = True
                            changed = True
                        elif ev == "end-file":
                            with self.lock:
                                self.connecting = False
                            changed = True
                        elif ev == "shutdown":
                            self.stop_event.set()
                            break
                        elif isinstance(msg.get("request_id"), int) and msg.get("error") == "success":
                            # Hydrate initial get_property responses cleanly (request_ids 2, 4, ... even numbers)
                            rid = msg["request_id"]
                            if rid % 2 == 0:
                                prop_idx = (rid // 2) - 1
                                if 0 <= prop_idx < len(observed):
                                    with self.lock:
                                        self.signals[observed[prop_idx]] = msg.get("data")
                                    changed = True
                    if changed:
                        GLib.idle_add(self.emit_updates)
            except OSError:
                pass
            finally:
                with self.lock:
                    self.ipc_sock = None
                try:
                    sock.close()
                except OSError:
                    pass
                GLib.idle_add(self.mainloop.quit)

        t = threading.Thread(target=worker, daemon=True)
        t.start()

    def run(self) -> int:
        node_info = Gio.DBusNodeInfo.new_for_xml(MPRIS_XML)

        def register_objects(conn: Gio.DBusConnection) -> None:
            self.dbus_conn = conn
            if not self.reg_ids:
                for iface_info in node_info.interfaces:
                    rid = conn.register_object(
                        MPRIS_OBJECT_PATH,
                        iface_info,
                        self._on_method_call,
                        self._on_get_property,
                        self._on_set_property,
                    )
                    self.reg_ids.append(rid)

        def on_bus_acquired(conn: Gio.DBusConnection, _name: str) -> None:
            register_objects(conn)

        def on_name_acquired(_conn: Gio.DBusConnection, _name: str) -> None:
            self.acquired_once = True
            self.emit_updates()

        def on_name_lost(_conn: Gio.DBusConnection, _name: str) -> None:
            if not self.acquired_once and not self.fallback_bus_tried:
                self.fallback_bus_tried = True
                if self.owner_id:
                    Gio.bus_unown_name(self.owner_id)
                self.owner_id = Gio.bus_own_name(
                    Gio.BusType.SESSION,
                    f"org.mpris.MediaPlayer2.quraa.instance_{os.getpid()}",
                    Gio.BusNameOwnerFlags.NONE,
                    on_bus_acquired,
                    on_name_acquired,
                    on_name_lost,
                )

        bus_name = (
            self.explicit_bus_name
            or os.environ.get("QURAA_MPRIS_BUS_NAME")
            or "org.mpris.MediaPlayer2.quraa"
        )
        self.owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            bus_name,
            Gio.BusNameOwnerFlags.NONE,
            on_bus_acquired,
            on_name_acquired,
            on_name_lost,
        )

        self._start_ipc_thread()
        try:
            self.mainloop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop_event.set()
            if self.owner_id:
                Gio.bus_unown_name(self.owner_id)
        return 0


def main() -> int:
    if len(sys.argv) < 2:
        return 1
    ipc_sock = sys.argv[1]
    assets_dir = sys.argv[2] if len(sys.argv) > 2 else ""
    config_dir = sys.argv[3] if len(sys.argv) > 3 else ""
    cli_path = sys.argv[4] if len(sys.argv) > 4 else ""
    bus_name = sys.argv[5] if len(sys.argv) > 5 else ""
    return MprisBridge(ipc_sock, assets_dir, config_dir, cli_path, bus_name).run()


if __name__ == "__main__":
    raise SystemExit(main())
