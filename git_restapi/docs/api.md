# git_restapi — API Reference

All endpoints return JSON with `Content-Type: application/json; charset=utf-8` and chunked transfer encoding. All endpoints include `Access-Control-Allow-Origin: *` and respond to CORS preflight (`OPTIONS`) with HTTP 200.

Repository names (`:repo`) in URL paths must match `[0-9a-zA-Z-_.%]+` (percent-encoding is accepted). They must correspond to a configured repository. Commit identifiers must be hexadecimal strings matching `[0-9a-fA-F]+`.

---

## GET /api/git/history/:repo

Returns the full commit history for a repository: recent commits on the development branch, commits in the main branch, local branches not yet merged, and optionally open GitHub pull requests when `url_pr` is configured.

### Query Parameters

| Parameter | Values | Description |
|---|---|---|
| `refresh` | `local`, `all` | Optional. Controls cache bypass and GitHub API usage. `local`: bypasses the in-memory history cache and re-runs `tlspuffin_history.sh`, but **reuses the cached PR data** — no GitHub API call is made. `all`: also forces a fresh fetch from the GitHub PR API (consumes rate-limit quota). Omit entirely to serve from the in-memory cache with no external calls at all. Use `local` or omit to conserve GitHub API quota; use `all` only when up-to-date PR data is required. |

Any query parameter other than `refresh` returns HTTP 400.

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
| `commits` | Commits on `dev` not yet in `main`, plus a pinned range of `main` commits. |
| `commits[].alias` | Non-empty when the commit is identical (diff-quiet) to its second parent (merge commits). |
| `standalone` | Always empty when the server uses `--no-standalone` mode (current behavior). |
| `branches` | Tip commit of each remote-tracking branch not yet merged into `main` or `dev`. |
| `PR` | Open pull requests fetched from the external GitHub API (`url_pr`). Present only when `url_pr` is configured. |
| `PR[].idPR` | GitHub internal PR id. |
| `PR[].id` | SHA of the head commit of the PR. |
| `PR[].base` | SHA of the base commit. |
| `PR[].base_ref` | Name of the target branch (e.g. `main`). |
| `PR_API_Infos` | GitHub rate-limit metadata. `apiResetTS`: Unix timestamp when the limit resets. `apiRemaining`: remaining API calls. Present only when `url_pr` is configured. |

The response is cached per-repo for **24 hours** in memory (`GitAPI::historyBuffer_`) and also persisted to `<storage>/<repo>/git_cache.json`. The on-disk cache is loaded at startup so the first request after a server restart does not require re-running the history script. Use `?refresh=local` or `?refresh=all` to explicitly bypass it (see query parameters above).

### Errors

| Code | Condition |
|---|---|
| 400 | Unknown query parameter supplied. |
| 404 | `:repo` not found in configuration. |

---

## GET /api/git/log/:repo?commit=HASH

Returns metadata for a single commit.

### Path Parameters

| Parameter | Pattern | Description |
|---|---|---|
| `:repo` | `[0-9a-zA-Z-_.]+` | Repository name as defined in configuration. |

### Query Parameters

| Parameter | Pattern | Required | Description |
|---|---|---|---|
| `commit` | `[0-9a-fA-F]+` | Yes | Commit hash (full or abbreviated). |

### Response — 200 OK

```json
{
  "commits": [
    {
      "id":      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "date":    "2024-01-15",
      "comment": "Fix foo"
    }
  ]
}
```

### Errors

| Code | Condition |
|---|---|
| 404 | `:repo` not found in configuration, or URI does not match routing pattern. |

---

## POST /api/git/logs/:repo

Returns metadata for multiple commits in a single request.

### Path Parameters

| Parameter | Pattern | Description |
|---|---|---|
| `:repo` | `[0-9a-zA-Z-_.]+` | Repository name as defined in configuration. |

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

Each commit ID must match `[0-9a-fA-F]+`. Any non-hex value causes the entire request to be rejected with HTTP 400.

### Response — 200 OK

```json
{
  "commits": [
    { "id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "date": "2024-01-15", "comment": "Fix foo" },
    { "id": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3", "date": "2024-01-14", "comment": "Add bar" }
  ]
}
```

Commits that are not found in the repository are silently omitted from the response.

### Errors

| Code | Condition |
|---|---|
| 400 | Request body is not valid JSON, `commits` field is missing, or a commit ID contains non-hex characters. |
| 404 | `:repo` not found in configuration. |

---

## OPTIONS (any path)

CORS preflight. Returns HTTP 200 with:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

No body.

---

## Routing

URL matching is performed by `RequestHandlerFactory` using three compile-time `std::regex` patterns evaluated in order:

| Pattern | Method | Handler |
|---|---|---|
| `^/api/git/history/([0-9a-zA-Z-_.%]+)(\?.*)?$` | GET | `RequestHandlerHistory` |
| `^/api/git/log/([0-9a-zA-Z-_.%]+)\?commit=([0-9a-fA-F]+)$` | GET | `RequestHandlerLog` |
| `^/api/git/logs/([0-9a-zA-Z-_.%]+)$` | POST | `RequestHandlerLogs` |
| *(anything else)* | any | `RequestHandlerError` → 404 |
