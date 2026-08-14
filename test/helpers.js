'use strict';

function jsonResponse(data, { status = 200, headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    json: async () => data,
  };
}

/*
 * makeFetch([[match, response], ...]) -> fetchImpl with a `calls` array.
 * `match` is a substring of the URL or a predicate. `response` is a
 * jsonResponse() object, a function (url) => response, or plain data.
 */
function makeFetch(routes) {
  const fetchImpl = async (url) => {
    fetchImpl.calls.push(url);
    for (const [match, response] of routes) {
      const hit = typeof match === 'function' ? match(url) : url.includes(match);
      if (!hit) continue;
      const res = typeof response === 'function' ? response(url) : response;
      return res && typeof res.json === 'function' ? res : jsonResponse(res);
    }
    throw new Error(`No fixture route for ${url}`);
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

function loadFixture(name) {
  return require(`./fixtures/${name}.json`);
}

module.exports = { jsonResponse, makeFetch, loadFixture };
