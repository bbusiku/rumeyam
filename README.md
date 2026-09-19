<img width="660" height="579" alt="Image" src="https://github.com/user-attachments/assets/ea153392-3356-4f10-84d8-2ddce0c6508f" />

## Automatic playlist updates

GitHub Actions refreshes the three public YouTube playlists every hour and publishes the player to GitHub Pages. Temporary network errors, HTTP 408/429/5xx responses, and unreadable playlist data are retried up to three times with a short backoff.

Scheduled runs publish only when all playlists refresh successfully. If a playlist is still unavailable, the run records a warning and skips publication, leaving the current site and catalog untouched until the next hourly attempt. It never replaces the deployed catalog with older checkout seeds after a failed scheduled refresh. Other build and deployment errors still fail the workflow normally.

Use `node scripts/sync-collections.mjs --strict` to require a complete refresh with a nonzero exit code on failure, or `--scheduled` to use the safe skip behavior. Without either option, the script preserves last-good categories on partial failures. The Actions refresh step exposes `publish=true` or `publish=false` through `GITHUB_OUTPUT`.
