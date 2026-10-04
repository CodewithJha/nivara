#!/usr/bin/env python3
"""Download UCI Online Retail (CC BY 4.0) and write data/real/uci-patterns.json (stdlib only)."""
import collections, datetime as dt, json, urllib.request, zipfile, io, xml.etree.ElementTree as ET
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
OUT = Path(__file__).resolve().parents[1] / "data" / "real" / "uci-patterns.json"
URL = "https://archive.ics.uci.edu/static/public/352/online+retail.zip"

def shared_strings(z):
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("m:si", NS):
        out.append("".join(t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
    return out

def cell_val(c, shared):
    v = c.find("m:v", NS)
    if v is None: return None
    return shared[int(v.text)] if c.attrib.get("t") == "s" else v.text

def main():
    print("downloading", URL)
    data = urllib.request.urlopen(URL, timeout=120).read()
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = shared_strings(z)
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    daily = collections.defaultdict(lambda: collections.defaultdict(int))
    totals = collections.defaultdict(int)
    descs = {}
    for row in sheet.findall("m:sheetData/m:row", NS)[1:]:
        bycol = {}
        for c in row.findall("m:c", NS):
            col = "".join(ch for ch in c.attrib["r"] if ch.isalpha())
            bycol[col] = cell_val(c, shared)
        stock, desc, qty, date_s = bycol.get("B"), bycol.get("C"), bycol.get("D"), bycol.get("E")
        if not stock or not qty or not date_s: continue
        try: q = int(float(qty))
        except: continue
        if q <= 0: continue
        try:
            day = (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(date_s))).date().isoformat()
        except Exception:
            continue
        daily[stock][day] += q
        totals[stock] += q
        if desc: descs[stock] = desc
    all_dates = sorted({d for m in daily.values() for d in m})
    window = all_dates[-90:]
    top = sorted(totals.items(), key=lambda x: -x[1])[:30]
    patterns = []
    for rank, (stock, _) in enumerate(top, 1):
        series = [daily[stock].get(d, 0) for d in window]
        patterns.append({"rank": rank, "uciStockCode": stock, "description": descs.get(stock, ""), "totalQty": totals[stock], "daily": series, "mean": round(sum(series) / len(series), 3)})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "UCI Online Retail (dataset 352)",
        "license": "CC BY 4.0",
        "url": "https://archive.ics.uci.edu/dataset/352/online+retail",
        "fetchedAt": dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z"),
        "windowStart": window[0], "windowEnd": window[-1], "patterns": patterns,
    }))
    print("wrote", OUT, "patterns", len(patterns))

if __name__ == "__main__":
    main()
