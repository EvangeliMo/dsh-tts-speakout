# -*- coding: utf-8 -*-
"""Self-bootstrap for the dsh-tts-speakout plugin.

The plugin ships its own inference code, so a fresh install only needs a Python
interpreter that can run it. This module makes that happen without the user
installing anything by hand:

  1. **Interpreter** — reuse one that already imports every dependency (a local
     conda env, for instance); otherwise create a private venv inside the
     plugin's data directory and install the dependencies into it.
  2. **Dependencies** — torch (CUDA wheel on Windows), transformers, qwen-tts,
     soundfile, sounddevice, numpy.
  3. **Model weights** — reuse a local checkpoint when the user already has one;
     otherwise stream it from ModelScope (fast in mainland China) or the
     Hugging Face mirror, resuming partial files.

Every long step reports progress through `emit`, which the worker forwards to the
Node host so the settings panel can show what is happening.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable

Emit = Callable[[str, str, dict[str, Any] | None], None]

# ---------------------------------------------------------------- constants

REQUIRED_MODULES = ("torch", "transformers", "qwen_tts", "soundfile", "numpy", "sounddevice")

# Packages installed on top of the torch wheel.
PLAIN_REQUIREMENTS = (
    "transformers==4.57.3",
    "qwen-tts",
    "soundfile",
    "sounddevice",
    "numpy",
)

TORCH_PIN = "torch==2.6.0+cu124"
TORCH_MIRROR = "https://mirrors.aliyun.com/pytorch-wheels/cu124/"
PLAIN_INDEX = "https://pypi.org/simple"

MODEL_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODELSCOPE_ENDPOINT = "https://www.modelscope.cn/api/v1/models/{repo}/repo"
HF_ENDPOINT = "https://hf-mirror.com/{repo}/resolve/main/{path}"

# Candidate file lists, newest layout first. The transformer layout is the one
# the released checkpoint uses; the LLM-style layout is the single-file fallback.
LAYOUTS: tuple[tuple[str, ...], ...] = (
    (
        "config.json",
        "generation_config.json",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "vocab.json",
        "merges.txt",
        "model.safetensors",
        "speech_tokenizer/config.json",
        "speech_tokenizer/preprocessor_config.json",
        "speech_tokenizer/model.safetensors",
    ),
    (
        "config.json",
        "generation_config.json",
        "tokenizer_config.json",
        "vocab.json",
        "merges.txt",
        "model.safetensors",
    ),
)

MIN_SAFETENSORS_BYTES = 10 * 1024 * 1024


def _try_import_probe(code: str) -> dict[str, Any] | None:
    """Run `python -c code` and parse one JSON object from stdout."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            env=_child_env(),
        )
    except Exception:  # noqa: BLE001
        return None
    if proc.returncode != 0:
        return None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:  # noqa: BLE001
                continue
    return None


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("NO_PROXY", "localhost,127.0.0.1,0.0.0.0,::1")
    env.setdefault("no_proxy", "localhost,127.0.0.1,0.0.0.0,::1")
    return env


def interpreter_report(python: str) -> dict[str, Any] | None:
    """Ask `python` which required modules it can import."""
    code = (
        "import json,importlib\n"
        "mods=%r\n"
        "missing=[m for m in mods if importlib.util.find_spec(m) is None]\n"
        "print(json.dumps({'python':__import__('sys').executable,"
        "'version':__import__('sys').version.split()[0],'missing':missing}))\n"
        % (list(REQUIRED_MODULES),)
    )
    try:
        proc = subprocess.run(
            [python, "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=_child_env(),
        )
    except Exception:  # noqa: BLE001
        return None
    if proc.returncode != 0:
        return None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:  # noqa: BLE001
                continue
    return None


def candidate_interpreters(bundled_python: str | None, configured: str | None) -> list[str]:
    """Interpreters worth probing, best first."""
    out: list[str] = []
    for cand in (
        configured,
        os.environ.get("DSH_TTS_PYTHON"),
        str(Path.home() / "miniconda3" / "envs" / "qwen3-tts" / "python.exe"),
        r"D:\miniconda3\envs\qwen3-tts\python.exe",
        r"C:\ProgramData\miniconda3\envs\qwen3-tts\python.exe",
        sys.executable,
        shutil.which("python"),
        shutil.which("python3"),
        bundled_python,
    ):
        if not cand:
            continue
        text = str(cand)
        if text not in out and Path(text).exists():
            out.append(text)
    return out


def pick_interpreter(bundled_python: str | None, configured: str | None,
                     emit: Emit, venv_dir: Path | None = None) -> tuple[str, dict[str, Any]]:
    """Return (python_path, report).

    Prefers an interpreter that already has every dependency — that makes the
    plugin instant for someone who has run Qwen3-TTS before — and otherwise
    creates a private venv so the plugin never depends on a hand-made env.
    """
    for candidate in candidate_interpreters(bundled_python, configured):
        emit("info", "检测 Python 环境: %s" % candidate, {"python": candidate})
        report = interpreter_report(candidate)
        if report and not report.get("missing"):
            emit("info", "复用已有环境（依赖齐全）", {"python": candidate})
            return candidate, report
        if report:
            emit("debug", "该环境缺少依赖: %s" % ", ".join(report["missing"]),
                 {"python": candidate, "missing": report["missing"]})

    if venv_dir is None:
        raise BootstrapError("未找到依赖齐全的 Python 环境，且没有可用的虚拟环境目录")
    return create_venv(venv_dir, emit)


class BootstrapError(RuntimeError):
    """Raised when the environment or the model cannot be prepared."""


# ---------------------------------------------------------------- venv


def venv_python(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def create_venv(venv_dir: Path, emit: Emit) -> tuple[str, dict[str, Any]]:
    """Create a private venv and install the full dependency set into it."""
    venv_dir.mkdir(parents=True, exist_ok=True)
    python = venv_python(venv_dir)

    if not python.exists():
        emit("progress", "创建插件专用虚拟环境…", {"venv": str(venv_dir)})
        base = _first_usable_base_python()
        _run_checked([base, "-m", "venv", str(venv_dir)], emit, "创建虚拟环境失败")
        _run_checked([str(python), "-m", "pip", "install", "--upgrade", "pip"],
                     emit, "升级 pip 失败")

    report = interpreter_report(str(python))
    missing = set(report.get("missing", [])) if report else set(REQUIRED_MODULES)
    if not missing:
        emit("info", "虚拟环境依赖齐全", {"python": str(python)})
        return str(python), report or {}

    if "torch" in missing:
        emit("progress",
             "安装 PyTorch（CUDA 版，约 2.5GB，首次需要几分钟）…",
             {"stage": "torch"})
        _pip(python, ["install", TORCH_PIN, "-f", TORCH_MIRROR], emit)

    emit("progress", "安装其余依赖…", {"stage": "deps"})
    _pip(python, ["install", *PLAIN_REQUIREMENTS], emit)

    report = interpreter_report(str(python))
    if not report or report.get("missing"):
        missing = report.get("missing") if report else list(REQUIRED_MODULES)
        raise BootstrapError(
            "依赖安装后仍缺少模块: %s（可手工执行 pip 安装后重试）" % ", ".join(missing)
        )
    emit("info", "虚拟环境准备完成", {"python": str(python)})
    return str(python), report


def _first_usable_base_python() -> str:
    for cand in (sys.executable, shutil.which("python"), shutil.which("py")):
        if cand:
            return str(cand)
    raise BootstrapError("找不到用于创建虚拟环境的 Python")


def _pip(python: str | Path, args: Iterable[str], emit: Emit) -> None:
    cmd = [str(python), "-m", "pip", "install", "--no-input", *args]
    env = _child_env()
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    env.setdefault("PIP_NO_WARN_SCRIPT_LOCATION", "1")
    _run_streamed(cmd, emit, "依赖安装失败", env=env)


def _run_checked(cmd: list[str], emit: Emit, message: str) -> None:
    _run_streamed(cmd, emit, message)


def _run_streamed(cmd: list[str], emit: Emit, failure: str,
                  env: dict[str, str] | None = None) -> None:
    emit("debug", "执行: %s" % " ".join(cmd[:4]))
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env or _child_env(),
    )
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line)
        if len(tail) > 40:
            tail.pop(0)
        emit("debug", line[:400])
    code = proc.wait()
    if code != 0:
        raise BootstrapError("%s（退出码 %s）：%s" % (failure, code, " | ".join(tail[-5:])))


# ---------------------------------------------------------------- model


def model_is_complete(model_dir: Path) -> bool:
    config = model_dir / "config.json"
    if not config.is_file():
        return False
    weights = list(model_dir.glob("*.safetensors"))
    if not weights:
        return False
    total = sum(p.stat().st_size for p in weights if p.is_file())
    if total < MIN_SAFETENSORS_BYTES:
        return False
    try:
        payload = json.loads(config.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return False
    return bool(payload.get("architectures") or payload.get("model_type"))


def ensure_model(model_dir: Path, emit: Emit, source: str = "auto") -> Path:
    """Make sure `model_dir` holds a usable checkpoint; download if needed."""
    if model_is_complete(model_dir):
        emit("info", "复用本地模型权重", {"model": str(model_dir)})
        return model_dir

    if source == "local":
        raise BootstrapError(
            "本地模型目录不完整（%s）。请在设置里填写正确的模型目录，"
            "或把“模型来源”改为自动下载。" % model_dir
        )

    model_dir.mkdir(parents=True, exist_ok=True)
    emit("progress", "开始下载模型权重（约 2.4GB，首次需要几分钟）…",
         {"stage": "model", "model": str(model_dir)})

    errors: list[str] = []
    for provider in ("modelscope", "hf"):
        if source not in ("auto", provider):
            continue
        try:
            files = _resolve_layout(model_dir, provider, emit)
            _download_files(model_dir, files, provider, emit)
            if model_is_complete(model_dir):
                emit("info", "模型下载完成", {"model": str(model_dir)})
                return model_dir
            errors.append("%s: 下载后校验未通过" % provider)
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: %s" % (provider, exc))
            emit("warn", "%s 下载失败：%s" % (provider, exc))

    raise BootstrapError(
        "模型自动下载失败。%s\n可手工把 Qwen3-TTS-12Hz-0.6B-Base 放到 %s，"
        "或在插件设置里指定已有的模型目录。" % ("；".join(errors), model_dir)
    )


def _http_json(url: str, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-tts-speakout"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8", "replace"))


def _resolve_layout(model_dir: Path, provider: str, emit: Emit) -> list[str]:
    """Ask the registry which file layout this repo uses."""
    if provider == "modelscope":
        url = MODELSCOPE_ENDPOINT.format(repo=MODEL_REPO) + "/files"
        try:
            payload = _http_json(url)
            names = _extract_files(payload)
            if names:
                return names
        except Exception as exc:  # noqa: BLE001
            emit("debug", "ModelScope 文件列表获取失败：%s" % exc)
    # Fall back to probing the candidate layouts for real bytes.
    for layout in LAYOUTS:
        if _probe(model_dir, layout[0], provider):
            emit("debug", "采用文件布局：%d 个文件" % len(layout))
            return list(layout)
    return list(LAYOUTS[0])


def _extract_files(payload: Any) -> list[str]:
    """Pull relative file paths out of a ModelScope files payload."""
    out: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            path = node.get("Path") or node.get("path") or node.get("Name") or node.get("name")
            kind = node.get("Type") or node.get("type")
            if isinstance(path, str) and (kind in (None, "blob", "file") or node.get("Size")):
                if "." in path.split("/")[-1]:
                    out.append(path)
            for key in ("Files", "files", "Children", "children", "Tree", "tree", "Data", "data"):
                if key in node:
                    walk(node[key])
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    seen: list[str] = []
    for item in out:
        if item not in seen:
            seen.append(item)
    return seen


def _probe(model_dir: Path, rel: str, provider: str) -> bool:
    url = _url_for(provider, rel)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dsh-tts-speakout"})
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            data = resp.read(4096)
        return bool(data)
    except Exception:  # noqa: BLE001
        return False


def _url_for(provider: str, rel: str) -> str:
    rel = rel.lstrip("/")
    if provider == "modelscope":
        return MODELSCOPE_ENDPOINT.format(repo=MODEL_REPO) + "?Revision=master&FilePath=" + urllib.parse.quote(rel)
    return HF_ENDPOINT.format(repo=MODEL_REPO, path=rel)


def _download_files(model_dir: Path, files: list[str], provider: str, emit: Emit) -> None:
    total = len(files)
    for position, rel in enumerate(files, start=1):
        target = model_dir / rel
        if target.is_file() and target.stat().st_size > 0:
            if not rel.endswith(".safetensors") or target.stat().st_size > MIN_SAFETENSORS_BYTES:
                emit("debug", "已存在，跳过: %s" % rel)
                continue
        target.parent.mkdir(parents=True, exist_ok=True)
        emit("progress", "下载模型 %d/%d：%s" % (position, total, rel),
             {"stage": "model", "file": rel, "index": position, "total": total})
        _download_resumable(_url_for(provider, rel), target, rel, position, total, emit)


def _download_resumable(url: str, target: Path, rel: str, index: int, total: int,
                        emit: Emit) -> None:
    part = target.with_suffix(target.suffix + ".part")
    existing = part.stat().st_size if part.is_file() else 0
    headers = {"User-Agent": "dsh-tts-speakout"}
    if existing:
        headers["Range"] = "bytes=%d-" % existing

    req = urllib.request.Request(url, headers=headers)
    mode = "ab" if existing else "wb"
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            if existing and getattr(resp, "status", 200) != 206:
                existing = 0
                mode = "wb"
            length = int(resp.headers.get("Content-Length") or 0)
            done = existing
            last_report = 0.0
            with open(part, mode) as handle:
                while True:
                    chunk = resp.read(1024 * 512)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last_report > 1.0:
                        last_report = now
                        percent = int(done * 100 / (existing + length)) if length else 0
                        emit("progress",
                             "下载 %s %d%%（%d/%d）" % (rel, percent, index, total),
                             {"stage": "model", "file": rel, "percent": percent,
                              "bytes": done, "index": index, "total": total})
    except urllib.error.HTTPError as exc:
        if exc.code == 416 and existing:
            pass  # already complete
        else:
            raise
    if part.is_file():
        part.replace(target)


def main() -> int:
    """CLI: prepare the environment and the model, then print a JSON report."""
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    model_dir = Path(payload.get("modelPath") or "")

    def emit(level: str, message: str, data: dict[str, Any] | None = None) -> None:
        print(json.dumps({"level": level, "message": message, "data": data},
                         ensure_ascii=False), flush=True)

    venv_dir = Path(payload.get("venvDir") or (Path.cwd() / "venv"))
    try:
        python, report = pick_interpreter(payload.get("bundledPython"),
                                         payload.get("pythonPath"), emit, venv_dir)
        if model_dir and str(model_dir) != ".":
            ensure_model(model_dir, emit, payload.get("modelSource", "auto"))
        print(json.dumps({"ok": True, "python": python, "report": report},
                         ensure_ascii=False))
        return 0
    except BootstrapError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
