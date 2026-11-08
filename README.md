# Pi Atlas

A clean, responsive explorer that finds a sequence in the first **one billion
decimal digits of pi**. Search runs in a background browser worker, highlights
the exact match, and supports next occurrences, progress, cancellation, and
cached digit downloads.

## Data

The dataset comes directly from `1b.txt` in the supplied `1b.zip`. The file
contains exactly 1,000,000,000 decimal digits, excluding the integer `3` and
decimal point. Positions are one-based after the decimal point.

The source-file SHA-256 is:

```text
ef0a513ee398d5dbe1ed6994c222e03a16fcfe91f5de685691953d35961798e5
```

`site/digits/` contains 1,000 gzip-compressed chunks, each representing one
million digits. All digits are hosted directly by GitHub Pages; no separate
server or pi mirror is required. Downloads stop at the first match, and the
worker retains at most eight uncompressed chunks in memory. Browser storage
may cache downloaded chunks for later searches.

The full dataset is about 470 MB compressed. The first full-depth search may
download that much; shorter searches usually need fewer chunks. The manifest
at `site/digits/manifest.json` records provenance, byte counts, and hashes for
every chunk.

## GitHub Pages

In the repository's **Settings → Pages**, set the publishing source to
**GitHub Actions**. The included `Deploy GitHub Pages` workflow publishes
`site/` whenever `main` changes and can also be run manually. It requires no
dependencies or compilation.

All local asset paths are relative, so both a project site such as
`https://OWNER.github.io/pi-atlas/` and a user site work.

## Run locally

Serve `site/` with any local HTTP server, then open its local URL. An HTTP
server is needed because browser workers and module imports do not run from
a `file:` URL. A current browser with Web Workers and `DecompressionStream`
support is required.

Run verification with:

```sh
node test-pages.mjs
```

This checks project-site asset paths and dataset integrity, then exercises
the real search worker against the first and final digit chunks.
