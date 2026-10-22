import json
import os
import tempfile
import unittest

import crypto_news_verifier as cnv

COINDESK_RSS = """<?xml version="1.0"?>
<rss><channel>
<item><title>Bitcoin surges to new record high on ETF inflow</title>
<link>https://example.com/1</link><pubDate>Thu, 22 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Ethereum hacked: exploit drains DeFi protocol</title>
<link>https://example.com/2</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0000</pubDate></item>
<item><title>Global markets await Fed rate decision this week</title>
<link>https://example.com/3</link><pubDate>Thu, 22 Oct 2026 08:00:00 +0000</pubDate></item>
</channel></rss>"""

PRICES = json.dumps({
    "bitcoin": {"usd": 90000, "usd_24h_change": 4.2},
    "ethereum": {"usd": 2000, "usd_24h_change": -6.1},
}).encode()


def fake_fetcher(url):
    if "coingecko" in url:
        return PRICES
    return COINDESK_RSS.encode()


class TestSentiment(unittest.TestCase):
    def test_positive(self):
        s, words = cnv.classify_sentiment("Bitcoin surges to new record high")
        self.assertEqual(s, "positive")
        self.assertIn("surges", words)

    def test_negative(self):
        s, words = cnv.classify_sentiment("Ethereum hacked: exploit drains funds")
        self.assertEqual(s, "negative")
        self.assertIn("hack", words[0] or "hacked")

    def test_neutral_no_keywords(self):
        s, words = cnv.classify_sentiment("Global markets await Fed rate decision this week")
        self.assertEqual(s, "neutral")
        self.assertEqual(words, [])

    def test_no_false_positive_substring_ban_in_banking(self):
        # regression: "ban" must not match inside "banking" (found in a live run)
        s, words = cnv.classify_sentiment("Tether backs fintech bringing USDT payments to banking")
        self.assertEqual(s, "neutral")
        self.assertEqual(words, [])

    def test_standalone_ban_word_still_matches(self):
        s, words = cnv.classify_sentiment("EU weighs crypto ban next year")
        self.assertEqual(s, "negative")
        self.assertIn("ban", words)


class TestVerifyAgainstMarket(unittest.TestCase):
    def test_confirmed_bullish(self):
        verdict, trade, conf = cnv.verify_against_market("positive", 4.2)
        self.assertEqual(verdict, "confirmed")
        self.assertEqual(trade, "BUY")
        self.assertGreater(conf, 0)

    def test_confirmed_bearish(self):
        verdict, trade, conf = cnv.verify_against_market("negative", -6.1)
        self.assertEqual(verdict, "confirmed")
        self.assertEqual(trade, "SELL")

    def test_contradicted(self):
        verdict, trade, conf = cnv.verify_against_market("positive", -5.0)
        self.assertEqual(verdict, "contradicted")
        self.assertEqual(trade, "HOLD")

    def test_unverifiable_missing_price(self):
        verdict, trade, conf = cnv.verify_against_market("positive", None)
        self.assertEqual(verdict, "unverifiable")
        self.assertEqual(trade, "HOLD")

    def test_weak_move_stays_hold(self):
        verdict, trade, conf = cnv.verify_against_market("positive", 0.3)
        self.assertEqual(verdict, "weakly_confirmed")
        self.assertEqual(trade, "HOLD")


class TestMatchTokens(unittest.TestCase):
    def test_matches_bitcoin(self):
        matches = cnv.match_tokens("BTC breaks $90k resistance")
        self.assertIn(("bitcoin", "bitcoin"), matches)

    def test_no_match(self):
        matches = cnv.match_tokens("Local bakery wins award")
        self.assertEqual(matches, [])

    def test_no_false_positive_ada_inside_canada(self):
        # regression: "ada" (cardano keyword) must not match inside "Canada"
        matches = cnv.match_tokens("Canada regulator proposes new crypto framework")
        self.assertEqual(matches, [])

    def test_no_false_positive_sol_inside_solution(self):
        # regression: "sol" (solana keyword) must not match inside "solution"
        matches = cnv.match_tokens("Startup ships a new payments solution")
        self.assertEqual(matches, [])


class TestRunAndLedger(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger_path = os.path.join(self.tmpdir, "ledger.json")

    def test_run_produces_entries_and_persists_ledger(self):
        entries = cnv.run("coindesk", 10, self.ledger_path, fetcher=fake_fetcher)
        # bitcoin headline + ethereum headline match tokens; dogecoin headline has no keyword hit
        self.assertEqual(len(entries), 2)
        saved = cnv.load_ledger(self.ledger_path)
        self.assertEqual(len(saved), 2)
        btc_entry = next(e for e in saved if e["token"] == "bitcoin")
        self.assertEqual(btc_entry["verdict"], "confirmed")
        self.assertEqual(btc_entry["practice_trade"], "BUY")
        self.assertEqual(btc_entry["note"], "paper trade only - no real funds moved")

    def test_rerun_does_not_duplicate_entries(self):
        cnv.run("coindesk", 10, self.ledger_path, fetcher=fake_fetcher)
        second_run_new = cnv.run("coindesk", 10, self.ledger_path, fetcher=fake_fetcher)
        self.assertEqual(second_run_new, [])
        saved = cnv.load_ledger(self.ledger_path)
        self.assertEqual(len(saved), 2)  # still 2, not 4

    def test_ledger_survives_as_valid_json_across_runs(self):
        cnv.run("coindesk", 10, self.ledger_path, fetcher=fake_fetcher)
        with open(self.ledger_path, encoding="utf-8") as f:
            data = json.load(f)  # raises if corrupted
        self.assertIsInstance(data, list)


if __name__ == "__main__":
    unittest.main()
