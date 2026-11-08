import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // data/content.json and data/site.json are read at runtime from a path
  // built on process.cwd(). json-store.ts spells the "data" subfolder out as
  // a literal so the trace scopes itself to data/**; these entries are the
  // explicit safety net, so a refactor of that path cannot silently drop the
  // stores from a standalone build and fail every route with ENOENT.
  //
  // Every route here reads a store, so each one needs an entry. "/" is the
  // landing page, which reads site.json via getLanding(); the auth pages read
  // the brand from it. Note picomatch's "*" does not cross slashes, so a
  // single "/*" would not cover "/watch/[id]".
  outputFileTracingIncludes: {
    "/": ["./data/**"],
    "/signin": ["./data/**"],
    "/signup": ["./data/**"],
    "/watch": ["./data/**"],
    "/watch/[id]": ["./data/**"],
    "/browse/[section]": ["./data/**"],
    "/api/**": ["./data/**"],
  },
  // In development: no page, image or video on this site is indexed. There is
  // deliberately no robots.txt Disallow, because a crawler that may not fetch
  // a page never sees its noindex.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
