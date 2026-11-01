// SPDX-License-Identifier: MIT
//
// The registry side of the publish check: an HTTP server on the loopback
// interface that answers what `pnpm publish` asks and keeps the tarball it
// uploads.
//
//   node fake-registry.mjs PORT_FILE TARBALL_FILE [PORT]
//
// It listens on PORT (any free port without it), writes its port to
// PORT_FILE once it listens, and writes the tarball of the first publish
// to TARBALL_FILE. It knows no packages, so every package read is a 404,
// as for a package that was never published.
import fs from "node:fs";
import http from "node:http";

const [portFile, tarballFile, port = "0"] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "PUT") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const [attachment] = Object.values(body._attachments ?? {});
      if (attachment && !fs.existsSync(tarballFile)) {
        fs.writeFileSync(tarballFile, Buffer.from(attachment.data, "base64"));
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url.startsWith("/-/whoami")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ username: "check" }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
});

server.listen(Number(port), "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
