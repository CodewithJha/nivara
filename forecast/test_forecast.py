"""Runs without TabPFN: checks feature building + recursion with a stub model. `python forecast/test_forecast.py`"""
import numpy as np
from forecast import build, forecast


class Mean:  # stub regressor: predicts the 7-day mean feature
    def fit(self, X, y): self.n = len(y)
    def predict(self, X): return X[:, 3]


series = {"A": [2] * 30, "B": [0, 4] * 15}
X, y = build(series)
assert X.shape == (2 * 23, 5) and len(y) == 46
out = forecast(series, Mean())
assert out["A"] == 14.0, out
assert 12 < out["B"] < 16, out
assert all(v >= 0 for v in forecast({"C": [0] * 30}, Mean()).values())
print("ok", out)
