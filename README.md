# Rails 8 authentication: a restored backup reissues session IDs

Live demo: https://rails-auth-demo.samsonov.io

The Rails 8 `authentication` generator stores the session's integer primary
key in a signed cookie and finds the session with
`Session.find_by(id: cookies.signed[:session_id])`. The signature proves that
the number came from the app. It does not prove that it is the same session
row.

After a database restore, the session id counter goes back. A new session can
get the same id, and an old, unchanged cookie then signs in as the user of the
new session.

This demo shows it in the browser:

0. On load, Carol signs in (session 1). Then a backup is taken.
1. Alice signs in (session 2).
2. The backup is restored. Only session 1 is left, and the next id is 2 again.
3. Bob signs in and gets session 2.
4. Alice reloads. Expected: she is signed out. Actual: her unchanged cookie
   signs her in as Bob. Carol's session was in the backup and is not affected.

## How it works

- The generated authentication code is unchanged: the `Authentication`
  concern, `Session`, `Current`, `SessionsController` and the sign-in view
  are identical to `bin/rails generate authentication` output on Rails
  8.1.3.1. The app adds a `Note` model (and `has_many :notes` in `User`), a
  page that shows who you are signed in as (`WhoamiController`), seeds, and
  the wasmify configuration.
- Rails 8.1 runs on Ruby WebAssembly ([wasmify-rails](https://github.com/palkan/wasmify-rails)).
  SQLite ([sqlite-wasm](https://sqlite.org/wasm)) runs in memory. A service
  worker (`pwa/rails.sw.js`) passes requests to Rails.
- The three panels are emulated browsers. Each has its own cookie jar in the
  service worker; the real browser cookies are not used. They share one
  client IP, so the sign-in rate limit is shared.
- Carol signs in through the normal sign-in form, from the service worker,
  before the backup. The seed does not insert sessions.
- Backup is a full snapshot of the SQLite database (`sqlite3_serialize`).
  Restore stops Rails, replaces the database with the snapshot
  (`sqlite3_deserialize`), and starts Rails again. There is no WAL here.
  No row is copied, no id is assigned, no sequence is reset by hand.
- `secret_key_base` is random per service worker and the same before and
  after a restore. Only Rails creates cookies.
- The page shows the result only when Rails itself answers Alice's
  byte-identical cookie with a different user after the last restore.

## Run locally

Requirements: Ruby 3.4, Node.js, Yarn, and
[wasi-vfs](https://github.com/kateinoigakukun/wasi-vfs) on `PATH`.
wasmify-rails downloads the WASI SDK and builds Ruby for Wasm itself.

```sh
bundle install
bin/rails wasmify:build:core   # Ruby + gems to Wasm (about 6 minutes)
bin/rails wasmify:pack         # app -> pwa/public/app.wasm

cd pwa
yarn install
yarn dev                       # http://localhost:5180
```

After `wasmify:pack`, click **Reset demo** on the page to load the new
`app.wasm`.

## Deploy (GitHub Pages)

The site is static. `.github/workflows/pages.yml` builds the page on every
push to `main` and adds `app.wasm` from the `app-wasm` release (the file is
about 78 MB, so it is not kept in git). After a new `wasmify:pack`:

```sh
gh release upload app-wasm pwa/public/app.wasm --clobber
gh workflow run Pages
```

## Tested with

Ruby 3.4.8 (Wasm), Rails 8.1.3.1, SQLite 3.46.1 (sqlite-wasm), wasmify-rails
0.5.0, Chromium.
