#!/usr/bin/env python3
"""resource_extract — pull an app's REAL icon resources into a flat {key: bytes} pool.

The /replicate-ui rule: icons must be the app's own resource files, never screenshots.
Different app frameworks store them differently, so this module dispatches by kind and
returns a uniform pool that `icon_match` can rasterise + score:

  - qt       Qt `.rcc` resource bundles (WPS, many cross-platform apps). Parsed here.
  - appkit   compiled `Assets.car` (Office/Finder/Apple apps) via native_icons.py.
  - electron inline DOM SVGs already harvested by extract_assets -> assets/manifest.json.
  - loose    plain *.svg/*.png/*.icns under Contents/Resources.

Pure stdlib (struct/zlib/glob/os) + the existing native_icons helpers. No third-party deps.
"""
import os, struct, zlib, glob, json, sys, hashlib


def _warn(msg):
    """Extraction failures must be VISIBLE: a silently shrunken pool degrades
    icon matching with no clue why (the old bare `except: pass` did exactly that)."""
    print(f"resource_extract WARNING: {msg}", file=sys.stderr)


# ---------------------------------------------------------------- Qt .rcc (qres)
def parse_rcc(path):
    """Walk a Qt `qres` v1/v2 binary resource bundle -> {resource_path: raw_bytes}.

    Format: magic b'qres'; u32 version, tree_off, data_off, name_off. Tree nodes are
    fixed-size (14 bytes v1, +8 byte mtime for v2). dir node = name_off u32, flags u16
    (1=zlib,2=dir), child_count u32, child_idx u32. file node = name_off u32, flags u16,
    territory u16, language u16, data_off u32 (+mtime u64 on v2). Names: [u16 len]
    [u32 hash][utf-16BE chars]. Data: [u32 len][bytes], zlib via decompress(b[4:]) iff flag&1.
    """
    d = open(path, "rb").read()
    if d[:4] != b"qres":
        return {}
    ver, tree_off, data_off, name_off = struct.unpack(">IIII", d[4:20])
    node = 14 + (8 if ver >= 2 else 0)
    def name_at(o):
        ln = struct.unpack(">H", d[name_off + o:name_off + o + 2])[0]
        return d[name_off + o + 6:name_off + o + 6 + ln * 2].decode("utf-16-be", "replace")
    def data_at(o):
        ln = struct.unpack(">I", d[data_off + o:data_off + o + 4])[0]
        return d[data_off + o + 4:data_off + o + 4 + ln]
    out = {}
    def walk(idx, prefix):
        b = tree_off + idx * node
        no = struct.unpack(">I", d[b:b + 4])[0]
        fl = struct.unpack(">H", d[b + 4:b + 6])[0]
        p = prefix + ("" if idx == 0 else "/" + name_at(no))
        if fl & 2:                                   # directory
            cc, co = struct.unpack(">II", d[b + 6:b + 14])
            for k in range(cc):
                walk(co + k, p)
        else:                                        # file
            o = struct.unpack(">I", d[b + 10:b + 14])[0]
            raw = data_at(o)
            out[p] = zlib.decompress(raw[4:]) if (fl & 1) else raw
    walk(0, "")
    return out


def _pool_qt(app_path, active_skin=None):
    """Merge every .rcc under the bundle. Active-skin bundle wins on key collision so the
    pool reflects the THEME the user is actually running."""
    base = app_path if app_path.endswith("Contents") else os.path.join(app_path, "Contents")
    rccs = glob.glob(os.path.join(base, "Resources", "**", "*.rcc"), recursive=True)
    # parse non-skin first, then skin (so skin overrides) — skin dirs contain "/skins/"
    rccs.sort(key=lambda p: ("/skins/" in p, os.path.getsize(p)))
    pool = {}
    for r in rccs:
        try:
            for k, v in parse_rcc(r).items():
                if k.endswith((".svg", ".png")):
                    pool[k] = v          # later (skin/bigger) wins
        except Exception as e:
            _warn(f"failed to parse {r}: {e}")
    return pool


def _pool_loose(app_path):
    base = app_path if app_path.endswith("Contents") else os.path.join(app_path, "Contents")
    pool = {}
    for ext in ("svg", "png"):
        for f in glob.glob(os.path.join(base, "Resources", "**", "*." + ext), recursive=True):
            pool["/" + os.path.relpath(f, base)] = open(f, "rb").read()
    return pool


def _pool_electron(out_dir):
    """svgIcons[] harvested by extract_assets -> assets/manifest.json + assets/icons/<name>.svg."""
    man = os.path.join(out_dir, "assets", "manifest.json")
    pool = {}
    if os.path.exists(man):
        m = json.load(open(man))
        for ic in m.get("svgIcons", []):
            p = os.path.join(out_dir, "assets", "icons", ic.get("name", "") + ".svg")
            if os.path.exists(p):
                pool["/" + ic["name"] + ".svg"] = open(p, "rb").read()
    return pool


def _detect_kind(app_path):
    base = app_path if app_path.endswith("Contents") else os.path.join(app_path, "Contents")
    if glob.glob(os.path.join(base, "Resources", "**", "*.rcc"), recursive=True):
        return "qt"
    if glob.glob(os.path.join(base, "Resources", "**", "Assets.car"), recursive=True):
        return "appkit"
    return "loose"


def extract_pool(app_path, kind=None, out_dir=None, cache_dir=None):
    """Flat {resource_key: bytes} of ALL candidate icons for the app.

    `kind` auto-detected from the bundle unless forced. `out_dir` is the replica working
    dir (needed for electron's harvested manifest). Keys are the resource path (qt/loose)
    or `/<name>.svg` (electron) — unique; use `basename()` to map a name-prior to candidates.

    `cache_dir` (e.g. "pool"): persist the extracted pool there, keyed by an app
    fingerprint (bundle path + version + resource mtimes). On pages 2+ of the
    SAME app the extraction — the slowest harvest step — is skipped entirely
    when the fingerprint still matches; any change to the app bundle invalidates
    the cache and re-extracts. Safe by construction: the pool comes from the app
    BUNDLE, never from a previous page's screenshots. Electron pools are always
    harvested fresh (their icons come from the live DOM, not the bundle).
    """
    kind = kind or _detect_kind(app_path)
    if kind == "electron":
        return _pool_electron(out_dir or ".")
    if cache_dir:
        cached = cached_pool(app_path, cache_dir)
        if cached is not None:
            print(f"resource_extract: pool cache HIT ({len(cached)} icons; bundle unchanged) — "
                  f"skipping re-extraction", file=sys.stderr)
            return cached
    if kind == "qt":
        pool = _pool_qt(app_path)
    elif kind == "appkit":
        pool = _pool_appkit(app_path)
    else:
        pool = _pool_loose(app_path)
    if cache_dir and pool:
        save_pool(pool, app_path, cache_dir)
    return pool


# ---------------------------------------------------------------- pool cache (pages 2+)
def fingerprint_app(app_path):
    """Validity key for a cached pool: bundle path + CFBundleShortVersionString +
    newest mtime over Info.plist / *.rcc / Assets.car. Cheap (a handful of stats),
    and any app update or theme-bundle swap changes it."""
    base = app_path if app_path.endswith("Contents") else os.path.join(app_path, "Contents")
    info = os.path.join(base, "Info.plist")
    version = None
    try:
        import plistlib
        with open(info, "rb") as f:
            version = plistlib.load(f).get("CFBundleShortVersionString")
    except Exception:
        pass
    newest = 0.0
    paths = [info]
    for pat in ("*.rcc", "Assets.car"):
        paths += glob.glob(os.path.join(base, "Resources", "**", pat), recursive=True)
    for p in paths:
        try:
            newest = max(newest, os.path.getmtime(p))
        except OSError:
            pass
    return {"app": os.path.abspath(app_path), "version": version, "newest_mtime": round(newest, 3)}


def save_pool(pool, app_path, cache_dir):
    """Persist {key: bytes} under `cache_dir`, content-addressed, with a manifest
    recording the app fingerprint that makes the cache valid."""
    os.makedirs(cache_dir, exist_ok=True)
    files = {}
    for key, data in pool.items():
        ext = os.path.splitext(key)[1] or ".bin"
        rel = hashlib.sha1(data).hexdigest()[:16] + ext
        p = os.path.join(cache_dir, rel)
        if not os.path.exists(p):
            with open(p, "wb") as f:
                f.write(data)
        files[key] = rel
    with open(os.path.join(cache_dir, "manifest.json"), "w") as f:
        json.dump({"fingerprint": fingerprint_app(app_path), "files": files}, f, indent=1)


def cached_pool(app_path, cache_dir):
    """Load the pool persisted by `save_pool` — only if the app fingerprint still
    matches AND every file is present. Anything off → None (full re-extract);
    correctness is never traded for the cache hit."""
    man = os.path.join(cache_dir, "manifest.json")
    if not os.path.exists(man):
        return None
    try:
        m = json.load(open(man))
    except Exception:
        return None
    if m.get("fingerprint") != fingerprint_app(app_path):
        return None
    pool = {}
    for key, rel in m.get("files", {}).items():
        p = os.path.join(cache_dir, rel)
        if not os.path.exists(p):
            return None
        pool[key] = open(p, "rb").read()
    return pool or None


def _pool_appkit(app_path):
    """Assets.car via the existing native_icons CoreUI extractor -> {base_name: png_bytes}."""
    import native_icons as ni
    pool = {}
    cars = ni.find_catalogs(app_path)
    if not cars:
        _warn(f"no Assets.car found under {app_path}")
    for car in cars:
        outdir = os.path.join(os.path.dirname(car), "_carpool")
        if not os.access(os.path.dirname(car), os.W_OK):
            # System apps / read-only bundles: extract into a user cache instead
            # of silently losing the ENTIRE AppKit pool to a permission error.
            tag = hashlib.sha1(car.encode()).hexdigest()[:12]
            outdir = os.path.join(os.path.expanduser("~/.cache/vibe-extract/carpool"), tag)
        try:
            ni.build_pool(car, outdir)
            n = 0
            for base, png in ni.load_pool(outdir, "normal_dark").items():
                if os.path.exists(png):
                    pool["/" + base + ".png"] = open(png, "rb").read()
                    n += 1
            if n == 0:
                _warn(f"{car}: extractor produced no usable icons")
        except Exception as e:
            _warn(f"failed to extract {car}: {e}")
    return pool


# ---------------------------------------------------------------- helpers
def basename(key):
    """Resource key -> bare icon name (the token a name-prior / .kui icon= refers to)."""
    return os.path.splitext(os.path.basename(key))[0]


def index_by_basename(pool):
    idx = {}
    for k in pool:
        idx.setdefault(basename(k), []).append(k)
    return idx


if __name__ == "__main__":
    import sys
    p = extract_pool(sys.argv[1] if len(sys.argv) > 1 else "/Applications/wpsoffice.app")
    print("pool size:", len(p))
    bn = index_by_basename(p)
    print("unique basenames:", len(bn))
    for probe in ("brush_kd", "group_kd", "level_bring_forward_kd", "play_kd"):
        print(" ", probe, "->", bn.get(probe))
