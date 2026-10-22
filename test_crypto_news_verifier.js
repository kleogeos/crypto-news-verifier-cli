const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  matchTokens,
  classifySentiment,
  verifyAgainstMarket,
  loadLedger,
  run,
  parseFeedItems,
} = require("./crypto_news_verifier.js");

// Parity checks cross-referenced against the Python implementation
// (kleogeos/crypto-news-verifier-cli, crypto_news_verifier.py) run side by side.

const COINDESK_RSS = `<?xml version="1.0"?>
<rss><channel>
<item><title>Bitcoin surges to new record high on ETF inflow</title>
<link>https://example.com/1</link><pubDate>Thu, 22 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Ethereum hacked: exploit drains DeFi protocol</title>
<link>https://example.com/2</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0000</pubDate></item>
<item><title>Global markets await Fed rate decision this week</title>
<link>https://example.com/3</link><pubDate>Thu, 22 Oct 2026 08:00:00 +0000</pubDate></item>
</channel></rss>`;

const PRICES = JSON.stringify({
  bitcoin: { usd: 90000, usd_24h_change: 4.2 },
  ethereum: { usd: 2000, usd_24h_change: -6.1 },
});

async function fakeFetcher(url) {
  if (url.includes("coingecko")) return PRICES;
  return COINDESK_RSS;
}

function test_parse_feed_items() {
  const items = parseFeedItems(COINDESK_RSS, 10);
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].title, "Bitcoin surges to new record high on ETF inflow");
  assert.strictEqual(items[0].link, "https://example.com/1");
}

function test_sentiment_positive() {
  const [s, words] = classifySentiment("Bitcoin surges to new record high");
  assert.strictEqual(s, "positive");
  assert.ok(words.includes("surges"));
}

function test_sentiment_negative() {
  const [s] = classifySentiment("Ethereum hacked: exploit drains funds");
  assert.strictEqual(s, "negative");
}

function test_sentiment_neutral_no_keywords() {
  const [s, words] = classifySentiment("Global markets await Fed rate decision this week");
  assert.strictEqual(s, "neutral");
  assert.deepStrictEqual(words, []);
}

function test_no_false_positive_substring_ban_in_banking() {
  // regression: "ban" must not match inside "banking" (found in a live run)
  const [s, words] = classifySentiment("Tether backs fintech bringing USDT payments to banking");
  assert.strictEqual(s, "neutral");
  assert.deepStrictEqual(words, []);
}

function test_standalone_ban_word_still_matches() {
  const [s, words] = classifySentiment("EU weighs crypto ban next year");
  assert.strictEqual(s, "negative");
  assert.ok(words.includes("ban"));
}

function test_verify_confirmed_bullish() {
  const [verdict, trade, conf] = verifyAgainstMarket("positive", 4.2);
  assert.strictEqual(verdict, "confirmed");
  assert.strictEqual(trade, "BUY");
  assert.ok(conf > 0);
}

function test_verify_confirmed_bearish() {
  const [verdict, trade] = verifyAgainstMarket("negative", -6.1);
  assert.strictEqual(verdict, "confirmed");
  assert.strictEqual(trade, "SELL");
}

function test_verify_contradicted() {
  const [verdict, trade] = verifyAgainstMarket("positive", -5.0);
  assert.strictEqual(verdict, "contradicted");
  assert.strictEqual(trade, "HOLD");
}

function test_verify_unverifiable_missing_price() {
  const [verdict, trade] = verifyAgainstMarket("positive", null);
  assert.strictEqual(verdict, "unverifiable");
  assert.strictEqual(trade, "HOLD");
}

function test_verify_weak_move_stays_hold() {
  const [verdict, trade] = verifyAgainstMarket("positive", 0.3);
  assert.strictEqual(verdict, "weakly_confirmed");
  assert.strictEqual(trade, "HOLD");
}

function test_match_bitcoin() {
  const matches = matchTokens("BTC breaks $90k resistance");
  assert.ok(matches.some(([name, id]) => name === "bitcoin" && id === "bitcoin"));
}

function test_no_match() {
  assert.deepStrictEqual(matchTokens("Local bakery wins award"), []);
}

function test_no_false_positive_ada_inside_canada() {
  // regression: "ada" (cardano keyword) must not match inside "Canada"
  assert.deepStrictEqual(matchTokens("Canada regulator proposes new crypto framework"), []);
}

function test_no_false_positive_sol_inside_solution() {
  // regression: "sol" (solana keyword) must not match inside "solution"
  assert.deepStrictEqual(matchTokens("Startup ships a new payments solution"), []);
}

async function test_run_produces_entries_and_persists_ledger() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cnv-"));
  const ledgerPath = path.join(tmp, "ledger.json");
  const entries = await run("coindesk", 10, ledgerPath, fakeFetcher);
  assert.strictEqual(entries.length, 2);
  const saved = loadLedger(ledgerPath);
  assert.strictEqual(saved.length, 2);
  const btc = saved.find((e) => e.token === "bitcoin");
  assert.strictEqual(btc.verdict, "confirmed");
  assert.strictEqual(btc.practice_trade, "BUY");
  assert.strictEqual(btc.note, "paper trade only - no real funds moved");
}

async function test_rerun_does_not_duplicate_entries() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cnv-"));
  const ledgerPath = path.join(tmp, "ledger.json");
  await run("coindesk", 10, ledgerPath, fakeFetcher);
  const second = await run("coindesk", 10, ledgerPath, fakeFetcher);
  assert.deepStrictEqual(second, []);
  const saved = loadLedger(ledgerPath);
  assert.strictEqual(saved.length, 2);
}

const tests = {
  test_parse_feed_items,
  test_sentiment_positive,
  test_sentiment_negative,
  test_sentiment_neutral_no_keywords,
  test_no_false_positive_substring_ban_in_banking,
  test_standalone_ban_word_still_matches,
  test_verify_confirmed_bullish,
  test_verify_confirmed_bearish,
  test_verify_contradicted,
  test_verify_unverifiable_missing_price,
  test_verify_weak_move_stays_hold,
  test_match_bitcoin,
  test_no_match,
  test_no_false_positive_ada_inside_canada,
  test_no_false_positive_sol_inside_solution,
  test_run_produces_entries_and_persists_ledger,
  test_rerun_does_not_duplicate_entries,
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL: ${name}: ${e.message}`);
    }
  }
  console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
  process.exit(failed ? 1 : 0);
})();
