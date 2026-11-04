# Competitor tracker

Clients often ask me "what are the other brands doing?", usually the week
after a competitor quietly dropped their prices. This tool checks a list of
competitors' public pages and tells you what changed since the last check:
prices, headlines, descriptions, and pages that have disappeared.

It's one file of Node with no dependencies, no API keys and no account.

## Running it

```sh
node src/track.mjs --config sample-data/watchlist.json
```

The first run takes a snapshot and lists every page as *first seen*. After
that, each run only reports what's different. Snapshots are saved in
`.state/snapshots.json`, which git ignores, so your watchlist stays on your
machine.

To track your own list, copy `sample-data/watchlist.json` and edit the
targets.

## How it behaves

I wanted this to be something I'd be comfortable with if I were on the other
side of it, so it's deliberately polite.

It only fetches pages anyone could open in a browser. It never logs in,
never uses cookies or saved passwords, and never pretends to be a signed-in
customer.

It reads each site's `robots.txt` once per run and follows it. A group
written for this tracker by name takes priority over the general `*` group,
`Allow` lines and wildcards are understood, and the most specific rule wins.
If `robots.txt` itself returns a server error, the whole site is skipped for
that run. Skipped pages are listed as skipped, not quietly fetched anyway.

It says who it is. The user agent is `kaellastudio-competitor-tracker/1.0`
with a contact link, not a copied Chrome string, so a site owner who wants it
to stop knows who to ask.

It goes slowly: one request at a time, two seconds apart by default. Hammering
a small shop's server is a good way to get blocked, and fair enough.

It doesn't touch Instagram, Faire, or anything else that needs a login. Both
forbid scraping in their terms. If a signal only exists behind a login, this
tool simply doesn't have it.

## Keeping the report readable

A change in the page's body text is only reported when nothing more specific
changed. Otherwise a rotating testimonial or a "12 people are viewing this"
counter would make every page look different on every run, and nobody would
read the report after the first week.

Prices are compared as a set, with additions and removals listed separately,
so a new tier reads differently from a discontinued one.

A page that starts returning 404 is reported as a change, because a product
page going missing usually means a line was discontinued. That's worth
knowing before a client asks. It's reported once, on the run where it
happens, and again if the page comes back.

One unreachable site doesn't stop the run. A server error, a refused
connection, or a site that never answers (there's a 20-second timeout) is
reported, and the rest carry on. The last good snapshot is kept, so a site
being down for an afternoon doesn't show up as a false change later. If any
page couldn't be checked, the script exits with code 1 so a scheduler can
flag it.

The extraction is crude on purpose. Pulling things out of HTML with regular
expressions is the wrong way to parse a page, but it's fine for "did the
headline change", which is all this needs to know.

## Limits

It reads the HTML the server sends. If a shop fills in its prices with
JavaScript after the page loads, those prices aren't in what this fetches,
and the page will look unchanged. Shopify and most small-brand sites are
fine. A heavy React storefront isn't, and would need a headless browser,
which is a different tool with different manners.

## Licence

MIT.
