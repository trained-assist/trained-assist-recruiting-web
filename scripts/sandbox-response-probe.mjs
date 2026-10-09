const origin = process.env.RECRUITING_SANDBOX_PUBLIC_ORIGIN;
const vacancyId = 'vacancy_responses_demo_001';
const negotiationId = 'negotiation_demo_001';
if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/.test(origin)) {
  process.stderr.write('Set RECRUITING_SANDBOX_PUBLIC_ORIGIN to an isolated synthetic Recruiting Workers.dev origin.\n');
  process.exitCode = 64;
} else {
  const cookieFrom = (response, name) => (response.headers.get('set-cookie') ?? '')
    .match(new RegExp(`${name}=([^;,]+)`))?.[1] ?? null;
  async function connect(from) {
    const path = from === 'responses'
      ? `/auth/connected/start?from=responses&vacancy_id=${vacancyId}`
      : `/auth/connected/start?from=conversation&vacancy_id=${vacancyId}&negotiation_id=${negotiationId}`;
    const start = await fetch(`${origin}${path}`, { redirect: 'manual' });
    if (start.status !== 303) throw new Error(`response_auth_start_${start.status}`);
    const pending = cookieFrom(start, '__Host-recruiting-oauth-pending');
    if (!pending) throw new Error('response_pending_cookie_missing');
    const authorize = await fetch(start.headers.get('location'), { redirect: 'manual',
      headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` } });
    if (authorize.status !== 303) throw new Error(`response_authorize_${authorize.status}`);
    const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual',
      headers: { cookie: `__Host-recruiting-oauth-pending=${pending}` } });
    if (callback.status !== 303) throw new Error(`response_callback_${callback.status}`);
    const session = cookieFrom(callback, '__Host-recruiting-app-session');
    if (!session) throw new Error('response_session_cookie_missing');
    const cookie = `__Host-recruiting-app-session=${session}`;
    const response = await fetch(`${origin}/auth/connected/session`, { headers: { cookie } });
    if (!response.ok) throw new Error(`response_session_${response.status}`);
    const body = await response.json();
    const expected = from === 'responses' ? ['recruiting.responses.read'] :
      ['recruiting.responses.read', 'recruiting.responses.conversation.open'];
    if (!expected.every(scope => body.scopes?.includes(scope))) throw new Error('response_scope_mismatch');
    return { cookie, csrfToken: body.csrfToken };
  }
  try {
    const entry = await fetch(`${origin}/hh/responses?vacancy_id=${vacancyId}`, { redirect: 'manual' });
    if (entry.status !== 303 || !/from=responses/.test(entry.headers.get('location') ?? ''))
      throw new Error(`response_entry_${entry.status}`);
    const reader = await connect('responses');
    const list = await fetch(`${origin}/hh/responses?vacancy_id=${vacancyId}`, { headers: { cookie: reader.cookie } });
    const html = await list.text();
    if (!list.ok || !html.includes(negotiationId) || !html.includes('Кандидат Синтетический'))
      throw new Error(`response_list_${list.status}`);
    const path = `/hh/response-conversation?vacancy_id=${vacancyId}&negotiation_id=${negotiationId}`;
    const confirmation = await fetch(`${origin}${path}`, { headers: { cookie: reader.cookie } });
    if (!confirmation.ok || !(await confirmation.text()).includes('История ещё не загружена'))
      throw new Error(`response_confirmation_${confirmation.status}`);
    const denied = await fetch(`${origin}${path}`, { method: 'POST', headers: { cookie: reader.cookie,
      origin, 'x-csrf-token': reader.csrfToken } });
    if (denied.status !== 403) throw new Error(`response_scope_gate_${denied.status}`);
    const opener = await connect('conversation');
    const opened = await fetch(`${origin}${path}`, { method: 'POST', headers: { cookie: opener.cookie,
      origin, 'x-csrf-token': opener.csrfToken } });
    const body = await opened.json();
    if (!opened.ok || body.messages?.[0]?.text !== 'Синтетическое сообщение для проверки Recruiting Web.' ||
        JSON.stringify(body).includes('synthetic-hh-response-token')) throw new Error(`response_open_${opened.status}`);
    const foreign = await fetch(`${origin}/hh/response-conversation?vacancy_id=vacancy_other_demo_001&negotiation_id=${negotiationId}`, {
      method: 'POST', headers: { cookie: opener.cookie, origin, 'x-csrf-token': opener.csrfToken },
    });
    if (foreign.status !== 404) throw new Error(`response_foreign_scope_${foreign.status}`);
    process.stdout.write(JSON.stringify({ result: 'PASS', environment: 'isolated-synthetic-sandbox',
      list: list.status, confirmation: confirmation.status, readOnlyChatPost: denied.status,
      explicitConversationRead: opened.status, foreignVacancy: foreign.status }) + '\n');
  } catch (error) {
    process.stderr.write(`Synthetic response-site probe failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
