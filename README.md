# PodPitch CLI

The official command-line tool for [PodPitch](https://www.podpitch.com), the PR and media outreach platform. Bring your campaign results, outreach records, sent pitches, and replies into your own reports and workflows.

## Install

Requires Node.js 22 or newer.

```sh
npm install --global podpitch
podpitch --help
```

Or run without a global installation:

```sh
npx podpitch --help
```

## Connect your account

Create a PodPitch API key in [Settings > API](https://app.podpitch.com/settings/api), then run:

```sh
podpitch login
```

The prompt hides your key. Login verifies it against the API before saving it in `~/.config/podpitch/credentials.json`, readable only by your user on Unix systems. The key is stored as plaintext in that protected file. Run `podpitch logout` to remove it. Revoke a key in PodPitch settings if you need to stop it working everywhere.

For CI or scripts, set `PODPITCH_API_KEY` through your secret manager. It takes precedence over a saved login. You can also pass a key on stdin with `podpitch login --key-stdin`; avoid putting it directly in a command or shell history.

```sh
podpitch auth status
```

Authentication status shows the API origin and credential source, never the key. It does not make a validation request.

## Report on your campaigns

```sh
podpitch campaigns list
podpitch campaigns list --status Active --profile "Jane Doe"
podpitch campaigns get 123
```

List outreach records across podcasts, journalists, newsletters, people, and guests:

```sh
podpitch records list 123 --type podcast --limit 50 --offset 0
podpitch records list 123 --status booked
podpitch records list 123 --status appeared
podpitch records get 123 "ENTITY_ID"
```

The records list uses the API's existing `/campaigns/{id}/podcasts` route, which supports multiple record types. Its response retains the historical `podcasts` array name. Paginate with `--offset` and `--limit`; check `has_more` in the response. Each invocation retrieves one page.

## Read sent pitches and replies

```sh
podpitch pitches list --campaign-id 123 --limit 100 --offset 0
podpitch replies list --campaign-id 123
podpitch replies list --event-type positive_reply
podpitch replies get "MESSAGE_ID"
```

Reply filters: `reply_received`, `positive_reply`, `negative_reply`, `meeting_requested`, `needs_info`, and `out_of_office`. Event lists accept `--as-of 2026-10-21T00:00:00Z` for a stable pagination cutoff, and up to 1,000 records per page. Advance `--offset` until the returned array is shorter than the requested page size.

Sent pitches, replies, and individual record details require enabled integration access for your PodPitch account. API keys keep the same team and profile restrictions as the app. Returned fields follow PodPitch's disclosure settings. A free CLI or RapidAPI subscription does not grant a PodPitch subscription, extra account access, or free outreach credits.

## Use the JSON output

All data commands return JSON to stdout. Errors and login messages go to stderr. Failed commands exit with status 1.

```sh
podpitch campaigns list > campaigns.json
podpitch records list 123 --status booked --compact > booked-records.json
```

These files can contain private outreach and contact data. Store and share them with the same care as an export from PodPitch.

## API configuration

The default origin is `https://api.podpitch.com`. Use `--base-url` or `PODPITCH_API_URL` for another PodPitch environment. HTTPS is required except on localhost. Saved credentials are tied to the origin used at login; the CLI refuses to forward them to a different origin. HTTP redirects are rejected.

Set `PODPITCH_CONFIG_DIR` to change the credentials directory. Requests time out after 30 seconds and are not retried automatically. The package has no runtime dependencies or installation scripts.

## API and source

- [PodPitch](https://www.podpitch.com)
- [API keys and account documentation](https://app.podpitch.com/settings/api)
- [OpenAPI definition](https://github.com/PodPitch/podpitch-cli/blob/main/openapi.json)
- [Source and issues](https://github.com/PodPitch/podpitch-cli)

All data commands are read-only. This CLI does not send pitches or change campaigns.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

MIT licensed.
