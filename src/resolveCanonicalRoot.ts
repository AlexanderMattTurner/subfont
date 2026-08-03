// Resolve the `canonicalRoot` handed to AssetGraph from the (possibly
// derived) crawl root and any caller-supplied value.
//
// Non-file roots (crawling a live http(s) URL) need an explicit
// trailing-slash canonicalRoot so relative-URL resolution lines up with how
// the deployed site reads. The previous inline logic derived that value and
// then *unconditionally* used it for URL roots, silently discarding a
// caller-supplied `canonicalRoot`. That defeats the entire purpose of
// `--canonical-root` / the `canonicalRoot` option, whose job is to rewrite
// URLs to a deploy origin that differs from the crawl origin (e.g. crawl
// `http://localhost:8000/` but deploy to `https://example.com/`).
//
// Precedence:
//   1. An explicit `canonicalRoot` always wins.
//   2. Otherwise, a non-file root falls back to its trailing-slash form.
//   3. Otherwise (file: root with no explicit value) there is no canonicalRoot.
export function resolveCanonicalRoot(
  rootUrl: string | undefined,
  canonicalRoot: string | undefined
): string | undefined {
  if (canonicalRoot) {
    return canonicalRoot;
  }
  if (rootUrl && !rootUrl.startsWith('file:')) {
    return rootUrl.replace(/\/?$/, '/');
  }
  return undefined;
}
