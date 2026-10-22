# crypto-news-verifier-cli

Checks crypto news headlines against real market data (CoinGecko) and records
a **practice (paper) trade** with a repeatable reasoning trail. No real funds
ever move — every decision is simulated and logged to a JSON ledger so the
evidence behind each verdict can be audited.

Zero dependencies — Python standard library only (`urllib`, `xml.etree`), plus
a matching Node.js port (`crypto_news_verifier.js`, built-ins only: `https`, `fs`).

## What it does

1. Pulls recent headlines from a public crypto news RSS feed (CoinDesk or
   Cointelegraph, no API key needed).
2. Matches headlines to tokens (BTC, ETH, SOL, XRP, DOGE, ADA, BNB, TRX) via
   keyword matching.
3. Classifies each headline's sentiment with a transparent keyword rule set
   (no black-box model — every word that triggered the verdict is logged).
4. Fetches the token's real 24h price change from CoinGecko's free public API.
5. Compares sentiment direction against the actual price move:
   - **confirmed** — sentiment and price move agree, and the move is clear
   - **contradicted** — sentiment and price move disagree
   - **weakly_confirmed** / **neutral** — agreement but the move is small, or
     no sentiment signal at all
6. Records a `BUY` / `SELL` / `HOLD` practice trade with a confidence score,
   and appends the full evidence (headline, link, price, change%, words
   matched) to a JSON ledger. Re-running never logs the same headline twice.

```bash
python3 crypto_news_verifier.py --source coindesk --limit 20 --ledger ledger.json
# or, same behavior, Node:
node crypto_news_verifier.js --source coindesk --limit 20 --ledger ledger.json
# or straight from GitHub, no clone:
npx github:kleogeos/crypto-news-verifier-cli --source coindesk --limit 20
```

Example output:

```
[CONFIRMED] Bitcoin surges to new record high on ETF inflow
  token=bitcoin sentiment=positive (surge)
  price=$90000 24h_change=4.2%
  practice_trade=BUY confidence=0.71
  link=https://example.com/...
```

## Why

Built for the ["Autonomous Agents" bounty](https://dorahacks.io/hackathon/bounty/1380)
at BLI Legal Tech Hackathon 2 — an agent that interprets market evidence and
keeps a repeatable reasoning trail for the practice trades it would make, in
the "News Checker" direction (verify a story, connect it to market evidence,
explain its crypto impact).

It's also a free companion to the other
[freelance/crypto CLI tools](https://github.com/kleogeos) in this portfolio —
same zero-deps philosophy.

## More free tools

Also need invoices, proposals, contracts, or a crypto↔RUB calculator? See the
[Freelancer Starter Kit](https://kleogeos.github.io/freelancer-tools/kit.html?src=cli-cryptonewsverifier-js)
or the full [Freelancer Toolbox](https://kleogeos.github.io/freelancer-tools/donate.html?src=cli-cryptonewsverifier-js) —
free and will stay free.

## Honesty notes

- This is a decision-support/educational tool, not investment advice. No real
  money is traded.
- Sentiment classification is a transparent keyword rule set, not an ML
  model — it will miss nuance, which is why the matched words are always
  logged alongside the verdict. Matching uses word boundaries (not raw
  substring search) so e.g. "ban" doesn't fire on "bank**ing**" or "ada"
  (Cardano) on "Can**ada**" — a false positive caught by running the tool
  against a live feed, now covered by regression tests in both ports.
- Price data comes from CoinGecko's free public endpoint and can occasionally
  be delayed or rate-limited.

## License

MIT
