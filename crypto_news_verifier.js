#!/usr/bin/env node
"use strict";

// crypto-news-verifier: checks a crypto news headline against real market data
// and records a practice (paper) trade with a repeatable reasoning trail.
//
// Zero dependencies (Node built-ins only): https for HTTP, a small regex-based
// RSS reader. No real funds move - every decision is a simulated/paper trade,
// logged to a JSON ledger so the reasoning behind each verdict can be audited.

const https = require("https");
const fs = require("fs");

const FEEDS = {
  coindesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  cointelegraph: "https://cointelegraph.com/rss",
};

const COINGECKO_HOST = "api.coingecko.com";

// ticker -> [coingeckoId, keywords matched in headlines]
const TOKENS = {
  bitcoin: ["bitcoin", ["bitcoin", "btc"]],
  ethereum: ["ethereum", ["ethereum", "eth"]],
  solana: ["solana", ["solana", "sol"]],
  ripple: ["ripple", ["xrp", "ripple"]],
  dogecoin: ["dogecoin", ["dogecoin", "doge"]],
  cardano: ["cardano", ["cardano", "ada"]],
  binancecoin: ["binancecoin", ["bnb", "binance coin"]],
  tron: ["tron", ["tron", "trx"]],
};

const POSITIVE_WORDS = [
  "surge", "surges", "surged", "rally", "rallies", "rallied", "soar", "soars",
  "soared", "adopt", "adopts", "adopted", "approve", "approves", "approved",
  "approval", "gain", "gains", "bullish", "breakout", "record high",
  "all-time high", "jump", "jumps", "rebound", "rebounds", "rebounded",
  "recover", "recovers", "recovered", "partnership", "launch", "launches",
  "launched", "upgrade", "upgrades", "upgraded", "inflow",
];
const NEGATIVE_WORDS = [
  "crash", "crashes", "crashed", "hack", "hacked", "exploit", "exploits",
  "exploited", "lawsuit", "ban", "banned", "dump", "dumps", "dumped",
  "bearish", "sell-off", "selloff", "fraud", "seize", "seized", "plunge",
  "plunges", "plunged", "collapse", "collapses", "collapsed", "outflow",
  "liquidation", "liquidated", "fine", "sanction",
];

const CONFIRM_THRESHOLD = 1.5; // % 24h move considered a "clear" move

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "crypto-news-verifier-cli/1.0" }, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
  });
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

function parseFeedItems(xml, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    items.push({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      pubDate: extractTag(block, "pubDate"),
    });
  }
  return items;
}

async function fetchFeedItems(source, limit, fetcher = fetchUrl) {
  const xml = await fetcher(FEEDS[source]);
  return parseFeedItems(xml, limit);
}

async function fetchPrices(ids, fetcher = fetchUrl) {
  if (ids.length === 0) return {};
  const uniq = Array.from(new Set(ids)).sort();
  const url = `https://${COINGECKO_HOST}/api/v3/simple/price?ids=${encodeURIComponent(
    uniq.join(",")
  )}&vs_currencies=usd&include_24hr_change=true`;
  const raw = await fetcher(url);
  return JSON.parse(raw);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordPresent(word, lowerText) {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(lowerText);
}

function matchTokens(headline) {
  const lower = headline.toLowerCase();
  const matched = [];
  for (const [name, [geckoId, keywords]] of Object.entries(TOKENS)) {
    if (keywords.some((kw) => wordPresent(kw, lower))) matched.push([name, geckoId]);
  }
  return matched;
}

function classifySentiment(headline) {
  const lower = headline.toLowerCase();
  const hitsPos = POSITIVE_WORDS.filter((w) => wordPresent(w, lower));
  const hitsNeg = NEGATIVE_WORDS.filter((w) => wordPresent(w, lower));
  if (hitsPos.length && !hitsNeg.length) return ["positive", hitsPos];
  if (hitsNeg.length && !hitsPos.length) return ["negative", hitsNeg];
  if (hitsPos.length && hitsNeg.length) return ["mixed", hitsPos.concat(hitsNeg)];
  return ["neutral", []];
}

function verifyAgainstMarket(sentiment, change24h) {
  if (change24h === null || change24h === undefined) return ["unverifiable", "HOLD", 0.0];
  const clearMove = Math.abs(change24h) >= CONFIRM_THRESHOLD;
  let verdict, trade, conf;
  if (sentiment === "positive" && change24h > 0) {
    verdict = clearMove ? "confirmed" : "weakly_confirmed";
    [trade, conf] = clearMove ? ["BUY", Math.min(0.9, 0.5 + Math.abs(change24h) / 20)] : ["HOLD", 0.3];
  } else if (sentiment === "negative" && change24h < 0) {
    verdict = clearMove ? "confirmed" : "weakly_confirmed";
    [trade, conf] = clearMove ? ["SELL", Math.min(0.9, 0.5 + Math.abs(change24h) / 20)] : ["HOLD", 0.3];
  } else if ((sentiment === "positive" || sentiment === "negative") && clearMove) {
    verdict = "contradicted";
    [trade, conf] = ["HOLD", 0.2];
  } else {
    verdict = "neutral";
    [trade, conf] = ["HOLD", 0.1];
  }
  return [verdict, trade, Math.round(conf * 100) / 100];
}

function loadLedger(path) {
  if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  return [];
}

function saveLedger(path, entries) {
  fs.writeFileSync(path, JSON.stringify(entries, null, 2));
}

function alreadyLogged(ledger, link) {
  return ledger.some((e) => e.link === link);
}

async function run(source, limit, ledgerPath, fetcher = fetchUrl) {
  const items = await fetchFeedItems(source, limit, fetcher);
  const ledger = loadLedger(ledgerPath);
  const newEntries = [];
  const allMatches = items.map((item) => [item, matchTokens(item.title)]);
  const idsNeeded = allMatches.flatMap(([, matches]) => matches.map(([, id]) => id));
  const prices = idsNeeded.length ? await fetchPrices(idsNeeded, fetcher) : {};

  for (const [item, matches] of allMatches) {
    if (alreadyLogged(ledger, item.link) || matches.length === 0) continue;
    const [sentiment, words] = classifySentiment(item.title);
    for (const [name, geckoId] of matches) {
      const priceInfo = prices[geckoId] || {};
      const change24h = priceInfo.usd_24h_change !== undefined ? priceInfo.usd_24h_change : null;
      const [verdict, trade, confidence] = verifyAgainstMarket(sentiment, change24h);
      const entry = {
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        headline: item.title,
        link: item.link,
        pub_date: item.pubDate,
        token: name,
        sentiment,
        sentiment_words: words,
        price_usd: priceInfo.usd !== undefined ? priceInfo.usd : null,
        change_24h_pct: change24h,
        verdict,
        practice_trade: trade,
        confidence,
        note: "paper trade only - no real funds moved",
      };
      ledger.push(entry);
      newEntries.push(entry);
    }
  }

  saveLedger(ledgerPath, ledger);
  return newEntries;
}

function printReport(entries) {
  if (entries.length === 0) {
    console.log("No new verifiable headlines this run.");
    return;
  }
  for (const e of entries) {
    console.log(`[${e.verdict.toUpperCase()}] ${e.headline}`);
    console.log(`  token=${e.token} sentiment=${e.sentiment} (${e.sentiment_words.join(", ") || "-"})`);
    console.log(`  price=$${e.price_usd} 24h_change=${e.change_24h_pct}%`);
    console.log(`  practice_trade=${e.practice_trade} confidence=${e.confidence}`);
    console.log(`  link=${e.link}`);
    console.log("");
  }
}

function parseArgs(argv) {
  const out = { source: "coindesk", limit: 15, ledger: "ledger.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--ledger") out.ledger = argv[++i];
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!(args.source in FEEDS)) {
    console.error(`error: unknown --source '${args.source}' (choices: ${Object.keys(FEEDS).join(", ")})`);
    return 1;
  }
  try {
    const entries = await run(args.source, args.limit, args.ledger);
    printReport(entries);
    return 0;
  } catch (exc) {
    console.error(`error: ${exc.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  matchTokens,
  classifySentiment,
  verifyAgainstMarket,
  loadLedger,
  saveLedger,
  alreadyLogged,
  run,
  parseFeedItems,
};
