#!/usr/bin/env python3
"""crypto-news-verifier: checks a crypto news headline against real market data
and records a practice (paper) trade with a repeatable reasoning trail.

Zero dependencies (stdlib only): urllib for HTTP, xml.etree for RSS parsing.
No real funds move - every decision is a simulated/paper trade, logged to a
JSON ledger so the reasoning behind each verdict can be audited later.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

FEEDS = {
    "coindesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "cointelegraph": "https://cointelegraph.com/rss",
}

COINGECKO_URL = (
    "https://api.coingecko.com/api/v3/simple/price"
    "?ids={ids}&vs_currencies=usd&include_24hr_change=true"
)

# ticker -> (coingecko id, match keywords found in headlines)
TOKENS = {
    "bitcoin": ("bitcoin", ["bitcoin", "btc"]),
    "ethereum": ("ethereum", ["ethereum", "eth"]),
    "solana": ("solana", ["solana", "sol"]),
    "ripple": ("ripple", ["xrp", "ripple"]),
    "dogecoin": ("dogecoin", ["dogecoin", "doge"]),
    "cardano": ("cardano", ["cardano", "ada"]),
    "binancecoin": ("binancecoin", ["bnb", "binance coin"]),
    "tron": ("tron", ["tron", "trx"]),
}

POSITIVE_WORDS = [
    "surge", "surges", "surged", "rally", "rallies", "rallied", "soar", "soars",
    "soared", "adopt", "adopts", "adopted", "approve", "approves", "approved",
    "approval", "gain", "gains", "bullish", "breakout", "record high",
    "all-time high", "jump", "jumps", "rebound", "rebounds", "rebounded",
    "recover", "recovers", "recovered", "partnership", "launch", "launches",
    "launched", "upgrade", "upgrades", "upgraded", "inflow",
]
NEGATIVE_WORDS = [
    "crash", "crashes", "crashed", "hack", "hacked", "exploit", "exploits",
    "exploited", "lawsuit", "ban", "banned", "dump", "dumps", "dumped",
    "bearish", "sell-off", "selloff", "fraud", "seize", "seized", "plunge",
    "plunges", "plunged", "collapse", "collapses", "collapsed", "outflow",
    "liquidation", "liquidated", "fine", "sanction",
]

CONFIRM_THRESHOLD = 1.5  # % 24h move considered a "clear" move


def fetch_url(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "crypto-news-verifier-cli/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_feed_items(source, limit, fetcher=fetch_url):
    url = FEEDS[source]
    raw = fetcher(url)
    root = ET.fromstring(raw)
    items = []
    for item in root.findall("./channel/item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        items.append({"title": title, "link": link, "pubDate": pub_date})
    return items


def fetch_prices(ids, fetcher=fetch_url):
    if not ids:
        return {}
    url = COINGECKO_URL.format(ids=",".join(sorted(set(ids))))
    raw = fetcher(url)
    return json.loads(raw)


def match_tokens(headline):
    lower = headline.lower()
    matched = []
    for name, (gecko_id, keywords) in TOKENS.items():
        if any(_word_present(kw, lower) for kw in keywords):
            matched.append((name, gecko_id))
    return matched


def _word_present(word, lower_text):
    return re.search(r"\b" + re.escape(word) + r"\b", lower_text) is not None


def classify_sentiment(headline):
    lower = headline.lower()
    hits_pos = [w for w in POSITIVE_WORDS if _word_present(w, lower)]
    hits_neg = [w for w in NEGATIVE_WORDS if _word_present(w, lower)]
    if hits_pos and not hits_neg:
        return "positive", hits_pos
    if hits_neg and not hits_pos:
        return "negative", hits_neg
    if hits_pos and hits_neg:
        return "mixed", hits_pos + hits_neg
    return "neutral", []


def verify_against_market(sentiment, change_24h):
    """Compare the headline's sentiment direction to the real 24h price move."""
    if change_24h is None:
        return "unverifiable", "HOLD", 0.0
    clear_move = abs(change_24h) >= CONFIRM_THRESHOLD
    if sentiment == "positive" and change_24h > 0:
        verdict = "confirmed" if clear_move else "weakly_confirmed"
        trade, conf = ("BUY", min(0.9, 0.5 + abs(change_24h) / 20)) if clear_move else ("HOLD", 0.3)
    elif sentiment == "negative" and change_24h < 0:
        verdict = "confirmed" if clear_move else "weakly_confirmed"
        trade, conf = ("SELL", min(0.9, 0.5 + abs(change_24h) / 20)) if clear_move else ("HOLD", 0.3)
    elif sentiment in ("positive", "negative") and clear_move:
        verdict = "contradicted"
        trade, conf = "HOLD", 0.2
    else:
        verdict = "neutral"
        trade, conf = "HOLD", 0.1
    return verdict, trade, round(conf, 2)


def load_ledger(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_ledger(path, entries):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def already_logged(ledger, link):
    return any(e["link"] == link for e in ledger)


def run(source, limit, ledger_path, fetcher=fetch_url):
    items = fetch_feed_items(source, limit, fetcher=fetcher)
    ledger = load_ledger(ledger_path)
    new_entries = []
    all_matches = []
    for item in items:
        matches = match_tokens(item["title"])
        all_matches.append((item, matches))
    ids_needed = [gecko_id for _, matches in all_matches for _, gecko_id in matches]
    prices = fetch_prices(ids_needed, fetcher=fetcher) if ids_needed else {}

    for item, matches in all_matches:
        if already_logged(ledger, item["link"]):
            continue
        if not matches:
            continue
        sentiment, words = classify_sentiment(item["title"])
        for name, gecko_id in matches:
            price_info = prices.get(gecko_id, {})
            change_24h = price_info.get("usd_24h_change")
            verdict, trade, confidence = verify_against_market(sentiment, change_24h)
            entry = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "headline": item["title"],
                "link": item["link"],
                "pub_date": item["pubDate"],
                "token": name,
                "sentiment": sentiment,
                "sentiment_words": words,
                "price_usd": price_info.get("usd"),
                "change_24h_pct": change_24h,
                "verdict": verdict,
                "practice_trade": trade,
                "confidence": confidence,
                "note": "paper trade only - no real funds moved",
            }
            ledger.append(entry)
            new_entries.append(entry)

    save_ledger(ledger_path, ledger)
    return new_entries


def print_report(entries):
    if not entries:
        print("No new verifiable headlines this run.")
        return
    for e in entries:
        print(f"[{e['verdict'].upper()}] {e['headline']}")
        print(f"  token={e['token']} sentiment={e['sentiment']} ({', '.join(e['sentiment_words']) or '-'})")
        print(f"  price=${e['price_usd']} 24h_change={e['change_24h_pct']}%")
        print(f"  practice_trade={e['practice_trade']} confidence={e['confidence']}")
        print(f"  link={e['link']}")
        print()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=sorted(FEEDS), default="coindesk")
    parser.add_argument("--limit", type=int, default=15, help="how many feed items to scan")
    parser.add_argument("--ledger", default="ledger.json", help="path to the reasoning-trail JSON ledger")
    args = parser.parse_args(argv)

    try:
        entries = run(args.source, args.limit, args.ledger)
    except Exception as exc:  # network/parsing failure - fail loudly, don't fake a result
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print_report(entries)
    return 0


if __name__ == "__main__":
    sys.exit(main())
