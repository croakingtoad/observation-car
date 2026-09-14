# Fixture: book-92-cover.jpg

LIVE CAPTURE (LOCO-101, 2026-09-12 UTC): verbatim cover image for book 92,
fetched from a real Booklore instance (the requester's self-hosted library).
The cover endpoint returns 401 unauthenticated, so this came from an
authenticated OPDS Basic Auth fetch.

Request: GET `/api/v1/opds/92/cover?2026-09-09T16:58:31Z` — 250x350 JPEG,
8.5 KB. The instance host (a tailnet address) was substituted with
`booklore.example` for this commit; the image carries no host string. The
book title/author come from the requester's own private library.
