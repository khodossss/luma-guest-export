# luma-guest-export

Download the guest list of **every event** (past and upcoming) in **every Luma calendar you manage** as CSV files, in one run.

Luma lets an event manager download guests one event at a time via **Guests → Download as CSV**. With dozens of events across several calendars, that's a lot of clicking. This tool does the same download for all of them and keeps the files up to date on re-runs.

- Files are byte-for-byte what the **Download as CSV** button gives you, under Luma's own file names.
- Works on a free Luma account. No API key or Luma Plus needed.
- You sign in yourself in a real browser window. The tool never sees your password or email codes.

## Requirements

| What | Why |
|---|---|
| Node.js **20+** | Runtime (Playwright requires Node 20) |
| Google Chrome, Microsoft Edge, **or** Playwright's Chromium | The tool opens a visible browser window for sign-in |
| A Luma account that **manages** the calendars/events | Luma only gives guest lists to managers |
| Access to that account's email | Luma asks for an email code before guest exports |
| A desktop session (not a headless server) | Sign-in and the email code are entered by a person |

Tested on Windows. macOS and Linux should work but haven't been tested.

## Install

```sh
git clone https://github.com/khodossss/luma-guest-export.git
cd luma-guest-export
npm install
```

It uses your installed Google Chrome by default. If you don't have Chrome, use `--browser msedge`, or install Playwright's Chromium:

```sh
npx playwright install chromium   # then run with --browser chromium
```

## Usage

```sh
node luma-guest-export.mjs --out ~/luma-exports
```

On first run:

1. A browser window opens. **Sign in to Luma** there. The tool waits up to 15 minutes.
2. At the first event, Luma asks you to **confirm access**: click **Send Email Code** in the window and enter the code from your email.
3. The tool goes through every calendar and event and prints `✓ <file>` for each download.
4. It finishes with a summary: calendars, events, downloaded, skipped, other organizers' events, and errors with links.

Your session is saved, so later runs skip sign-in until it expires. Luma asks for the email code again from time to time.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` | *required* | Where to save the CSVs, with one subfolder per calendar. **Keep it outside any git repo.** |
| `--calendar <name\|cal-id>` | all | Export only these calendars. Repeat for several. |
| `--force` | off | Re-download everything, ignoring what's already there. |
| `--delay <ms>` | `1500` | Pause between events. |
| `--browser <chrome\|msedge\|chromium>` | `chrome` | Which browser to open. |
| `--session <file>` | `~/.luma-guest-export/session.json` | Where the sign-in session is stored. |
| `-h, --help` | | Show help. |

Exit code is `0` on success, `1` if any event failed or the run stopped, and `2` on bad arguments.

### Output

```
<out>/
  .luma-export.json            # what was downloaded and when
  <Calendar A>/
    <Event name> - Guests - 2026-10-06-09-52-08.csv
  <Calendar B>/
    ...
```

Characters that Windows doesn't allow in file names (`< > : " / \ | ? *`) become `_`, the same way the browser renames them.

Each CSV has **all** guests of the event. The Going/Checked-in filter in Luma's UI doesn't affect the export. Use the `approval_status` column (`approved`, `invited`, `declined`, `waitlist`, `pending_approval`) and `checked_in_at` to filter.

## Re-runs

Run the same command again to update. `.luma-export.json` records each event's file and download time:

- **Skipped:** events whose file was downloaded **after the event ended**, because their guest list won't change.
- **Re-downloaded:** events that were upcoming or in progress at the last run. The new file replaces the old one. Luma puts the export time in the file name, so the name changes.

## Behavior worth knowing

- **Other organizers' events.** A calendar can list events it doesn't manage. Luma refuses their guest lists, so they're skipped and counted as "other organizers", not as errors.
- **Same event in several calendars.** It's downloaded once, into the first calendar's folder.
- **Rate limiting.** If Luma answers HTTP 429, the run stops immediately without retrying. Wait, then run again. Files already downloaded are kept.
- **Timeouts.** If sign-in or the email code isn't completed within 15 minutes, the run fails.

## How it works

The tool drives a real browser with [Playwright](https://playwright.dev) and calls Luma's dashboard API with that browser's session:

| Step | Request |
|---|---|
| Calendars | `GET api.luma.com/calendar/admin/list` |
| Events | `GET calendar/admin/get-events?period=future\|past`, paginated |
| Guests | `GET event/admin/download-guests-csv` → `{download_url, filename}` → file from S3 |

## Privacy and cleanup

- The exported CSVs contain guests' personal data (names, emails, phone numbers, registration answers). Store and share them accordingly, and never commit them.
- The session file holds your Luma login cookies in plain text. Anyone with this file can act as you on Luma until the session expires.
- To remove everything: delete `~/.luma-guest-export/` and your `--out` folder.

## License

[MIT](LICENSE)
