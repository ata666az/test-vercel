export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);

  if (url.pathname === '/') {
    return new Response(INDEX_HTML, {
      headers: { 'content-type': 'text/html' },
    });
  }

  if (url.pathname === '/ata') {
    return new Response('# subscription\n', {
      headers: { 'content-type': 'text/plain' },
    });
  }

  // Reverse proxy HTTP
  const target = new URL(url.pathname + url.search, 'https://origin-anda.com');
  const proxyReq = new Request(target, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
  });

  const resp = await fetch(proxyReq);
  return new Response(resp.body, {
    status: resp.status,
    headers: { ...Object.fromEntries(resp.headers), 'x-proxy-by': 'Vercel-Edge' },
  });
}

const INDEX_HTML = `<!-- tempel isi index.html -->`;
