# Competitor tracker

Watches a list of public competitor pages and tells you what actually changed
since last time. Prices, headline, meta description, and whether a page has
quietly disappeared.

No dependencies, no API keys, no account. One file of Node.

Built by [Kaella Studio](https://kaellastudio.com).

## Run it

```sh
node src/track.mjs --config sample-data/watchlist.json
```

First run records a baseline and reports everything as *first seen*. Every run
after that reports only the differences. State lives in `.state/snapshots.json`,
which is gitignored, so your watchlist stays yours.

Point it at your own list by copying `sample-data/watchlist.json` and editing
the targets.

## What it will not do

This is the part worth reading.

**It does not log in anywhere.** No session cookies, no stored credentials, no
pretending to be a signed-in customer. It fetches pages any visitor can see.

**It respects `robots.txt`.** Fetched once per host per run, cached, and honoured.
A disallowed path is reported as skipped, not quietly fetched anyway. A page
being technically reachable is not the same as being welcome.

**It identifies itself.** The user agent is
`kaellastudio-competitor-tracker/1.0` with a contact URL, not a copy-pasted
Chrome string. If someone wants it to stop, they can see who to ask.

**It waits between requests.** Two seconds by default, one request at a time.
A tracker that hammers a small shop's server gets the IP blocked, and deserves
to.

**It does not touch Instagram, Faire, or anything else behind a login.** Both
prohibit scraping in their terms, whatever a tutorial told you. If a signal
only exists behind a login, this tool does not have it, and says so by not
having it.

## Details that stop it being noise

**A body-text change is only reported when nothing more specific fired.**
Otherwise a rotating testimonial or a "12 people are viewing this" counter
means every page reports "something changed" on every run, and you stop
reading the report. The specific fields are the signal; the body hash is the
fallback.

**Prices are diffed as a set, added and removed separately**, so a new tier
reads differently from a discontinued one.

**A 404 is news, not an error to swallow.** A product page that stopped
resolving usually means a line was discontinued, which is the sort of thing
worth knowing before your client asks.

**One unreachable site does not abort the run.** It is reported and the rest
continue.

**Extraction is deliberately crude.** Regex over HTML is the wrong tool for
parsing a document and the right one for answering "did the headline change".
It is honest about being a change detector rather than a scraper.

## Limits

It reads server-rendered HTML. A storefront that renders its prices in
JavaScript after load will show as unchanged, because the price is not in the
document this fetches. Shopify and most small-brand sites are fine. A heavy
React storefront is not, and you would need a headless browser for that, which
is a different tool with different manners.

## Licence

MIT.
