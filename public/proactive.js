const params = new URLSearchParams(location.search);
const vacancyId = params.get('vacancy_id');
const statusNode = document.querySelector('#status');
const scheduleNode = document.querySelector('#schedule-status');
const candidatesNode = document.querySelector('#candidates');
const api = '/api/hh/proactive';

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
    try {
      const sessionResponse = await fetch('/auth/connected/session', { credentials: 'same-origin', cache: 'no-store' });
      if (sessionResponse.ok) {
        const session = await sessionResponse.json();
        if (/^[A-Za-z0-9_-]{43}$/.test(session.csrfToken ?? '')) headers['x-csrf-token'] = session.csrfToken;
      }
    } catch { /* Local fixture mode does not have a Connected App session. */ }
  }
  const response = await fetch(`${api}/${path}`, { credentials: 'same-origin', ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

async function refresh() {
  if (!vacancyId) {
    statusNode.textContent = 'Open this page with a vacancy_id.';
    return;
  }
  try {
    const [results, schedule] = await Promise.all([
      request(`candidates?vacancy_id=${encodeURIComponent(vacancyId)}`),
      request(`schedule?vacancy_id=${encodeURIComponent(vacancyId)}`)
    ]);
    statusNode.textContent = results.status === 'never_run'
      ? 'No search has completed for this vacancy yet.'
      : `${results.total} candidates in this vacancy · ${results.newCount} new in ${results.source} search at ${results.searchedAt}`;
    scheduleNode.textContent = schedule.schedules.length
      ? `${schedule.schedules[0].enabled ? 'Enabled' : 'Disabled'} · next ${schedule.schedules[0].nextRunAt}`
      : 'No schedule configured';
    candidatesNode.replaceChildren();
    for (const candidate of results.candidates) {
      const row = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = candidate.title;
      const details = document.createElement('span');
      details.textContent = `${candidate.isNew ? ' · NEW' : ''} · ${candidate.region} · ${candidate.evidenceSummary}`;
      row.append(heading, details);
      candidatesNode.append(row);
    }
  } catch (error) {
    statusNode.textContent = `Results unavailable: ${error.message}`;
  }
}

async function setSchedule(action) {
  if (!vacancyId) return;
  const interval = Number(document.querySelector('#interval-hours').value);
  try {
    await request('vacancy-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vacancy_id: vacancyId, action, ...(action === 'enable' ? { interval_hours: interval } : {}) })
    });
    await refresh();
  } catch (error) { scheduleNode.textContent = `Schedule unavailable: ${error.message}`; }
}

document.querySelector('#enable-schedule').addEventListener('click', () => setSchedule('enable'));
document.querySelector('#disable-schedule').addEventListener('click', () => setSchedule('disable'));
document.querySelector('#run-search').addEventListener('click', async () => {
  if (!vacancyId) return;
  statusNode.textContent = 'Searching';
  try {
    await request('search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ vacancy_id: vacancyId })
    });
    await refresh();
  } catch (error) { statusNode.textContent = `Search unavailable: ${error.message}`; }
});

refresh();
