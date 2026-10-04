"""TabPFN 7-day demand forecast. stdin: {"SKU": [daily qty, oldest..newest]}  stdout: {"SKU": next-7-day total}.
Any failure -> non-zero exit; the Node side then uses a labelled moving-average fallback."""
import json
import os
import sys

import numpy as np


def features(k, t, v):
    return [k, t % 7, t, float(np.mean(v[t - 7:t])), float(np.mean(v[max(0, t - 28):t]))]


def build(series):
    X, y = [], []
    for k, s in enumerate(series):
        v = series[s]
        for t in range(7, len(v)):
            X.append(features(k, t, v))
            y.append(v[t])
    return np.array(X), np.array(y, dtype=float)


def forecast(series, model):
    X, y = build(series)
    model.fit(X, y)
    ext = {s: list(map(float, v)) for s, v in series.items()}
    # ponytail: recursive 1-day-ahead x7 (7 small predict calls); direct multi-horizon model if accuracy matters
    for _ in range(7):
        rows = [features(k, len(ext[s]), ext[s]) for k, s in enumerate(ext)]
        for s, p in zip(ext, model.predict(np.array(rows))):
            ext[s].append(max(0.0, float(p)))
    return {s: round(sum(ext[s][-7:]), 1) for s in ext}


if __name__ == "__main__":
    series = json.load(sys.stdin)
    if not series or len({len(v) for v in series.values()}) != 1 or len(next(iter(series.values()))) < 21:
        sys.exit("need >=21 equal-length daily series")
    from tabpfn import TabPFNRegressor
    from tabpfn.constants import ModelVersion

    kw = dict(device=os.environ.get("TABPFN_DEVICE", "cpu"), n_estimators=int(os.environ.get("TABPFN_ESTIMATORS", "4")), ignore_pretraining_limits=True)
    # Newer TabPFN weights need a license token; v2 weights are downloadable without one.
    version = os.environ.get("TABPFN_MODEL_VERSION") or ("latest" if os.environ.get("TABPFN_TOKEN") else "v2")
    model = TabPFNRegressor(**kw) if version == "latest" else TabPFNRegressor.create_default_for_version(ModelVersion(version), **kw)
    from importlib.metadata import version as pkg_version
    print(json.dumps({"model": version, "package": f"tabpfn {pkg_version('tabpfn')}", "pred": forecast(series, model)}))
