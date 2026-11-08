# Pi Atlas

A clean, responsive explorer that finds a sequence in the first **one billion
decimal digits of pi**. Search runs in a background browser worker, highlights
the exact match, and supports next occurrences, progress, cancellation, and
cached digit downloads.

## Data

The supplied `1b.txt` from `1b.zip` is the dataset's ground truth. It contains
exactly 1,000,000,000 decimal digits, excluding the integer `3` and decimal
point. Positions are one-based after the decimal point.

The source-file SHA-256 is:

```text
ef0a513ee398d5dbe1ed6994c222e03a16fcfe91f5de685691953d35961798e5
```

The repository stores the source-file hash and all 1,000 raw chunk hashes
in `site/digits/manifest.json`. During deployment, GitHub Actions downloads
the decimal stream from [MIT's pi mirror](https://stuff.mit.edu/afs/sipb/contrib/pi/pi-billion.txt),
then checks every million-digit chunk and the complete billion-digit stream
against those hashes. Publication stops if any byte differs from the supplied
dataset. The build uses bounded streaming reads and at most four concurrent
compression jobs, without constructing a billion-character JavaScript string.

The verified build emits 1,000 gzip-compressed chunks, each representing one
million digits. These generated binary files are excluded from Git source.
All runtime digit downloads come directly from GitHub Pages; no separate
server or pi mirror is used when searching. Downloads stop at the first match,
and the search worker retains at most eight uncompressed chunks in memory.
Browser storage may cache downloaded chunks for later searches.

The full dataset is about 470 MB compressed. The first full-depth search may
download that much; shorter searches usually need fewer chunks. The manifest
at `site/digits/manifest.json` records provenance, byte counts, and hashes for
every chunk.

## GitHub Pages

In the repository's **Settings → Pages**, set the publishing source to
**GitHub Actions**. The included `Deploy GitHub Pages` workflow publishes
`site/` whenever `main` changes and can also be run manually. It prepares and
verifies the dataset with Node.js 24 before uploading the static site. No npm
dependencies or application compilation are needed.

All local asset paths are relative, so both a project site such as
`https://OWNER.github.io/pi-atlas/` and a user site work.

## Run locally

Prepare the verified chunks first:

```sh
node scripts/prepare-pages.mjs
```

Complete local chunks are reused only after their raw hashes and the complete
source-file hash pass verification. Otherwise the script downloads the mirror.
The network transfer has a 30-minute timeout. It validates an exact HTTP byte
range, rejects non-digit data, and refuses truncated or oversized streams.

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
