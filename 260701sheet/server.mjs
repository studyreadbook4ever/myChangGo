import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, pathname));

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, () => {
  console.log(`Ontology Sheet Editor: http://localhost:${port}`);
});
