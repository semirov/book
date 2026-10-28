/** The one request the admin commands make: JSON in, JSON out, both halves of a refusal visible. */
export async function post(target, path, token, payload) {
  const url = new URL(path, target);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { error: `admin: cannot reach ${url.origin}: ${error.cause?.code ?? error.message}` };
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, body };
}
