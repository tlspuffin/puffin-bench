# git_restapi — API Reference

All endpoints return JSON with `Content-Type: application/json; charset=utf-8` and chunked transfer encoding. All endpoints include `Access-Control-Allow-Origin: *`, and CORS preflight (`OPTIONS`, on **any** path) is answered with HTTP 200.

Repository names (`:repo`) in URL paths must match `[0-9a-zA-Z-_.%]+` (percent-encoding is accepted). They must correspond to a configured repository, otherwise the response is HTTP 404. Commit identifiers must be hexadecimal strings matching `[0-9a-fA-F]+`.

---

## GET /api/git/history/:repo

Returns the full commit history for a repository: recent commits on the development branch, commits in a pinned range of the main branch, local (remote-tracking) branches not yet merged, and — when the repository is configured with `url_pr` — open GitHub pull requests.

### Query Parameters

| Parameter | Values | Description |
|---|---|---|
| `refresh` | `local`, `all` | Optional. Controls cache bypass and GitHub API usage. `local`: bypasses the in-memory/on-disk history cache and re-runs `tlspuffin_history.sh`, but **reuses the cached PR data** — no GitHub API call is made. `all`: also forces a fresh fetch from the GitHub PR API, unless the last known rate-limit state shows the quota already exhausted (in which case it falls back to the cache too). Omit entirely, or pass any other value, to serve from the in-memory cache with no external calls at all (equivalent to no refresh). |

Any query parameter **other than** `refresh` returns HTTP 400. An unrecognized `refresh` value (anything other than `local`/`all`) is silently treated as "no refresh" — it does not error.

Response headers on success also include `Cache-Control: no-store, no-cache, must-revalidate` and `Pragma: no-cache` (instructing HTTP caches/browsers not to cache the response — the server does its own caching internally).

### Response — 200 OK

```json
{
  "commits": [
    {
      "id":      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "date":    "2024-01-15",
      "comment": "Fix foo",
      "alias":   "",
      "branch":  "dev"
    }
  ],
  "standalone": [],
  "branches": [
    {
      "branch":  "feature/some-branch",
      "id":      "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      "date":    "2024-01-20",
      "comment": "Add feature",
      "base":    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    }
  ]
}
```

When `url_pr` is configured for the repository, two additional fields are present:

```json
{
  "PR": [
    {
      "idPR":     123,
      "number":   42,
      "state":    "open",
      "comment":  "Add feature",
      "date":     "2024-01-20",
      "id":       "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
      "branch":   "feature/some-branch",
      "base":     "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "base_ref": "main",
      "created_at": "2024-01-20T10:00:00Z",
      "updated_at": "2024-01-21T08:00:00Z"
    }
  ],
  "PR_API_Infos": {
    "apiResetTS":    1234567890,
    "apiRemaining":  42
  }
}
```

| Field | Description |
|---|---|
| `commits` | Commits on `dev` not yet in `main`, plus a pinned range of `main` commits (the range endpoints are hardcoded commit hashes inside `tlspuffin_history.sh`). |
| `commits[].alias` | Non-empty when the commit is diff-quiet identical to its second parent (merge commits). |
| `standalone` | Always empty — the server always invokes the script with `--no-standalone`. |
| `branches` | Tip commit of each remote-tracking branch not yet merged into `main` or `dev`, produced directly by `tlspuffin_history.sh` (independent of the GitHub `PR` data below). |
| `PR` | Open pull requests fetched from the external GitHub API (`url_pr`). Present only when `url_pr` is configured. |
| `PR[].idPR` | GitHub internal PR id (GitHub's `id` field, renamed to avoid clashing with the commit-sha `id` field). |
| `PR[].id` | SHA of the head commit of the PR. |
| `PR[].base` | SHA of the base commit. |
| `PR[].base_ref` | Name of the target branch (e.g. `main`). |
| `PR_API_Infos` | GitHub rate-limit metadata. `apiResetTS`: Unix timestamp when the limit resets. `apiRemaining`: remaining API calls. Present only when `url_pr` is configured. |

The response is cached per-repo for **24 hours**, both in memory (`GitAPI::historyBuffer_`) and on disk at `<storage>/<name>/git_cache.json`. The on-disk cache is loaded at startup (its age is derived from the file's mtime), so the first request after a server restart does not require re-running the history script. Use `?refresh=local` or `?refresh=all` to explicitly bypass it (see query parameters above). Pull-request data has its own independent cache (`pr_cache.json` + `pr_infos_cache.json`), described above.

### Errors

| Code | Condition |
|---|---|
| 400 | Unknown query parameter supplied. |
| 404 | `:repo` not found in configuration. |
| 500 | `tlspuffin_history.sh` failed, produced invalid JSON, or the GitHub PR fetch failed on its first page. |

---

## GET /api/git/log/:repo?commit=HASH

Returns metadata for a single commit.

### Path Parameters

| Parameter | Pattern | Description |
|---|---|---|
| `:repo` | `[0-9a-zA-Z-_.%]+` | Repository name as defined in configuration. |

### Query Parameters

| Parameter | Pattern | Required | Description |
|---|---|---|---|
| `commit` | `[0-9a-fA-F]+` | Yes | Commit hash (full or abbreviated). A URI that doesn't match this pattern doesn't route to this handler at all and falls through to 404. |

### Response — 200 OK

```json
{
  "commits": [
    {
      "id":      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "date":    "2024-01-15",
      "comment": "Fix foo",
      "base":    "9f8e7d6c5b4a3928170695847362514039281706"
    }
  ]
}
```

`base` is the merge-base of the commit with `origin/dev`; it is present only when the underlying `git merge-base` call succeeds (it is omitted for commits with no common ancestor, or on any lookup error).

### Errors

| Code | Condition |
|---|---|
| 404 | `:repo` not found in configuration, or URI does not match the routing pattern (e.g. missing/malformed `commit`). |
| 500 | The `git log`/`git merge-base` subprocess failed. |

---

## POST /api/git/logs/:repo

Returns metadata for multiple commits in a single request.

### Path Parameters

| Parameter | Pattern | Description |
|---|---|---|
| `:repo` | `[0-9a-zA-Z-_.%]+` | Repository name as defined in configuration. |

### Request Body

`Content-Type: application/json`

```json
{
  "commits": [
    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"
  ]
}
```

Each commit ID must match `[0-9a-fA-F]+`. Any non-hex value, or a `commits` field that is missing/not an array/containing a non-string element, causes the entire request to be rejected with HTTP 400. An empty `commits` array is accepted and returns `{"commits":[]}` without invoking Git at all.

### Response — 200 OK

```json
{
  "commits": [
    { "id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "date": "2024-01-15", "comment": "Fix foo", "base": "..." },
    { "id": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3", "date": "2024-01-14", "comment": "Add bar", "base": "..." }
  ]
}
```

Each entry gets its own `base` field via a separate `git merge-base <id> origin/dev` lookup (see [architecture.md](architecture.md) for the performance implication on large batches). Commits that are not found in the repository are silently omitted from the response.

### Errors

| Code | Condition |
|---|---|
| 400 | Request body is not valid JSON, `commits` field is missing/not an array/contains a non-string, or a commit ID contains non-hex characters. |
| 404 | `:repo` not found in configuration. |
| 500 | The underlying `git log` subprocess failed. |

---

## OPTIONS (any path)

CORS preflight, handled at the routing level before any path pattern is checked — matches regardless of URI. Returns HTTP 200 with:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

No body.

---

## Routing

URL matching is performed by `RequestHandlerFactory`, first on HTTP method, then (for `GET`/`POST`) on one of two compile-time `std::regex` patterns:

| Method | Pattern | Handler |
|---|---|---|
| `OPTIONS` | *(any URI)* | `RequestHandlerCORSOptions` |
| `GET` | `^/api/git/history/([0-9a-zA-Z-_.%]+)(\?.*)?$` | `RequestHandlerHistory` |
| `GET` | `^/api/git/log/([0-9a-zA-Z-_.%]+)\?commit=([0-9a-fA-F]+)$` | `RequestHandlerLog` |
| `POST` | `^/api/git/logs/([0-9a-zA-Z-_.%]+)$` | `RequestHandlerLogs` |
| `PATCH`, `PUT`, `DELETE`, or no match | — | `RequestHandlerError` → 404 |
